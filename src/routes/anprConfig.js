/**
 * Configuración de la integración ANPR (cámara Dahua) — solo admin.
 * Relacionado con: public/admin/configuracion.html (sección "Cámara ANPR")
 * y src/routes/anpr.js (webhook que consume esta configuración).
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../config/db');
const verifyToken = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const { encrypt, decrypt, maskSecret } = require('../utils/crypto');
const { obtenerIpsLocales } = require('../utils/network');
const anprWebhook = require('./anpr');

async function getConfig(idEmpresa) {
    const [rows] = await pool.query(
        `SELECT anpr_activo, anpr_token, anpr_camera_ip, anpr_cooldown_seg, anpr_user_id
         FROM configuracion_empresa WHERE id_empresa = ?`,
        [idEmpresa]
    );
    return rows[0] || null;
}

function decryptToken(encrypted) {
    if (!encrypted) return null;
    try {
        return decrypt(encrypted);
    } catch (err) {
        console.error('No se pudo descifrar el token ANPR:', err.message);
        return null;
    }
}

router.get('/config', verifyToken, requireAdmin, async (req, res) => {
    try {
        const row = await getConfig(req.user.id_empresa);
        if (!row) {
            return res.status(404).json({ success: false, message: 'Configuración no encontrada' });
        }

        const token = decryptToken(row.anpr_token);
        const ips = obtenerIpsLocales();
        const ipServidor = ips[0] || 'localhost';
        const puerto = process.env.PORT || 3000;
        const webhookUrl = token
            ? `${req.protocol}://${ipServidor}:${puerto}/api/anpr/dahua?token=${token}`
            : null;

        const [usuarios] = await pool.query(
            'SELECT id_usuario, nombre FROM usuarios WHERE id_empresa = ? AND activo = TRUE ORDER BY nombre',
            [req.user.id_empresa]
        );

        res.json({
            success: true,
            data: {
                activo: Boolean(row.anpr_activo),
                configurado: Boolean(token),
                token_preview: token ? maskSecret(token) : null,
                camera_ip: row.anpr_camera_ip || '',
                cooldown_seg: row.anpr_cooldown_seg || 10,
                usuario_id: row.anpr_user_id || null,
                webhook_url: webhookUrl,
                ips_disponibles: ips,
                usuarios_disponibles: usuarios,
                ultimo_evento: anprWebhook.obtenerUltimoEvento(req.user.id_empresa)
            }
        });
    } catch (error) {
        console.error('Error GET /api/anpr/config:', error);
        res.status(500).json({ success: false, message: 'Error al obtener la configuración ANPR' });
    }
});

router.put('/config', verifyToken, requireAdmin, async (req, res) => {
    try {
        const row = await getConfig(req.user.id_empresa);
        if (!row) {
            return res.status(404).json({ success: false, message: 'Configuración no encontrada' });
        }

        const fields = [];
        const values = [];
        const regenerarToken = req.body.regenerar_token === true;

        if (req.body.camera_ip != null) {
            const ip = String(req.body.camera_ip).trim();
            if (ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
                return res.status(400).json({ success: false, message: 'IP de cámara inválida' });
            }
            fields.push('anpr_camera_ip = ?');
            values.push(ip || null);
        }

        if (req.body.cooldown_seg != null) {
            const c = parseInt(req.body.cooldown_seg, 10);
            if (!Number.isFinite(c) || c < 1 || c > 300) {
                return res.status(400).json({ success: false, message: 'El cooldown debe estar entre 1 y 300 segundos' });
            }
            fields.push('anpr_cooldown_seg = ?');
            values.push(c);
        }

        let usuarioIdNuevo = null;
        if (req.body.usuario_id != null) {
            usuarioIdNuevo = parseInt(req.body.usuario_id, 10);
            if (!Number.isFinite(usuarioIdNuevo)) {
                return res.status(400).json({ success: false, message: 'Usuario inválido' });
            }
            const [u] = await pool.query(
                'SELECT id_usuario FROM usuarios WHERE id_usuario = ? AND id_empresa = ? AND activo = TRUE',
                [usuarioIdNuevo, req.user.id_empresa]
            );
            if (u.length === 0) {
                return res.status(400).json({ success: false, message: 'Usuario no válido para esta empresa' });
            }
            fields.push('anpr_user_id = ?');
            values.push(usuarioIdNuevo);
        }

        if (regenerarToken) {
            const nuevoToken = crypto.randomBytes(24).toString('hex');
            fields.push('anpr_token = ?');
            values.push(encrypt(nuevoToken));
        }

        if (typeof req.body.activo === 'boolean') {
            if (req.body.activo === true) {
                const tendraToken = Boolean(row.anpr_token) || regenerarToken;
                const tendraUsuario = row.anpr_user_id || usuarioIdNuevo;
                if (!tendraToken) {
                    return res.status(400).json({
                        success: false,
                        message: 'Genera el token de seguridad antes de activar el ingreso por ANPR'
                    });
                }
                if (!tendraUsuario) {
                    return res.status(400).json({
                        success: false,
                        message: 'Selecciona el usuario de registro antes de activar el ingreso por ANPR'
                    });
                }
            }
            fields.push('anpr_activo = ?');
            values.push(req.body.activo);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, message: 'Nada para actualizar' });
        }

        values.push(req.user.id_empresa);
        await pool.query(
            `UPDATE configuracion_empresa SET ${fields.join(', ')} WHERE id_empresa = ?`,
            values
        );

        res.json({ success: true, message: 'Configuración ANPR guardada' });
    } catch (error) {
        console.error('Error PUT /api/anpr/config:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Error al guardar la configuración ANPR'
        });
    }
});

module.exports = router;
