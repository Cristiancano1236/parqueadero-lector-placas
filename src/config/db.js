const mysql = require('mysql2/promise');
const { envPath } = require('../paths');

require('dotenv').config({
    path: envPath,
    override: true
});

const pool = mysql.createPool({
    host: (process.env.DB_HOST || 'localhost').trim(),
    user: (process.env.DB_USER || 'root').trim(),
    password: process.env.DB_PASSWORD == null ? '' : String(process.env.DB_PASSWORD),
    database: (process.env.DB_NAME || 'parqueadero').trim(),
    // Seguridad: evitar ejecución de múltiples sentencias por query
    multipleStatements: false,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;
