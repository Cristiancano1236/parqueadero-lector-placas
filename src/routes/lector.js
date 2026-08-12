const express = require('express');
const verifyToken = require('../middleware/auth');
const pool = require('../config/db');
const gemini = require('../services/geminiPlateOcr');
const { decrypt } = require('../utils/crypto');

const router = express.Router();

function decryptStoredKey(encrypted) {
    if (!encrypted) return null;
    try {
        return decrypt(encrypted);
    } catch (err) {
        console.error('No se pudo descifrar la API Key de Gemini:', err.message);
        return null;
    }
}

/**
 * POST /api/lector/reconocer
 * Body: raw JPEG/PNG bytes
 * Respuesta: { success, data: { placa, tipo, textoCrudo, confianza, ms } }
 */
router.post(
    '/reconocer',
    verifyToken,
    express.raw({
        type: ['image/jpeg', 'image/jpg', 'image/png', 'application/octet-stream', 'application/*'],
        limit: '6mb'
    }),
    async (req, res) => {
        try {
            const buffer = Buffer.isBuffer(req.body) ? req.body : null;
            if (!buffer || buffer.length < 32) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere una imagen JPEG/PNG en el cuerpo de la petición'
                });
            }

            const [rows] = await pool.query(
                'SELECT gemini_api_key, gemini_modelo FROM configuracion_empresa WHERE id_empresa = ?',
                [req.user.id_empresa]
            );
            const row = rows[0];
            const apiKey = decryptStoredKey(row && row.gemini_api_key);

            if (!apiKey) {
                return res.status(400).json({
                    success: false,
                    code: 'GEMINI_NOT_CONFIGURED',
                    message: 'Configura tu API Key de Gemini en Configuración → Inteligencia Artificial'
                });
            }

            const t0 = Date.now();
            const result = await gemini.recognizePlate(buffer, {
                apiKey,
                modelo: (row && row.gemini_modelo) || gemini.DEFAULT_MODEL
            });
            const ms = Date.now() - t0;

            return res.json({
                success: true,
                data: {
                    placa: result.placa,
                    tipo: result.tipo,
                    textoCrudo: result.textoCrudo,
                    confianza: result.confianza,
                    ms
                }
            });
        } catch (error) {
            console.error('Error en /api/lector/reconocer:', error.message || error);
            const statusByCode = {
                GEMINI_QUOTA: 429,
                GEMINI_OVERLOADED: 503,
                GEMINI_AUTH: 401,
                GEMINI_MODEL_NOT_FOUND: 404,
                GEMINI_NETWORK: 502
            };
            const status = statusByCode[error.code] || 500;
            return res.status(status).json({
                success: false,
                code: error.code,
                message: error.message || 'Error al reconocer la placa'
            });
        }
    }
);

module.exports = router;
