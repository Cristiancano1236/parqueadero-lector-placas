const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyToken = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const { encrypt, decrypt, maskSecret } = require('../utils/crypto');
const gemini = require('../services/geminiPlateOcr');

const MODELOS_PERMITIDOS = new Set([
    'gemini-3.1-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.1-pro-preview',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro'
]);

function sanitizeModelo(raw) {
    const m = String(raw || '').trim();
    if (!m) return gemini.DEFAULT_MODEL;
    if (m.length > 50) {
        throw new Error('El nombre del modelo es demasiado largo (máx. 50)');
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(m)) {
        throw new Error('Nombre de modelo inválido');
    }
    return m;
}

async function getEmpresaConfig(idEmpresa) {
    const [rows] = await pool.query(
        'SELECT gemini_api_key, gemini_modelo FROM configuracion_empresa WHERE id_empresa = ?',
        [idEmpresa]
    );
    return rows[0] || null;
}

function decryptStoredKey(encrypted) {
    if (!encrypted) return null;
    try {
        return decrypt(encrypted);
    } catch (err) {
        console.error('No se pudo descifrar la API Key de Gemini:', err.message);
        return null;
    }
}

router.get('/config', verifyToken, requireAdmin, async (req, res) => {
    try {
        const row = await getEmpresaConfig(req.user.id_empresa);
        if (!row) {
            return res.status(404).json({ success: false, message: 'Configuración no encontrada' });
        }
        const plain = decryptStoredKey(row.gemini_api_key);
        res.json({
            success: true,
            data: {
                configurado: Boolean(plain),
                modelo: row.gemini_modelo || gemini.DEFAULT_MODEL,
                api_key_preview: plain ? maskSecret(plain) : null,
                modelos_sugeridos: [...MODELOS_PERMITIDOS]
            }
        });
    } catch (error) {
        console.error('Error GET /api/ia/config:', error);
        res.status(500).json({ success: false, message: 'Error al obtener la configuración de IA' });
    }
});

router.put('/config', verifyToken, requireAdmin, async (req, res) => {
    try {
        const row = await getEmpresaConfig(req.user.id_empresa);
        if (!row) {
            return res.status(404).json({ success: false, message: 'Configuración no encontrada' });
        }

        const fields = [];
        const values = [];

        if (req.body.modelo != null) {
            fields.push('gemini_modelo = ?');
            values.push(sanitizeModelo(req.body.modelo));
        }

        const incomingKey = typeof req.body.api_key === 'string' ? req.body.api_key.trim() : '';
        if (incomingKey) {
            fields.push('gemini_api_key = ?');
            values.push(encrypt(incomingKey));
        }

        if (fields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Nada para actualizar. Envía api_key y/o modelo.'
            });
        }

        values.push(req.user.id_empresa);
        const [r] = await pool.query(
            `UPDATE configuracion_empresa SET ${fields.join(', ')} WHERE id_empresa = ?`,
            values
        );
        if (r.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Configuración no encontrada' });
        }

        const updated = await getEmpresaConfig(req.user.id_empresa);
        const plain = decryptStoredKey(updated && updated.gemini_api_key);
        res.json({
            success: true,
            message: 'Configuración de IA guardada',
            data: {
                configurado: Boolean(plain),
                modelo: (updated && updated.gemini_modelo) || gemini.DEFAULT_MODEL,
                api_key_preview: plain ? maskSecret(plain) : null
            }
        });
    } catch (error) {
        console.error('Error PUT /api/ia/config:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Error al guardar la configuración de IA'
        });
    }
});

router.post('/config/probar', verifyToken, requireAdmin, async (req, res) => {
    try {
        const incomingKey = typeof req.body.api_key === 'string' ? req.body.api_key.trim() : '';
        let apiKey = incomingKey;
        let modelo;
        try {
            modelo = sanitizeModelo(req.body.modelo);
        } catch (err) {
            return res.status(400).json({ success: false, message: err.message });
        }

        if (!apiKey) {
            const row = await getEmpresaConfig(req.user.id_empresa);
            apiKey = decryptStoredKey(row && row.gemini_api_key);
            if (!req.body.modelo && row && row.gemini_modelo) {
                modelo = row.gemini_modelo;
            }
        }

        if (!apiKey) {
            return res.status(400).json({
                success: false,
                message: 'No hay API Key para probar. Pégala en el campo o guárdala primero.'
            });
        }

        const result = await gemini.ping(apiKey, modelo);
        const message = result.uso_fallback
            ? `Conexión correcta. Tu clave no admite el modelo recomendado; usa ${result.modelo}. Pulsa Guardar.`
            : 'Conexión con Gemini correcta. Ya puedes guardar.';
        res.json({
            success: true,
            message,
            data: result
        });
    } catch (error) {
        console.error('Error POST /api/ia/config/probar:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'No se pudo conectar con Gemini'
        });
    }
});

module.exports = router;
