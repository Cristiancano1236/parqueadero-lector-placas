/**
 * Reconocimiento de placas colombianas con Gemini (Google AI).
 */
const { GoogleGenAI } = require('@google/genai');
const { extraerPlacaDeTexto, clasificarTipoPlaca, normalizarPlaca } = require('../utils/placa');

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const FALLBACK_MODELS = [
    'gemini-3.1-flash-lite',
    'gemini-3.6-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash'
];
const MAX_OUTPUT_TOKENS = 64;
const RETRY_DELAY_MS = 500;
const MAX_RETRIES_OVERLOAD = 1;
// Limita los tokens de imagen en modelos Gemini 3 para bajar latencia
// (MEDIUM = 256 tokens; suficiente para leer una placa). Cambiar a
// 'MEDIA_RESOLUTION_LOW' (64 tokens) si tras probar sigue sobrando margen.
const MEDIA_RESOLUTION = 'MEDIA_RESOLUTION_MEDIUM';

// Formato de salida compacto de una sola línea (más rápido que JSON con
// esquema: evita la decodificación restringida que añade latencia extra).
// Ejemplo: "OMG650;carro;95" o ";vacio;0" si no hay placa visible.
const SYSTEM_PROMPT = [
    'Eres un lector de placas vehiculares de Colombia.',
    'Analiza la imagen y extrae SOLO la placa del vehículo más cercano/visible.',
    'Formatos válidos:',
    '- Carro: 3 letras + 3 dígitos (ejemplo ABC123, OMG650).',
    '- Moto: 3 letras + 2 dígitos + 1 letra (ejemplo ABC12D).',
    'Ignora nombres de ciudades (BOGOTA, MEDELLIN, COLOMBIA, etc.), hologramas y texto de fondo.',
    'Normaliza a mayúsculas sin espacios ni guiones.',
    'Si no hay una placa clara, deja la placa vacía y usa confianza baja.',
    'No inventes caracteres que no veas.',
    'Responde ÚNICAMENTE con una línea en el formato PLACA;TIPO;CONFIANZA',
    '(TIPO es carro, moto o vacio; CONFIANZA es un entero 0-100). Sin explicaciones, sin JSON, sin texto adicional.'
].join(' ');

function detectMime(buffer) {
    if (!buffer || buffer.length < 4) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return 'image/png';
    }
    return 'image/jpeg';
}

function isOverloadedError(err) {
    const status = err && (err.status || err.statusCode || err.code);
    const msg = String((err && (err.message || err.statusMessage)) || '');
    const lower = msg.toLowerCase();
    return status === 503 || lower.includes('unavailable') || lower.includes('overloaded') || lower.includes('high demand');
}

function buildError(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function mapGeminiError(err) {
    const status = err && (err.status || err.statusCode || err.code);
    const msg = String((err && (err.message || err.statusMessage)) || '');
    const lower = msg.toLowerCase();

    if (status === 401 || status === 403 || lower.includes('api key') || lower.includes('permission') || lower.includes('unauthenticated')) {
        return buildError('API Key de Gemini inválida o sin permiso. Revisa la clave en Configuración.', 'GEMINI_AUTH');
    }
    if (status === 429 || lower.includes('quota') || lower.includes('rate limit') || lower.includes('resource exhausted')) {
        return buildError('Cuota o límite de Gemini agotado. Espera un momento o revisa tu plan en Google AI Studio.', 'GEMINI_QUOTA');
    }
    if (isOverloadedError(err)) {
        return buildError('Gemini está saturado en este momento. Reintentando automáticamente…', 'GEMINI_OVERLOADED');
    }
    if (status === 404 || lower.includes('not found') || lower.includes('is not found')) {
        return buildError(
            `Modelo de Gemini no disponible. Prueba con ${DEFAULT_MODEL} o gemini-3.6-flash.`,
            'GEMINI_MODEL_NOT_FOUND'
        );
    }
    if (lower.includes('fetch') || lower.includes('network') || lower.includes('enotfound') || lower.includes('econnrefused')) {
        return buildError('No hay conexión con Gemini. Verifica internet.', 'GEMINI_NETWORK');
    }
    return buildError(msg || 'Error al consultar Gemini', 'GEMINI_UNKNOWN');
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parsea la línea compacta "PLACA;TIPO;CONFIANZA". Tolera que el modelo
 * agregue espacios o una línea extra por accidente (se usa solo la primera
 * línea con al menos un separador `;`).
 */
function parseCompactLine(text) {
    if (!text) return null;
    const linea = String(text).split('\n').find((l) => l.includes(';')) || String(text);
    const partes = linea.split(';').map((p) => p.trim());
    if (partes.length < 2) return null;
    const [placa, tipo, confianza] = partes;
    return {
        placa: placa || '',
        tipo: (tipo || '').toLowerCase(),
        confianza: Number(confianza) || 0
    };
}

// Reutiliza una sola instancia de GoogleGenAI por API Key en vez de crear
// una nueva en cada petición.
const clientesPorApiKey = new Map();

function getClient(apiKey) {
    let client = clientesPorApiKey.get(apiKey);
    if (!client) {
        client = new GoogleGenAI({ apiKey });
        clientesPorApiKey.set(apiKey, client);
    }
    return client;
}

function thinkingConfigFor(modelo) {
    const name = String(modelo || DEFAULT_MODEL);
    if (name.startsWith('gemini-3')) {
        // Pro no admite "minimal"; lite/flash sí (menor latencia para placas).
        const level = name.includes('pro') ? 'low' : 'minimal';
        return { thinkingLevel: level };
    }
    return { thinkingBudget: 0 };
}

// Solo Gemini 3 soporta este campo de configuración; en 2.5 se omite.
function mediaResolutionFor(modelo) {
    const name = String(modelo || DEFAULT_MODEL);
    return name.startsWith('gemini-3') ? MEDIA_RESOLUTION : undefined;
}

async function generateContent(apiKey, modelo, contents, extraConfig = {}) {
    const ai = getClient(apiKey);
    const model = modelo || DEFAULT_MODEL;
    const mediaResolution = mediaResolutionFor(model);
    const config = {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: thinkingConfigFor(model),
        ...(mediaResolution ? { mediaResolution } : {}),
        ...extraConfig
    };

    let intentos = 0;
    while (true) {
        try {
            return await ai.models.generateContent({
                model,
                contents,
                config
            });
        } catch (err) {
            if (isOverloadedError(err) && intentos < MAX_RETRIES_OVERLOAD) {
                intentos += 1;
                await delay(RETRY_DELAY_MS);
                continue;
            }
            throw mapGeminiError(err);
        }
    }
}

/**
 * Comprueba que la API Key y el modelo responden.
 */
async function ping(apiKey, modelo) {
    if (!apiKey) throw new Error('Falta la API Key de Gemini');
    const requested = modelo || DEFAULT_MODEL;
    const candidates = [requested, ...FALLBACK_MODELS.filter((m) => m !== requested)];
    let lastError = null;

    for (const candidate of candidates) {
        try {
            const response = await generateContent(apiKey, candidate, 'Responde exactamente: OK');
            const text = String(response && response.text ? response.text : '').trim();
            return {
                ok: true,
                modelo: candidate,
                modelo_solicitado: requested,
                uso_fallback: candidate !== requested,
                respuesta: text.slice(0, 80)
            };
        } catch (err) {
            lastError = err;
            if (!err || err.code !== 'GEMINI_MODEL_NOT_FOUND') throw err;
        }
    }

    throw lastError || buildError(
        `Modelo de Gemini no disponible. Prueba con ${DEFAULT_MODEL}.`,
        'GEMINI_MODEL_NOT_FOUND'
    );
}

/**
 * Reconoce una placa en una imagen JPEG/PNG.
 * @returns {Promise<{ placa: string|null, tipo: string|null, textoCrudo: string, confianza: number }>}
 */
async function recognizePlate(imageBuffer, { apiKey, modelo } = {}) {
    if (!apiKey) throw new Error('Falta la API Key de Gemini');
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length < 32) {
        throw new Error('Imagen vacía');
    }

    const mimeType = detectMime(imageBuffer);
    const base64 = imageBuffer.toString('base64');

    const response = await generateContent(
        apiKey,
        modelo || DEFAULT_MODEL,
        [
            {
                role: 'user',
                parts: [
                    { text: SYSTEM_PROMPT },
                    { inlineData: { mimeType, data: base64 } }
                ]
            }
        ],
        { temperature: 0 }
    );

    const rawText = String(response && response.text ? response.text : '').trim();
    const parsed = parseCompactLine(rawText);

    let placa = null;
    let tipo = null;
    let confianza = 0;
    const textoCrudo = rawText;

    if (parsed) {
        confianza = Math.max(0, Math.min(100, parsed.confianza));
        const fromAi = extraerPlacaDeTexto(parsed.placa || '');
        if (fromAi) {
            placa = normalizarPlaca(fromAi);
            tipo = clasificarTipoPlaca(placa);
        }
    } else {
        const fromRaw = extraerPlacaDeTexto(rawText);
        if (fromRaw) {
            placa = fromRaw;
            tipo = clasificarTipoPlaca(placa);
            confianza = 60;
        }
    }

    if (!placa) {
        const fallback = extraerPlacaDeTexto(textoCrudo);
        if (fallback) {
            placa = fallback;
            tipo = clasificarTipoPlaca(placa);
            if (!confianza) confianza = 50;
        }
    }

    return {
        placa,
        tipo,
        textoCrudo,
        confianza: Math.round(confianza)
    };
}

module.exports = {
    DEFAULT_MODEL,
    FALLBACK_MODELS,
    recognizePlate,
    ping
};
