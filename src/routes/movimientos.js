const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyToken = require('../middleware/auth');

// Obtener tarifa activa por tipo de vehículo para la empresa
// Relacionado con: src/routes/tarifas.js para estructura de tarifas
async function obtenerTarifaActiva(idEmpresa, idTipo) {
    const [tarifas] = await pool.query(
        `SELECT * FROM tarifas 
         WHERE id_empresa = ? AND id_tipo = ? AND activa = TRUE 
         AND (fecha_vigencia_hasta IS NULL OR fecha_vigencia_hasta >= CURRENT_TIMESTAMP)
         ORDER BY fecha_vigencia_desde DESC LIMIT 1`,
        [idEmpresa, idTipo]
    );
    return tarifas[0] || null;
}

// Calcular total considerando modo de cobro y escalones
function calcularTotalMixto(minutos, tarifa) {
    const valorMin = Number(tarifa.valor_minuto);
    const valorHor = Number(tarifa.valor_hora);
    const valorDia = Number(tarifa.valor_dia_completo);
    const pasoMinAHr = Number(tarifa.paso_minutos_a_horas || 0);
    const pasoHrADia = Number(tarifa.paso_horas_a_dias || 0);
    const redHr = tarifa.redondeo_horas || 'arriba';
    const redDia = tarifa.redondeo_dias || 'arriba';

    let restante = minutos;
    let total = 0;
    let dias = 0, horas = 0, mins = 0;

    // Etapa minutos
    if (pasoMinAHr > 0 && restante > pasoMinAHr) {
        mins = pasoMinAHr;
        total += mins * valorMin;
        restante -= mins;
    } else {
        mins = restante;
        total += mins * valorMin;
        restante = 0;
    }

    // Etapa horas
    if (restante > 0) {
        let horasFloat = restante / 60;
        let horasCobrables = redHr === 'arriba' ? Math.ceil(horasFloat) : Math.floor(horasFloat);
        if (pasoHrADia > 0 && horasCobrables > pasoHrADia) {
            horasCobrables = pasoHrADia;
        }
        horas = horasCobrables;
        total += horas * valorHor;
        restante -= horas * 60;
    }

    // Etapa días
    if (restante > 0) {
        let diasFloat = restante / (24 * 60);
        let diasCobrables = redDia === 'arriba' ? Math.ceil(diasFloat) : Math.floor(diasFloat);
        dias = diasCobrables;
        total += dias * valorDia;
        restante = 0;
    }

    return { total: Number(total.toFixed(2)), dias, horas, minutos: mins };
}

function calcularTotal({ minutos, tarifa }) {
    const valorMin = Number(tarifa.valor_minuto);
    const valorHor = Number(tarifa.valor_hora);
    const valorDia = Number(tarifa.valor_dia_completo);
    const modo = tarifa.modo_cobro || 'mixto';

    if (modo === 'minuto') {
        return { total: Number((minutos * valorMin).toFixed(2)), dias: 0, horas: 0, minutos };
    }
    if (modo === 'hora') {
        const horas = Math.ceil(minutos / 60);
        return { total: Number((horas * valorHor).toFixed(2)), dias: 0, horas, minutos: minutos % 60 };
    }
    if (modo === 'dia') {
        const dias = Math.ceil(minutos / (24 * 60));
        return { total: Number((dias * valorDia).toFixed(2)), dias, horas: 0, minutos: minutos % (24*60) };
    }
    // mixto (escalonado)
    return calcularTotalMixto(minutos, tarifa);
}

// Registrar ingreso
// Relacionado con: public/admin/ingreso-salida.html para formulario de ingreso
router.post('/ingreso', verifyToken, async (req, res) => {
    try {
        const { placa, id_tipo } = req.body;
        const idEmpresa = req.user.id_empresa;

        if (!placa || !id_tipo) {
            return res.status(400).json({ success: false, message: 'Placa y tipo son obligatorios' });
        }

        // Verificar que el tipo existe y está activo
        const [tipo] = await pool.query(
            'SELECT id_tipo, nombre, codigo FROM tipos_vehiculos WHERE id_tipo = ? AND id_empresa = ? AND activo = TRUE',
            [id_tipo, idEmpresa]
        );

        if (tipo.length === 0) {
            return res.status(400).json({ success: false, message: 'Tipo de vehículo no válido o inactivo' });
        }

        const tarifa = await obtenerTarifaActiva(idEmpresa, id_tipo);
        if (!tarifa) {
            return res.status(400).json({ success: false, message: 'No hay tarifa activa para este tipo' });
        }

        // Crear vehículo si no existe
        const [vehiculos] = await pool.query(
            'SELECT id_vehiculo FROM vehiculos WHERE placa = ? AND id_empresa = ?',
            [placa, idEmpresa]
        );
        let idVehiculo;
        if (vehiculos.length === 0) {
            const [ins] = await pool.query(
                'INSERT INTO vehiculos (id_empresa, placa, id_tipo, color) VALUES (?, ?, ?, ?)',
                [idEmpresa, placa.toUpperCase(), id_tipo, 'N/A']
            );
            idVehiculo = ins.insertId;
        } else {
            idVehiculo = vehiculos[0].id_vehiculo;
        }

        // Verificar si ya está activo
        const [activos] = await pool.query(
            'SELECT id_movimiento FROM movimientos WHERE id_vehiculo = ? AND fecha_salida IS NULL',
            [idVehiculo]
        );
        if (activos.length > 0) {
            return res.status(409).json({ success: false, message: 'El vehículo ya está dentro' });
        }

        const [mov] = await pool.query(
            `INSERT INTO movimientos (id_empresa, id_vehiculo, id_tarifa, fecha_entrada, id_usuario_entrada, estado)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'activo')`,
            [idEmpresa, idVehiculo, tarifa.id_tarifa, req.user.id]
        );

        const comprobante = {
            movimientoId: mov.insertId,
            placa: placa.toUpperCase(),
            tipo: tipo[0].nombre,
            tipo_codigo: tipo[0].codigo,
            fechaEntrada: new Date().toISOString(),
            tarifa: {
                valor_minuto: tarifa.valor_minuto,
                valor_hora: tarifa.valor_hora,
                valor_dia_completo: tarifa.valor_dia_completo
            }
        };

        res.status(201).json({ success: true, data: comprobante, message: 'Ingreso registrado' });
    } catch (error) {
        console.error('Error ingreso:', error);
        res.status(500).json({ success: false, message: 'Error al registrar ingreso' });
    }
});

// Calcular total sin finalizar (para previsualización antes de confirmar pago)
// Relacionado con: public/admin/ingreso-salida.html para calcular total antes de confirmar
router.post('/calcular-salida', verifyToken, async (req, res) => {
    try {
        const { placa } = req.body;
        const idEmpresa = req.user.id_empresa;
        if (!placa) {
            return res.status(400).json({ success: false, message: 'Placa es obligatoria' });
        }

        const [vehiculos] = await pool.query(
            `SELECT v.id_vehiculo, v.id_tipo, tv.nombre as tipo, tv.codigo as tipo_codigo 
             FROM vehiculos v
             JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
             WHERE v.placa = ? AND v.id_empresa = ?`,
            [placa, idEmpresa]
        );
        if (vehiculos.length === 0) {
            return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });
        }
        const vehiculo = vehiculos[0];

        const [movs] = await pool.query(
            'SELECT * FROM movimientos WHERE id_vehiculo = ? AND fecha_salida IS NULL',
            [vehiculo.id_vehiculo]
        );
        if (movs.length === 0) {
            return res.status(404).json({ success: false, message: 'El vehículo no tiene ingreso activo' });
        }
        const mov = movs[0];

        const tarifa = await obtenerTarifaActiva(idEmpresa, vehiculo.id_tipo);
        if (!tarifa) {
            return res.status(400).json({ success: false, message: 'No hay tarifa activa para este tipo' });
        }

        const [tiempo] = await pool.query(
            'SELECT TIMESTAMPDIFF(MINUTE, ?, CURRENT_TIMESTAMP) as minutos',
            [mov.fecha_entrada]
        );
        const minutos = tiempo[0].minutos;
        const { total, dias, horas, minutos: mins } = calcularTotal({ minutos, tarifa });

        // NO finalizar el movimiento, solo calcular y devolver
        const factura = {
            movimientoId: mov.id_movimiento,
            placa: placa.toUpperCase(),
            tipo: vehiculo.tipo,
            tipo_codigo: vehiculo.tipo_codigo,
            fechaEntrada: mov.fecha_entrada,
            fechaSalida: new Date().toISOString(), // Fecha estimada para mostrar
            detalleTiempo: { dias, horas, minutos: mins },
            tarifa: {
                valor_minuto: tarifa.valor_minuto,
                valor_hora: tarifa.valor_hora,
                valor_dia_completo: tarifa.valor_dia_completo
            },
            total
        };

        res.json({ success: true, data: factura, message: 'Total calculado' });
    } catch (error) {
        console.error('Error calcular salida:', error);
        res.status(500).json({ success: false, message: 'Error al calcular total' });
    }
});

// Confirmar salida y registrar pagos (solo se llama cuando se confirma el pago)
// Relacionado con: public/admin/ingreso-salida.html cuando se confirma el pago en el modal
router.post('/confirmar-salida', verifyToken, async (req, res) => {
    try {
        const { id_movimiento, pagos } = req.body;
        const idEmpresa = req.user.id_empresa;

        if (!id_movimiento) {
            return res.status(400).json({ success: false, message: 'ID de movimiento es obligatorio' });
        }

        if (!Array.isArray(pagos) || pagos.length === 0) {
            return res.status(400).json({ success: false, message: 'Debe registrar al menos un pago' });
        }

        // Verificar que el movimiento pertenece a la empresa y está activo
        const [movs] = await pool.query(
            `SELECT m.*, v.placa, v.id_tipo, tv.nombre as tipo, tv.codigo as tipo_codigo
             FROM movimientos m
             JOIN vehiculos v ON m.id_vehiculo = v.id_vehiculo
             JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
             WHERE m.id_movimiento = ? AND m.id_empresa = ? AND m.fecha_salida IS NULL`,
            [id_movimiento, idEmpresa]
        );

        if (movs.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Movimiento no encontrado o ya fue finalizado' 
            });
        }

        const mov = movs[0];

        // Obtener tarifa para recalcular total (por si pasó tiempo)
        const tarifa = await obtenerTarifaActiva(idEmpresa, mov.id_tipo);
        if (!tarifa) {
            return res.status(400).json({ success: false, message: 'No hay tarifa activa para este tipo' });
        }

        const [tiempo] = await pool.query(
            'SELECT TIMESTAMPDIFF(MINUTE, ?, CURRENT_TIMESTAMP) as minutos',
            [mov.fecha_entrada]
        );
        const minutos = tiempo[0].minutos;
        const { total, dias, horas, minutos: mins } = calcularTotal({ minutos, tarifa });

        // Calcular total de pagos
        const totalPagado = pagos.reduce((sum, p) => sum + Number(p.monto || 0), 0);
        if ((totalPagado + 0.0001) < total) {
            return res.status(400).json({ 
                success: false, 
                message: `El total pagado (${totalPagado}) es menor al total a pagar (${total})` 
            });
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Finalizar el movimiento
            await conn.query(
                `UPDATE movimientos 
                 SET fecha_salida = CURRENT_TIMESTAMP, 
                     total_a_pagar = ?, 
                     estado = 'finalizado', 
                     id_usuario_salida = ?
                 WHERE id_movimiento = ?`,
                [total, req.user.id, id_movimiento]
            );

            // Registrar pagos
            const valoresPagos = pagos
                .filter(p => p && p.metodo_pago && Number(p.monto) > 0)
                .map(p => [idEmpresa, id_movimiento, p.metodo_pago, Number(p.monto), req.user.id]);

            if (valoresPagos.length > 0) {
                await conn.query(
                    `INSERT INTO pagos (id_empresa, id_movimiento, metodo_pago, monto, id_usuario)
                     VALUES ?`,
                    [valoresPagos]
                );
            }

            await conn.commit();

            const factura = {
                movimientoId: mov.id_movimiento,
                placa: mov.placa.toUpperCase(),
                tipo: mov.tipo,
                tipo_codigo: mov.tipo_codigo,
                fechaEntrada: mov.fecha_entrada,
                fechaSalida: new Date().toISOString(),
                detalleTiempo: { dias, horas, minutos: mins },
                tarifa: {
                    valor_minuto: tarifa.valor_minuto,
                    valor_hora: tarifa.valor_hora,
                    valor_dia_completo: tarifa.valor_dia_completo
                },
                total,
                pagosList: pagos
            };

            res.json({ success: true, data: factura, message: 'Salida confirmada y pagos registrados' });
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('Error confirmar salida:', error);
        res.status(500).json({ success: false, message: 'Error al confirmar la salida: ' + (error.message || 'Error desconocido') });
    }
});

// Registrar salida y calcular total (mantener para compatibilidad con código existente)
// Relacionado con: public/admin/ingreso-salida.html y otros lugares que usan el endpoint antiguo
router.post('/salida', verifyToken, async (req, res) => {
    try {
        const { placa, metodoPago } = req.body;
        const idEmpresa = req.user.id_empresa;
        if (!placa) {
            return res.status(400).json({ success: false, message: 'Placa es obligatoria' });
        }

        const [vehiculos] = await pool.query(
            `SELECT v.id_vehiculo, v.id_tipo, tv.nombre as tipo, tv.codigo as tipo_codigo 
             FROM vehiculos v
             JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
             WHERE v.placa = ? AND v.id_empresa = ?`,
            [placa, idEmpresa]
        );
        if (vehiculos.length === 0) {
            return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });
        }
        const vehiculo = vehiculos[0];

        const [movs] = await pool.query(
            'SELECT * FROM movimientos WHERE id_vehiculo = ? AND fecha_salida IS NULL',
            [vehiculo.id_vehiculo]
        );
        if (movs.length === 0) {
            return res.status(404).json({ success: false, message: 'El vehículo no tiene ingreso activo' });
        }
        const mov = movs[0];

        const tarifa = await obtenerTarifaActiva(idEmpresa, vehiculo.id_tipo);
        if (!tarifa) {
            return res.status(400).json({ success: false, message: 'No hay tarifa activa para este tipo' });
        }

        const [tiempo] = await pool.query(
            'SELECT TIMESTAMPDIFF(MINUTE, ?, CURRENT_TIMESTAMP) as minutos',
            [mov.fecha_entrada]
        );
        const minutos = tiempo[0].minutos;
        const { total, dias, horas, minutos: mins } = calcularTotal({ minutos, tarifa });

        await pool.query(
            `UPDATE movimientos SET fecha_salida = CURRENT_TIMESTAMP, total_a_pagar = ?, estado = 'finalizado', id_usuario_salida = ?
             WHERE id_movimiento = ?`,
            [total, req.user.id, mov.id_movimiento]
        );

        if (metodoPago) {
            await pool.query(
                `INSERT INTO pagos (id_empresa, id_movimiento, metodo_pago, monto, id_usuario)
                 VALUES (?, ?, ?, ?, ?)`,
                [idEmpresa, mov.id_movimiento, metodoPago, total, req.user.id]
            );
        }

        const factura = {
            movimientoId: mov.id_movimiento,
            placa: placa.toUpperCase(),
            tipo: vehiculo.tipo,
            tipo_codigo: vehiculo.tipo_codigo,
            fechaEntrada: mov.fecha_entrada,
            fechaSalida: new Date().toISOString(),
            detalleTiempo: { dias, horas, minutos: mins },
            tarifa: {
                valor_minuto: tarifa.valor_minuto,
                valor_hora: tarifa.valor_hora,
                valor_dia_completo: tarifa.valor_dia_completo
            },
            total
        };

        res.json({ success: true, data: factura, message: 'Salida registrada' });
    } catch (error) {
        console.error('Error salida:', error);
        res.status(500).json({ success: false, message: 'Error al registrar salida' });
    }
});

// Revertir salida (reactivar movimiento) - útil cuando se cancela el pago
// Relacionado con: public/admin/ingreso-salida.html cuando se cancela el modal de pago
router.post('/revertir-salida', verifyToken, async (req, res) => {
    try {
        const { id_movimiento } = req.body;
        const idEmpresa = req.user.id_empresa;

        if (!id_movimiento) {
            return res.status(400).json({ success: false, message: 'ID de movimiento es obligatorio' });
        }

        // Verificar que el movimiento pertenece a la empresa y está finalizado
        const [movs] = await pool.query(
            `SELECT m.* FROM movimientos m 
             WHERE m.id_movimiento = ? AND m.id_empresa = ? AND m.estado = 'finalizado'`,
            [id_movimiento, idEmpresa]
        );

        if (movs.length === 0) {
            // Intentar buscar el movimiento aunque no esté finalizado (por si acaso)
            const [movs2] = await pool.query(
                `SELECT m.* FROM movimientos m 
                 WHERE m.id_movimiento = ? AND m.id_empresa = ?`,
                [id_movimiento, idEmpresa]
            );
            
            if (movs2.length === 0) {
                return res.status(404).json({ 
                    success: false, 
                    message: 'Movimiento no encontrado' 
                });
            }
            
            // Si el movimiento existe pero no está finalizado, puede que ya se haya revertido
            if (movs2[0].estado === 'activo') {
                return res.json({ 
                    success: true, 
                    message: 'El movimiento ya está activo' 
                });
            }
            
            return res.status(400).json({ 
                success: false, 
                message: 'El movimiento no está en estado finalizado' 
            });
        }

        const mov = movs[0];

        // Verificar que no tenga pagos registrados
        const [pagos] = await pool.query(
            'SELECT COUNT(*) as total FROM pagos WHERE id_movimiento = ?',
            [id_movimiento]
        );

        if (pagos[0].total > 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'No se puede revertir un movimiento que ya tiene pagos registrados' 
            });
        }

        // Revertir la salida: poner fecha_salida en NULL, estado en 'activo', y limpiar total_a_pagar
        const [result] = await pool.query(
            `UPDATE movimientos 
             SET fecha_salida = NULL, 
                 estado = 'activo', 
                 total_a_pagar = NULL,
                 id_usuario_salida = NULL
             WHERE id_movimiento = ? AND id_empresa = ?`,
            [id_movimiento, idEmpresa]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'No se pudo actualizar el movimiento' 
            });
        }

        res.json({ 
            success: true, 
            message: 'Salida revertida exitosamente. El vehículo está activo nuevamente.' 
        });
    } catch (error) {
        console.error('Error al revertir salida:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error al revertir la salida: ' + (error.message || 'Error desconocido') 
        });
    }
});

module.exports = router;

// Detalle por id_movimiento (para dashboard)
const { sanitizeIdParam } = require('../utils/sanitize');
router.get('/detalle/:id', verifyToken, sanitizeIdParam('id'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT m.*, v.placa, tv.nombre as tipo, tv.codigo as tipo_codigo
             FROM movimientos m 
             JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
             JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
             WHERE m.id_movimiento = ?`,
            [req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'No encontrado' });
        res.json({ success: true, data: rows[0] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Error obteniendo detalle' });
    }
});

// Factura completa para reimpresión (incluye tarifa usada, tiempos y pagos)
router.get('/factura/:id', verifyToken, sanitizeIdParam('id'), async (req, res) => {
    try {
        const idMov = req.params.id;
        const [rows] = await pool.query(
            `SELECT m.*, v.placa, tv.nombre as tipo, tv.codigo as tipo_codigo, t.valor_minuto, t.valor_hora, t.valor_dia_completo
             FROM movimientos m
             JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
             JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
             JOIN tarifas t ON t.id_tarifa = m.id_tarifa
             WHERE m.id_movimiento = ? AND m.id_empresa = ?`
            , [idMov, req.user.id_empresa]
        );
        if (rows.length === 0) return res.status(404).json({ success:false, message:'Movimiento no encontrado' });
        const m = rows[0];
        if (!m.fecha_salida) return res.status(400).json({ success:false, message:'Movimiento no finalizado' });
        // Calcular tiempos
        const fechaEntrada = new Date(m.fecha_entrada);
        const fechaSalida = new Date(m.fecha_salida);
        const diffMin = Math.max(0, Math.round((fechaSalida - fechaEntrada) / 60000));
        const dias = Math.floor(diffMin / (24*60));
        const remMin1 = diffMin % (24*60);
        const horas = Math.floor(remMin1 / 60);
        const minutos = remMin1 % 60;
        // Pagos
        const [pRows] = await pool.query(
            `SELECT metodo_pago, monto FROM pagos WHERE id_empresa = ? AND id_movimiento = ? ORDER BY id_pago ASC`,
            [req.user.id_empresa, idMov]
        );
        const factura = {
            movimientoId: m.id_movimiento,
            placa: m.placa,
            tipo: m.tipo,
            fechaEntrada: m.fecha_entrada,
            fechaSalida: m.fecha_salida,
            detalleTiempo: { dias, horas, minutos },
            tarifa: {
                valor_minuto: m.valor_minuto,
                valor_hora: m.valor_hora,
                valor_dia_completo: m.valor_dia_completo
            },
            total: Number(m.total_a_pagar||0),
            pagosList: pRows.map(p=>({ metodo_pago: p.metodo_pago, monto: Number(p.monto||0) }))
        };
        res.json({ success:true, data: factura });
    } catch (e) {
        console.error('movimientos/factura', e);
        res.status(500).json({ success:false, message:'Error obteniendo factura' });
    }
});


