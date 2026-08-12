/**
 * Cifrado simétrico AES-256-GCM para secretos en BD (API keys, etc.).
 * Clave: APP_ENCRYPTION_KEY; si falta, se deriva de JWT_SECRET.
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SALT = 'parksystem-gemini-v1';

let cachedKey = null;
let warnedMissingAppKey = false;

function getKeyMaterial() {
    const appKey = String(process.env.APP_ENCRYPTION_KEY || '').trim();
    if (appKey) return appKey;

    if (!warnedMissingAppKey) {
        warnedMissingAppKey = true;
        console.warn(
            'APP_ENCRYPTION_KEY no está definida. Se usa JWT_SECRET para cifrar credenciales. ' +
            'Configúrala en .env para producción.'
        );
    }
    return String(process.env.JWT_SECRET || 'tu_secreto_jwt');
}

function getKey() {
    if (cachedKey) return cachedKey;
    cachedKey = crypto.scryptSync(getKeyMaterial(), SALT, KEY_LEN);
    return cachedKey;
}

function encrypt(text) {
    if (text == null) return null;
    const plain = String(text);
    if (!plain) return null;
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(payload) {
    if (payload == null || payload === '') return null;
    const buf = Buffer.from(String(payload), 'base64');
    if (buf.length < IV_LEN + TAG_LEN + 1) {
        throw new Error('Payload cifrado inválido');
    }
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function maskSecret(secret) {
    const s = String(secret || '');
    if (!s) return null;
    if (s.length <= 8) return '••••';
    return `${s.slice(0, 4)}••••••••${s.slice(-4)}`;
}

module.exports = {
    encrypt,
    decrypt,
    maskSecret
};
