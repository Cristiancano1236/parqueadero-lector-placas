/**
 * Migraciones ligeras al arranque (instalaciones existentes).
 */
const pool = require('./db');

async function ensureGeminiColumns() {
    try {
        await pool.query(
            'ALTER TABLE configuracion_empresa ADD COLUMN gemini_api_key TEXT NULL'
        );
        console.log('Migración: columna gemini_api_key agregada');
    } catch (err) {
        if (err && err.code !== 'ER_DUP_FIELDNAME') {
            console.warn('Migración gemini_api_key:', err.message);
        }
    }

    try {
        await pool.query(
            "ALTER TABLE configuracion_empresa ADD COLUMN gemini_modelo VARCHAR(50) NOT NULL DEFAULT 'gemini-3.1-flash-lite'"
        );
        console.log('Migración: columna gemini_modelo agregada');
    } catch (err) {
        if (err && err.code !== 'ER_DUP_FIELDNAME') {
            console.warn('Migración gemini_modelo:', err.message);
        }
    }

    const modelosLegados = {
        'gemini-1.5-flash': 'gemini-3.1-flash-lite',
        'gemini-1.5-flash-latest': 'gemini-3.1-flash-lite',
        'gemini-1.5-pro': 'gemini-3.1-pro-preview',
        'gemini-pro': 'gemini-3.1-pro-preview',
        'gemini-2.5-flash-lite': 'gemini-3.1-flash-lite',
        'gemini-2.5-flash': 'gemini-3.6-flash',
        'gemini-2.5-pro': 'gemini-3.1-pro-preview'
    };
    for (const [viejo, nuevo] of Object.entries(modelosLegados)) {
        try {
            const [r] = await pool.query(
                'UPDATE configuracion_empresa SET gemini_modelo = ? WHERE gemini_modelo = ?',
                [nuevo, viejo]
            );
            if (r.affectedRows > 0) {
                console.log(`Migración: modelo ${viejo} → ${nuevo} (${r.affectedRows})`);
            }
        } catch (err) {
            console.warn(`Migración modelo ${viejo}:`, err.message);
        }
    }
}

async function runStartupMigrations() {
    await ensureGeminiColumns();
}

module.exports = {
    runStartupMigrations,
    ensureGeminiColumns
};
