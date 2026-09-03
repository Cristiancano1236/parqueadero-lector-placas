/**
 * Utilidades de red local (IP LAN del servidor).
 * Usado para mostrar URLs de acceso (móvil, guía de conexión, webhook ANPR).
 */
const os = require('os');

function obtenerIpsLocales() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const infos of Object.values(interfaces)) {
        if (!infos) continue;
        for (const info of infos) {
            if ((info.family === 'IPv4' || info.family === 4) && !info.internal) {
                ips.push(info.address);
            }
        }
    }
    return ips;
}

module.exports = { obtenerIpsLocales };
