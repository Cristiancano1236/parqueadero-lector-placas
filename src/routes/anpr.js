/**
 * Webhook de la cámara ANPR (Dahua ITSAPI) — SOLO ingreso automático.
 *
 * La cámara hace el reconocimiento de placa en el propio hardware y empuja (push)
 * el evento por HTTP a este endpoint. ParkSystem NO hace OCR aquí: solo recibe
 * texto de placa, lo normaliza y registra el ingreso usando las mismas reglas
 * de negocio que el resto del sistema (src/services/movimientoService.js).
 *
 * Seguridad: no usa JWT de operador (la cámara no puede iniciar sesión). Se
 * autentica con un token por empresa (guardado cifrado) y, si está configurada,
 * una IP permitida (allowlist) — ambos gestionados desde el panel admin
 * (src/routes/anprConfig.js).
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../config/db');
const { normalizarPlaca, clasificarTipoPlaca } = require('../utils/placa');
const { decrypt } = require('../utils/crypto');
const { registrarIngreso } = require('../services/movimientoService');

// Estado en memoria (por proceso). Se reinicia si el servidor se reinicia; es
// suficiente para diagnóstico en el panel admin ("Último evento").
const cooldownPorPlaca = new Map(); // `${idEmpresa}:${placa}` -> timestamp ms
const ultimoEventoPorEmpresa = new Map(); // idEmpresa -> { placa, resultado, mensaje, fecha }

function actualizarUltimoEvento(idEmpresa, placa, resultado, mensaje) {
    ultimoEventoPorEmpresa.set(idEmpresa, {
        placa: placa || null,
        resultado, // 'ingreso' | 'duplicado' | 'ya_dentro' | 'invalida' | 'error'
        mensaje,
        fecha: new Date().toISOString()
    });
}

function obtenerUltimoEvento(idEmpresa) {
    return ultimoEventoPorEmpresa.get(idEmpresa) || null;
}

function ipDeRequest(req) {
    let ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip;
}

function compararTokens(a, b) {
    if (!a || !b) return false;
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// Busca, entre las empresas con ANPR activo, cuál coincide con el token recibido
// (y, si aplica, con la IP configurada). El token vive cifrado por empresa, así
// que no se puede buscar por igualdad SQL directa: se compara ya descifrado.
async function resolverEmpresaPorToken(tokenRecibido, ipOrigen) {
    if (!tokenRecibido) return null;
    const [rows] = await pool.query(
        `SELECT id_empresa, anpr_token, anpr_camera_ip, anpr_cooldown_seg, anpr_user_id
         FROM configuracion_empresa WHERE anpr_activo = TRUE`
    );
    for (const row of rows) {
        let tokenGuardado = null;
        try {
            tokenGuardado = decrypt(row.anpr_token);
        } catch (err) {
            continue;
        }
        if (!compararTokens(tokenGuardado, tokenRecibido)) continue;

        const ipConfigurada = (row.anpr_camera_ip || '').trim();
        if (ipConfigurada && ipConfigurada !== ipOrigen) continue;

        return row;
    }
    return null;
}

// Extrae el texto de placa de las variantes de payload más comunes en ITSAPI
// y en pruebas manuales. Se ajustará con el payload real capturado en sitio.
function extraerPlacaDePayload(body) {
    if (!body || typeof body !== 'object') return null;
    const candidatos = [
        body.PlateNumber,
        body.plate,
        body.placa,
        body.Plate,
        body?.Picture?.SnapInfo?.PlateNumber,
        body?.Picture?.SnapInfo?.Plate,
        body?.SnapInfo?.PlateNumber,
        body?.SnapInfo?.Plate,
        body?.TrafficCar?.PlateNumber,
        body?.Data?.PlateNumber,
        body?.Info?.Plate
    ];
    for (const c of candidatos) {
        if (c && String(c).trim()) return String(c).trim();
    }
    return null;
}

router.post('/dahua', async (req, res) => {
    try {
        const ipOrigen = ipDeRequest(req);
        const token = req.query.token || req.headers['x-anpr-token'] || (req.body && req.body.token);

        const empresa = await resolverEmpresaPorToken(token, ipOrigen);
        if (!empresa) {
            return res.status(401).json({ success: false, message: 'Token o IP no autorizados' });
        }

        const placaRaw = extraerPlacaDePayload(req.body);
        const placaNorm = normalizarPlaca(placaRaw);
        const tipoCodigo = clasificarTipoPlaca(placaNorm);

        // A partir de aquí SIEMPRE se responde 200 a la cámara (ACK), incluso si
        // no se registra el ingreso, para evitar que el ITSAPI reintente el mismo
        // evento en bucle. El resultado real queda en el "último evento" del panel.
        if (!placaNorm || !tipoCodigo) {
            actualizarUltimoEvento(empresa.id_empresa, placaRaw, 'invalida', 'Placa no reconocida o formato inválido');
            return res.status(200).json({ success: false, message: 'Placa inválida, se ignora' });
        }

        const cooldownMs = Math.max(1, Number(empresa.anpr_cooldown_seg) || 10) * 1000;
        const key = `${empresa.id_empresa}:${placaNorm}`;
        const ahora = Date.now();
        const ultimo = cooldownPorPlaca.get(key);
        if (ultimo && (ahora - ultimo) < cooldownMs) {
            actualizarUltimoEvento(empresa.id_empresa, placaNorm, 'duplicado', 'Ignorado por cooldown anti-duplicado');
            return res.status(200).json({ success: true, message: 'Duplicado ignorado (cooldown)' });
        }
        cooldownPorPlaca.set(key, ahora);

        if (!empresa.anpr_user_id) {
            actualizarUltimoEvento(empresa.id_empresa, placaNorm, 'error', 'Falta configurar el usuario de registro ANPR');
            return res.status(200).json({ success: false, message: 'Falta configurar el usuario de registro ANPR' });
        }

        const resultado = await registrarIngreso({
            idEmpresa: empresa.id_empresa,
            placaRaw: placaNorm,
            autoTipo: true,
            idUsuario: empresa.anpr_user_id
        });

        if (!resultado.ok) {
            const tipoResultado = resultado.status === 409 ? 'ya_dentro' : 'error';
            actualizarUltimoEvento(empresa.id_empresa, placaNorm, tipoResultado, resultado.message);
            return res.status(200).json({ success: false, message: resultado.message });
        }

        actualizarUltimoEvento(empresa.id_empresa, placaNorm, 'ingreso', 'Ingreso registrado');
        return res.status(200).json({ success: true, message: 'Ingreso registrado', data: resultado.data });
    } catch (error) {
        console.error('Error POST /api/anpr/dahua:', error);
        // 200 también en error inesperado: evita reintentos agresivos de la cámara.
        return res.status(200).json({ success: false, message: 'Error interno procesando el evento' });
    }
});

module.exports = router;
module.exports.obtenerUltimoEvento = obtenerUltimoEvento;
