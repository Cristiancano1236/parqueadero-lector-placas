/**
 * Servidor HTTP auxiliar (puerto 3080): solo guía móvil y descarga de CA.
 * No monta APIs de negocio.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { publicDir, certsDir } = require('../paths');

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

function startSetupServer({ port, appPort, useHttps }) {
    const setupPort = Number(port) || 3080;
    const mainPort = Number(appPort) || 3000;
    const protocol = useHttps ? 'https' : 'http';
    const caPath = path.join(certsDir, 'rootCA.pem');
    const setupPage = path.join(publicDir, 'setup-movil.html');

    const server = http.createServer((req, res) => {
        const url = String(req.url || '/').split('?')[0];

        if (url === '/ca.crt' || url === '/ca.pem') {
            if (!fs.existsSync(caPath)) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('CA no encontrada. Ejecuta Preparar-HTTPS.bat como administrador.');
                return;
            }
            const body = fs.readFileSync(caPath);
            res.writeHead(200, {
                'Content-Type': 'application/x-x509-ca-cert',
                'Content-Disposition': 'attachment; filename="ParkSystem-CA.crt"',
                'Content-Length': body.length,
                'Cache-Control': 'no-store'
            });
            res.end(body);
            return;
        }

        if (url === '/info') {
            const ips = obtenerIpsLocales();
            const hasCa = fs.existsSync(caPath);
            const payload = {
                ok: true,
                hasCa,
                appPort: mainPort,
                setupPort,
                protocol,
                ips,
                lectorUrls: ips.map((ip) => `${protocol}://${ip}:${mainPort}/admin/lector-placas.html`),
                caUrls: ips.map((ip) => `http://${ip}:${setupPort}/ca.crt`),
                setupUrls: ips.map((ip) => `http://${ip}:${setupPort}/`)
            };
            const body = Buffer.from(JSON.stringify(payload), 'utf8');
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': body.length,
                'Cache-Control': 'no-store'
            });
            res.end(body);
            return;
        }

        if (url.startsWith('/vendor/')) {
            const safe = path.normalize(url.replace(/^\/+/, '')).replace(/^(\.\.(\/|\\|$))+/, '');
            const filePath = path.join(publicDir, safe);
            if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not found');
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            const types = {
                '.js': 'application/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.png': 'image/png',
                '.svg': 'image/svg+xml'
            };
            const body = fs.readFileSync(filePath);
            res.writeHead(200, {
                'Content-Type': types[ext] || 'application/octet-stream',
                'Content-Length': body.length,
                'Cache-Control': 'public, max-age=3600'
            });
            res.end(body);
            return;
        }

        if (url === '/' || url === '/setup-movil.html' || url === '/index.html') {
            if (!fs.existsSync(setupPage)) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Falta setup-movil.html');
                return;
            }
            const body = fs.readFileSync(setupPage);
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': body.length,
                'Cache-Control': 'no-store'
            });
            res.end(body);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    });

    server.listen(setupPort, '0.0.0.0', () => {
        console.log(`Guía móvil / CA: http://localhost:${setupPort}/  (solo HTTP auxiliar)`);
        const ips = obtenerIpsLocales();
        ips.forEach((ip) => {
            console.log(`  CA móvil: http://${ip}:${setupPort}/ca.crt`);
        });
    });

    server.on('error', (err) => {
        console.warn(`No se pudo abrir el puerto de setup ${setupPort}:`, err.message);
    });

    return server;
}

module.exports = {
    startSetupServer,
    obtenerIpsLocales
};
