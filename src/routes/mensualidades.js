const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyToken = require('../middleware/auth');

router.use(verifyToken);

const DUE_STATUSES = ['vencido', 'proximo', 'al_dia', 'inactivo'];

function computeDueInfo(row) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fechaInicio = row.fecha_inicio ? new Date(row.fecha_inicio) : null;
    const fechaFin = row.fecha_fin ? new Date(row.fecha_fin) : null;
    const lastPaidUntil = row.last_paid_until ? new Date(row.last_paid_until) : null;

    let nextStart = fechaInicio ? new Date(fechaInicio) : null;
    if (lastPaidUntil) {
        const ns = new Date(lastPaidUntil);
        ns.setDate(ns.getDate() + 1);
        nextStart = ns;
    }

    let overduePayments = 0;
    let dueStatus = 'al_dia';
    let nextPaymentDate = nextStart ? nextStart.toISOString().slice(0, 10) : null;
    let daysToNext = null;

    const isInactive = (row.estado === 'cancelada') || (fechaFin && today > fechaFin);
    if (isInactive || !nextStart) {
        dueStatus = 'inactivo';
    } else {
        const compareDate = new Date(nextStart);
        compareDate.setHours(0, 0, 0, 0);
        if (today >= compareDate) {
            const monthsDiff = (b, a) => {
                let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
                if (b.getDate() >= a.getDate()) m += 1;
                return m;
            };
            overduePayments = Math.max(1, monthsDiff(today, compareDate));
            dueStatus = 'vencido';
        } else {
            const msPerDay = 86400000;
            daysToNext = Math.ceil((compareDate - today) / msPerDay);
            dueStatus = daysToNext <= 5 ? 'proximo' : 'al_dia';
        }
    }

    return {
        ...row,
        next_payment_date: nextPaymentDate,
        overdue_payments: overduePayments,
        due_status: dueStatus,
        days_to_next: daysToNext
    };
}

const LIST_SELECT = `
    SELECT m.*, v.placa, tv.nombre AS tipo, tv.codigo AS tipo_codigo, v.id_tipo, p.last_paid_until
    FROM mensualidades m
    LEFT JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
    LEFT JOIN tipos_vehiculos tv ON tv.id_tipo = v.id_tipo
    LEFT JOIN (
        SELECT id_mensualidad, MAX(periodo_hasta) AS last_paid_until
        FROM mensualidades_pagos
        WHERE id_empresa = ?
        GROUP BY id_mensualidad
    ) p ON p.id_mensualidad = m.id_mensualidad`;

// Listar mensualidades con estado, placa/referencia y titular (paginado)
router.get('/', async (req, res) => {
    try {
        const { q = '', estado = '', tab = '', due = '', page = 1, pageSize = 20 } = req.query;
        const idEmpresa = req.user.id_empresa;
        const limit = Math.min(parseInt(pageSize) || 20, 100);
        const offset = Math.max(((parseInt(page) || 1) - 1) * limit, 0);
        const dueFilter = String(due).split(',').map(s => s.trim()).filter(s => DUE_STATUSES.includes(s));

        const where = ['m.id_empresa = ?'];
        const params = [idEmpresa];
        if (tab === 'activos') {
            where.push("m.estado != 'cancelada'");
        } else if (estado) {
            where.push('m.estado = ?'); params.push(estado);
        }
        if (q) {
            where.push('(v.placa LIKE ? OR m.referencia_espacio LIKE ? OR m.titular_nombre LIKE ? OR m.titular_documento LIKE ?)');
            params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
        }

        const whereClause = where.join(' AND ');

        // Pestaña activos: calcular due_status en memoria para filtros y contadores
        if (tab === 'activos') {
            const [rows] = await pool.query(
                `${LIST_SELECT} WHERE ${whereClause} ORDER BY m.fecha_creacion DESC`,
                [idEmpresa, ...params]
            );
            const computed = rows.map(computeDueInfo);
            const counts = { all: computed.length, vencido: 0, proximo: 0, al_dia: 0, inactivo: 0 };
            computed.forEach(r => { counts[r.due_status] = (counts[r.due_status] || 0) + 1; });

            const filtered = dueFilter.length
                ? computed.filter(r => dueFilter.includes(r.due_status))
                : computed;
            const pageData = filtered.slice(offset, offset + limit);

            return res.json({ success: true, data: pageData, total: filtered.length, counts });
        }

        // Pestaña desactivados u otros: paginación SQL directa
        const [rows] = await pool.query(
            `${LIST_SELECT} WHERE ${whereClause} ORDER BY m.fecha_creacion DESC LIMIT ? OFFSET ?`,
            [idEmpresa, ...params, limit, offset]
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) total
             FROM mensualidades m
             LEFT JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
             WHERE ${whereClause}`,
            params
        );

        res.json({ success: true, data: rows.map(computeDueInfo), total });
    } catch (e) {
        console.error('Mensualidades GET:', e);
        res.status(500).json({ success: false, message: 'Error al listar mensualidades' });
    }
});

// Crear mensualidad o arriendo
// - Mensualidad: requiere placa (y id_tipo si el vehículo no existe)
// - Arriendo:    requiere referencia_espacio; no necesita placa ni vehículo
router.post('/', async (req, res) => {
    const idEmpresa = req.user.id_empresa;
    let {
        placa,
        id_tipo,
        tipo_servicio = 'mensualidad',
        referencia_espacio,
        titular_nombre,
        titular_documento,
        titular_telefono,
        titular_email,
        valor_mensual,
        fecha_inicio,
        fecha_fin,
        auto_renovar = true,
        observaciones = ''
    } = req.body;

    try {
        const tipoServicioVal = ['mensualidad', 'arriendo'].includes(tipo_servicio) ? tipo_servicio : 'mensualidad';
        const esArriendo = tipoServicioVal === 'arriendo';

        if (!titular_nombre || !valor_mensual || !fecha_inicio) {
            return res.status(400).json({ success: false, message: 'Faltan datos obligatorios: titular, valor mensual y fecha inicio' });
        }
        if (esArriendo && !referencia_espacio) {
            return res.status(400).json({ success: false, message: 'Para arriendos se requiere la referencia del espacio (ej: Local 101)' });
        }
        if (!esArriendo && !placa) {
            return res.status(400).json({ success: false, message: 'Para mensualidades se requiere la placa del vehículo' });
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            let idVehiculo = null;
            if (!esArriendo) {
                const [veh] = await conn.query(
                    'SELECT id_vehiculo FROM vehiculos WHERE placa = ? AND id_empresa = ?',
                    [placa.toUpperCase(), idEmpresa]
                );
                if (veh.length) {
                    idVehiculo = veh[0].id_vehiculo;
                } else {
                    if (!id_tipo) throw new Error('Tipo de vehículo requerido para crear el vehículo');
                    const [insVeh] = await conn.query(
                        `INSERT INTO vehiculos (id_empresa, placa, id_tipo, color, modelo) VALUES (?, ?, ?, '', '')`,
                        [idEmpresa, placa.toUpperCase(), parseInt(id_tipo)]
                    );
                    idVehiculo = insVeh.insertId;
                }

                // Validar duplicado: ya existe mensualidad activa o vencida para este vehículo
                const [dupVeh] = await conn.query(
                    `SELECT id_mensualidad FROM mensualidades
                     WHERE id_empresa = ? AND id_vehiculo = ? AND estado IN ('activa','vencida') LIMIT 1`,
                    [idEmpresa, idVehiculo]
                );
                if (dupVeh.length) {
                    await conn.rollback();
                    conn.release();
                    return res.status(409).json({
                        success: false,
                        message: `Ya existe una mensualidad activa o vencida para la placa ${placa.toUpperCase()}. Edita el registro existente o cancélalo primero.`
                    });
                }
            } else {
                // Validar duplicado para arriendos: mismo espacio activo
                const [dupArriendo] = await conn.query(
                    `SELECT id_mensualidad FROM mensualidades
                     WHERE id_empresa = ? AND LOWER(referencia_espacio) = LOWER(?) AND estado IN ('activa','vencida') LIMIT 1`,
                    [idEmpresa, referencia_espacio]
                );
                if (dupArriendo.length) {
                    await conn.rollback();
                    conn.release();
                    return res.status(409).json({
                        success: false,
                        message: `Ya existe un arriendo activo para el espacio "${referencia_espacio}". Edita el registro existente o cancélalo primero.`
                    });
                }
            }

            const [ins] = await conn.query(
                `INSERT INTO mensualidades (
                    id_empresa, id_vehiculo, titular_nombre, titular_documento, titular_telefono, titular_email,
                    valor_mensual, fecha_inicio, fecha_fin, auto_renovar, estado, tipo_servicio, referencia_espacio, observaciones
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activa', ?, ?, ?)`,
                [
                    idEmpresa, idVehiculo, titular_nombre,
                    titular_documento || null, titular_telefono || null, titular_email || null,
                    Number(valor_mensual), fecha_inicio, fecha_fin || null,
                    auto_renovar ? 1 : 0, tipoServicioVal,
                    esArriendo ? (referencia_espacio || null) : null,
                    observaciones
                ]
            );

            await conn.commit();
            res.status(201).json({ success: true, id_mensualidad: ins.insertId, message: esArriendo ? 'Arriendo creado' : 'Mensualidad creada' });
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    } catch (e) {
        console.error('Mensualidades POST:', e);
        res.status(500).json({ success: false, message: e.message || 'Error al crear' });
    }
});

// Actualizar mensualidad o arriendo
router.put('/:id', async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const id = parseInt(req.params.id);
        const {
            placa,
            id_tipo,
            tipo_servicio,
            referencia_espacio,
            titular_nombre,
            titular_documento,
            titular_telefono,
            titular_email,
            valor_mensual,
            fecha_inicio,
            fecha_fin,
            auto_renovar,
            estado,
            observaciones
        } = req.body;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [currRows] = await conn.query(
                `SELECT m.id_mensualidad, m.id_vehiculo, m.tipo_servicio,
                        v.placa AS placa_actual
                 FROM mensualidades m
                 LEFT JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
                 WHERE m.id_mensualidad = ? AND m.id_empresa = ?`,
                [id, idEmpresa]
            );
            if (!currRows.length) {
                await conn.rollback();
                conn.release();
                return res.status(404).json({ success: false, message: 'Mensualidad no encontrada' });
            }
            const curr = currRows[0];
            const tipoServicioFinal = (tipo_servicio && ['mensualidad', 'arriendo'].includes(tipo_servicio))
                ? tipo_servicio : curr.tipo_servicio;
            const esArriendo = tipoServicioFinal === 'arriendo';

            let idVehiculo = curr.id_vehiculo;
            if (!esArriendo && placa) {
                const placaActual = (curr.placa_actual || '').toUpperCase();
                if (placa.toUpperCase() !== placaActual) {
                    const [vehExist] = await conn.query(
                        `SELECT id_vehiculo FROM vehiculos WHERE placa = ? AND id_empresa = ?`,
                        [placa.toUpperCase(), idEmpresa]
                    );
                    if (vehExist.length) {
                        idVehiculo = vehExist[0].id_vehiculo;
                    } else {
                        if (!id_tipo) throw new Error('Tipo de vehículo requerido para crear el vehículo con la nueva placa');
                        const [insVeh] = await conn.query(
                            `INSERT INTO vehiculos (id_empresa, placa, id_tipo, color, modelo) VALUES (?, ?, ?, '', '')`,
                            [idEmpresa, placa.toUpperCase(), parseInt(id_tipo)]
                        );
                        idVehiculo = insVeh.insertId;
                    }
                }
            }
            if (esArriendo) { idVehiculo = null; }

            const [r] = await conn.query(
                `UPDATE mensualidades SET
                    id_vehiculo = ?,
                    titular_nombre = COALESCE(?, titular_nombre),
                    titular_documento = ?,
                    titular_telefono = ?,
                    titular_email = ?,
                    valor_mensual = COALESCE(?, valor_mensual),
                    fecha_inicio = COALESCE(?, fecha_inicio),
                    fecha_fin = ?,
                    auto_renovar = COALESCE(?, auto_renovar),
                    estado = COALESCE(?, estado),
                    tipo_servicio = ?,
                    referencia_espacio = ?,
                    observaciones = COALESCE(?, observaciones)
                 WHERE id_mensualidad = ? AND id_empresa = ?`,
                [
                    idVehiculo,
                    titular_nombre || null,
                    titular_documento || null,
                    titular_telefono || null,
                    titular_email || null,
                    (valor_mensual !== undefined ? Number(valor_mensual) : null),
                    fecha_inicio || null,
                    fecha_fin || null,
                    (auto_renovar === undefined ? null : (auto_renovar ? 1 : 0)),
                    estado || null,
                    tipoServicioFinal,
                    esArriendo ? (referencia_espacio || null) : null,
                    observaciones || null,
                    id, idEmpresa
                ]
            );

            await conn.commit();
            res.json({ success: true, message: r.affectedRows ? 'Guardado' : 'Sin cambios' });
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    } catch (e) {
        console.error('Mensualidades PUT:', e);
        res.status(500).json({ success: false, message: e.message || 'Error al actualizar' });
    }
});

// Detalle de una mensualidad/arriendo
router.get('/:id', async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const id = parseInt(req.params.id);
        const [rows] = await pool.query(
            `SELECT m.*, v.placa, tv.nombre AS tipo, tv.codigo AS tipo_codigo, v.id_tipo
             FROM mensualidades m
             LEFT JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
             LEFT JOIN tipos_vehiculos tv ON tv.id_tipo = v.id_tipo
             WHERE m.id_mensualidad = ? AND m.id_empresa = ?`,
            [id, idEmpresa]
        );
        if (!rows.length) return res.status(404).json({ success: false, message: 'No encontrado' });
        res.json({ success: true, data: rows[0] });
    } catch (e) {
        console.error('Mensualidades detail GET:', e);
        res.status(500).json({ success: false, message: 'Error al obtener' });
    }
});

// Obtener pagos de una mensualidad/arriendo
router.get('/:id/pagos', async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const idMens = parseInt(req.params.id);
        const [rows] = await pool.query(
            `SELECT * FROM mensualidades_pagos WHERE id_empresa = ? AND id_mensualidad = ? ORDER BY fecha_pago DESC`,
            [idEmpresa, idMens]
        );
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error('Mensualidades pagos GET:', e);
        res.status(500).json({ success: false, message: 'Error al obtener pagos' });
    }
});

// Registrar pago
router.post('/:id/pagos', async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const idMens = parseInt(req.params.id);
        const { periodo_desde, periodo_hasta, metodo_pago = 'efectivo', monto, referencia_pago = null } = req.body;

        if (!periodo_desde || !periodo_hasta || !monto) {
            return res.status(400).json({ success: false, message: 'Datos de pago incompletos' });
        }

        const [own] = await pool.query(
            `SELECT id_mensualidad FROM mensualidades WHERE id_mensualidad = ? AND id_empresa = ?`,
            [idMens, idEmpresa]
        );
        if (!own.length) return res.status(404).json({ success: false, message: 'No encontrado' });

        const [turnoRows] = await pool.query(
            `SELECT id_turno FROM turnos WHERE id_empresa = ? AND id_usuario = ? AND estado = 'abierto' LIMIT 1`,
            [idEmpresa, req.user.id]
        );
        if (!turnoRows.length) {
            return res.status(409).json({ success: false, message: 'Debe abrir un turno antes de registrar pagos' });
        }

        await pool.query(
            `INSERT INTO mensualidades_pagos (
                id_empresa, id_mensualidad, periodo_desde, periodo_hasta, metodo_pago, monto, referencia_pago, id_usuario
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [idEmpresa, idMens, periodo_desde, periodo_hasta, metodo_pago, Number(monto), referencia_pago, req.user.id]
        );

        res.status(201).json({ success: true, message: 'Pago registrado' });
    } catch (e) {
        console.error('Mensualidades pagos POST:', e);
        res.status(500).json({ success: false, message: 'Error al registrar pago' });
    }
});

// Sugerencia de pago: próximo periodo y monto por defecto
router.get('/:id/sugerencia-pago', async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const id = parseInt(req.params.id);

        const [[mens]] = await pool.query(
            `SELECT m.*, v.placa, tv.nombre AS tipo, v.id_tipo, (
                SELECT MAX(periodo_hasta) FROM mensualidades_pagos mp
                WHERE mp.id_empresa = m.id_empresa AND mp.id_mensualidad = m.id_mensualidad
            ) AS last_paid_until
             FROM mensualidades m
             LEFT JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
             LEFT JOIN tipos_vehiculos tv ON tv.id_tipo = v.id_tipo
             WHERE m.id_mensualidad = ? AND m.id_empresa = ?`,
            [id, idEmpresa]
        );
        if (!mens) return res.status(404).json({ success: false, message: 'No encontrado' });

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const fechaInicio = mens.fecha_inicio ? new Date(mens.fecha_inicio) : null;
        const fechaFin = mens.fecha_fin ? new Date(mens.fecha_fin) : null;
        const lastPaidUntil = mens.last_paid_until ? new Date(mens.last_paid_until) : null;

        let nextStart = fechaInicio ? new Date(fechaInicio) : null;
        if (lastPaidUntil) { const ns = new Date(lastPaidUntil); ns.setDate(ns.getDate() + 1); nextStart = ns; }

        const inactivo = (mens.estado === 'cancelada') || (fechaFin && today > fechaFin) || !nextStart;
        if (inactivo) {
            return res.json({ success: true, data: {
                due_status: 'inactivo', valor_mensual: Number(mens.valor_mensual || 0),
                months: 0, periodo_desde: null, periodo_hasta: null, monto: 0
            }});
        }

        const monthsDiff = (b, a) => {
            let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
            if (b.getDate() >= a.getDate()) m += 1;
            return m;
        };

        let months = 1;
        let due_status = 'al_dia';
        if (today >= nextStart) {
            months = Math.max(1, monthsDiff(today, nextStart));
            due_status = 'vencido';
        } else {
            const msPerDay = 86400000;
            const daysToNext = Math.ceil((nextStart - today) / msPerDay);
            due_status = daysToNext <= 5 ? 'proximo' : 'al_dia';
        }

        const desdeISO = nextStart.toISOString().slice(0, 10);
        const hastaDate = new Date(nextStart);
        hastaDate.setMonth(hastaDate.getMonth() + months);
        hastaDate.setDate(hastaDate.getDate() - 1);
        const hastaISO = hastaDate.toISOString().slice(0, 10);

        res.json({ success: true, data: {
            due_status, valor_mensual: Number(mens.valor_mensual || 0),
            months, periodo_desde: desdeISO, periodo_hasta: hastaISO,
            monto: Number(mens.valor_mensual || 0) * months
        }});
    } catch (e) {
        console.error('Sugerencia pago GET:', e);
        res.status(500).json({ success: false, message: 'Error al obtener sugerencia de pago' });
    }
});

// Eliminar o desactivar una mensualidad/arriendo (solo admin)
// - Sin pagos asociados → elimina el registro permanentemente
// - Con pagos asociados → cambia estado a 'cancelada' (desactivar)
router.delete('/:id', async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const id = parseInt(req.params.id);

        // Verificar que pertenece a la empresa
        const [rows] = await pool.query(
            'SELECT id_mensualidad, estado FROM mensualidades WHERE id_mensualidad = ? AND id_empresa = ?',
            [id, idEmpresa]
        );
        if (!rows.length) {
            return res.status(404).json({ success: false, message: 'Registro no encontrado' });
        }

        // Verificar si tiene pagos
        const [[{ total_pagos }]] = await pool.query(
            'SELECT COUNT(*) AS total_pagos FROM mensualidades_pagos WHERE id_mensualidad = ? AND id_empresa = ?',
            [id, idEmpresa]
        );

        if (total_pagos > 0) {
            // Tiene pagos: desactivar (cancelar) en lugar de borrar
            await pool.query(
                "UPDATE mensualidades SET estado = 'cancelada' WHERE id_mensualidad = ? AND id_empresa = ?",
                [id, idEmpresa]
            );
            return res.json({ success: true, action: 'deactivated', message: 'Registro desactivado. Los pagos históricos se conservan.' });
        } else {
            // Sin pagos: eliminar permanentemente
            await pool.query(
                'DELETE FROM mensualidades WHERE id_mensualidad = ? AND id_empresa = ?',
                [id, idEmpresa]
            );
            return res.json({ success: true, action: 'deleted', message: 'Registro eliminado permanentemente.' });
        }
    } catch (e) {
        console.error('Mensualidades DELETE:', e);
        res.status(500).json({ success: false, message: 'Error al eliminar o desactivar el registro' });
    }
});

module.exports = router;
