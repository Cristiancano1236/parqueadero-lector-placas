/**
 * Lógica de ingreso reutilizable, sin depender de `req`/`res`.
 * Usada por POST /api/movimientos/ingreso (operador, vía JWT) y
 * POST /api/anpr/dahua (cámara ANPR, vía token) para no duplicar reglas de negocio.
 */
const pool = require('../config/db');
const { normalizarPlaca, clasificarTipoPlaca } = require('../utils/placa');

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

/**
 * Registra un ingreso. No escribe en `res`; devuelve { ok, status, message, data }.
 * @param {Object} params
 * @param {number} params.idEmpresa
 * @param {string} params.placaRaw
 * @param {number} [params.idTipo] - Requerido si autoTipo no es true
 * @param {boolean} [params.autoTipo] - Clasifica carro/moto por formato de placa (Colombia)
 * @param {number} params.idUsuario - Usuario que queda registrado como id_usuario_entrada
 */
async function registrarIngreso({ idEmpresa, placaRaw, idTipo, autoTipo, idUsuario }) {
    const placaNorm = normalizarPlaca(placaRaw);
    if (!placaNorm) {
        return { ok: false, status: 400, message: 'La placa es obligatoria' };
    }

    const codigoClasificado = clasificarTipoPlaca(placaNorm);
    if (!codigoClasificado) {
        return {
            ok: false,
            status: 400,
            message: 'Placa inválida. Use formato carro (ABC123) o moto (ABC12D)'
        };
    }

    let idTipoResuelto = idTipo;
    let tipoInfo;
    if (!idTipoResuelto || autoTipo) {
        const [tipoRows] = await pool.query(
            `SELECT id_tipo, nombre, codigo FROM tipos_vehiculos
             WHERE id_empresa = ? AND codigo = ? AND activo = TRUE`,
            [idEmpresa, codigoClasificado]
        );
        if (tipoRows.length === 0) {
            return {
                ok: false,
                status: 400,
                message: `No hay tipo activo "${codigoClasificado}" para esta empresa`
            };
        }
        idTipoResuelto = tipoRows[0].id_tipo;
        tipoInfo = tipoRows[0];
    } else {
        const [tipoRows] = await pool.query(
            'SELECT id_tipo, nombre, codigo FROM tipos_vehiculos WHERE id_tipo = ? AND id_empresa = ? AND activo = TRUE',
            [idTipoResuelto, idEmpresa]
        );
        if (tipoRows.length === 0) {
            return { ok: false, status: 400, message: 'Tipo de vehículo no válido o inactivo' };
        }
        tipoInfo = tipoRows[0];
    }

    const tarifa = await obtenerTarifaActiva(idEmpresa, idTipoResuelto);
    if (!tarifa) {
        return { ok: false, status: 400, message: 'No hay tarifa activa para este tipo' };
    }

    const [vehiculos] = await pool.query(
        'SELECT id_vehiculo, id_tipo FROM vehiculos WHERE placa = ? AND id_empresa = ?',
        [placaNorm, idEmpresa]
    );
    let idVehiculo;
    if (vehiculos.length === 0) {
        const [ins] = await pool.query(
            'INSERT INTO vehiculos (id_empresa, placa, id_tipo, color) VALUES (?, ?, ?, ?)',
            [idEmpresa, placaNorm, idTipoResuelto, 'N/A']
        );
        idVehiculo = ins.insertId;
    } else {
        idVehiculo = vehiculos[0].id_vehiculo;
        if (Number(vehiculos[0].id_tipo) !== Number(idTipoResuelto)) {
            await pool.query(
                'UPDATE vehiculos SET id_tipo = ? WHERE id_vehiculo = ? AND id_empresa = ?',
                [idTipoResuelto, idVehiculo, idEmpresa]
            );
        }
    }

    // Anti-duplicado a nivel de negocio: si ya tiene un movimiento activo, no se abre otro.
    const [activos] = await pool.query(
        'SELECT id_movimiento FROM movimientos WHERE id_vehiculo = ? AND fecha_salida IS NULL',
        [idVehiculo]
    );
    if (activos.length > 0) {
        return { ok: false, status: 409, message: 'El vehículo ya está dentro' };
    }

    const [mov] = await pool.query(
        `INSERT INTO movimientos (id_empresa, id_vehiculo, id_tarifa, fecha_entrada, id_usuario_entrada, estado)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'activo')`,
        [idEmpresa, idVehiculo, tarifa.id_tarifa, idUsuario]
    );

    const comprobante = {
        movimientoId: mov.insertId,
        placa: placaNorm,
        tipo: tipoInfo.nombre,
        tipo_codigo: tipoInfo.codigo,
        fechaEntrada: new Date().toISOString(),
        tarifa: {
            valor_minuto: tarifa.valor_minuto,
            valor_hora: tarifa.valor_hora,
            valor_dia_completo: tarifa.valor_dia_completo
        }
    };

    return { ok: true, status: 201, message: 'Ingreso registrado', data: comprobante };
}

module.exports = {
    obtenerTarifaActiva,
    registrarIngreso
};
