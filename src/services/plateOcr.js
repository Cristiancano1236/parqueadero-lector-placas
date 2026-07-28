/**
 * OCR de placas con PaddleOCR (ONNX) en el servidor.
 * Carga los modelos una sola vez (singleton) y reutiliza la sesión.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ort = require('onnxruntime-node');
const { PaddleOcrService } = require('paddleocr');
const { paddleOcrDir } = require('../paths');

const MODEL_DIR = paddleOcrDir;
const DET_PATH = path.join(MODEL_DIR, 'PP-OCRv5_mobile_det_infer.onnx');
const REC_PATH = path.join(MODEL_DIR, 'PP-OCRv5_mobile_rec_infer.onnx');
const DICT_PATH = path.join(MODEL_DIR, 'ppocrv5_dict.txt');

const CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

let ocrService = null;
let initPromise = null;

function toArrayBuffer(buf) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function ensureOcr() {
    if (ocrService && ocrService.isInitialized()) return ocrService;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        for (const p of [DET_PATH, REC_PATH, DICT_PATH]) {
            if (!fs.existsSync(p)) {
                throw new Error(`Modelo OCR no encontrado: ${p}`);
            }
        }

        const [detBuf, recBuf, dictText] = await Promise.all([
            fs.promises.readFile(DET_PATH),
            fs.promises.readFile(REC_PATH),
            fs.promises.readFile(DICT_PATH, 'utf8')
        ]);

        // El dict oficial incluye "" como CTC blank (índice 0). El modelo espera
        // 18385 clases; el archivo trae 18384 líneas → rellenamos 1 entrada.
        const charactersDictionary = dictText.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
        if (charactersDictionary[0] === '' || charactersDictionary[0] === 'blank') {
            while (charactersDictionary.length < 18385) charactersDictionary.push(' ');
        }

        const service = await PaddleOcrService.createInstance({
            ort,
            modelPreset: 'PP-OCRv5_mobile',
            detection: {
                modelBuffer: toArrayBuffer(detBuf)
            },
            recognition: {
                modelBuffer: toArrayBuffer(recBuf),
                charactersDictionary
            }
        });

        ocrService = service;
        return service;
    })().catch((err) => {
        initPromise = null;
        throw err;
    });

    return initPromise;
}

/**
 * Decodifica un buffer de imagen (JPEG/PNG) a píxeles RGB.
 */
async function decodeImage(buffer) {
    const { data, info } = await sharp(buffer)
        .rotate() // respeta EXIF orientation
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    return {
        width: info.width,
        height: info.height,
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    };
}

/**
 * Reconoce texto en una imagen.
 * @param {Buffer} imageBuffer JPEG/PNG
 * @returns {Promise<{ texto: string, confianza: number, items: Array<{text, confidence, box}> }>}
 */
async function recognizeText(imageBuffer) {
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
        throw new Error('Imagen vacía');
    }

    const service = await ensureOcr();
    const pixels = await decodeImage(imageBuffer);

    const results = await service.recognize(pixels, {
        charWhiteList: CHAR_WHITELIST.split(''),
        ordering: { sortByReadingOrder: true },
        detection: {
            // Un poco más permisivo para placas a distancia / con brillo
            boxScoreThreshold: 0.5,
            textPixelThreshold: 0.3
        }
    });

    const processed = service.processRecognition(results, {
        recognitionScoreThreshold: 0.4
    });

    const items = (results || [])
        .filter((r) => r && r.text && r.confidence > 0.2)
        .map((r) => ({
            text: r.text,
            confidence: r.confidence,
            box: r.box
        }));

    return {
        texto: processed?.text || items.map((i) => i.text).join(' '),
        confianza: Math.round((processed?.confidence || 0) * 100),
        items
    };
}

/**
 * Precarga los modelos (útil al arrancar el servidor).
 */
async function warmUp() {
    await ensureOcr();
}

module.exports = {
    recognizeText,
    warmUp,
    ensureOcr
};
