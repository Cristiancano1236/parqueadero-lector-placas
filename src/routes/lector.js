const express = require('express');
const verifyToken = require('../middleware/auth');
const plateOcr = require('../services/plateOcr');
const { extraerPlacaDeTexto, clasificarTipoPlaca } = require('../utils/placa');

const router = express.Router();

/**
 * POST /api/lector/reconocer
 * Body: raw JPEG/PNG bytes (Content-Type: image/jpeg | image/png | application/octet-stream)
 * Respuesta: { success, data: { placa, tipo, textoCrudo, confianza, items } }
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

            const t0 = Date.now();
            const { texto, confianza, items } = await plateOcr.recognizeText(buffer);
            const placa = extraerPlacaDeTexto(texto);
            const tipo = placa ? clasificarTipoPlaca(placa) : null;
            const ms = Date.now() - t0;

            return res.json({
                success: true,
                data: {
                    placa,
                    tipo,
                    textoCrudo: texto,
                    confianza,
                    items,
                    ms
                }
            });
        } catch (error) {
            console.error('Error en /api/lector/reconocer:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Error al reconocer la placa'
            });
        }
    }
);

module.exports = router;
