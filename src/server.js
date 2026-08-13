const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { projectRoot, publicDir, certsDir, envPath } = require('./paths');

require('dotenv').config({ path: envPath, override: true });

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(publicDir));

// Rutas API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/vehiculos', require('./routes/vehiculos'));
app.use('/api/movimientos', require('./routes/movimientos'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/empresa', require('./routes/empresa'));
app.use('/api/tipos-vehiculos', require('./routes/tipos-vehiculos'));
app.use('/api/tarifas', require('./routes/tarifas'));
app.use('/api/pagos', require('./routes/pagos'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/reportes', require('./routes/reportes'));
app.use('/api/turnos', require('./routes/turnos'));
app.use('/api/mensualidades', require('./routes/mensualidades'));
app.use('/api/lector', require('./routes/lector'));
app.use('/api/ia', require('./routes/iaConfig'));

// Rutas de vistas
app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/admin/dashboard', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/dashboard.html'));
});

app.get('/admin/vehiculos', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/vehiculos.html'));
});

app.get('/admin/usuarios', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/usuarios.html'));
});

app.get('/admin/mensualidades', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/mensualidades.html'));
});
app.get('/admin/mensualidades.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/mensualidades.html'));
});

app.get('/operador/dashboard', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/dashboard.html'));
});

app.get('/operador/vehiculos', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/vehiculos.html'));
});

// Rutas espejo con sufijo .html para compatibilidad con enlaces relativos
app.get('/operador/dashboard.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/dashboard.html'));
});
app.get('/operador/vehiculos.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/vehiculos.html'));
});
app.get('/operador/ingreso-salida.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/ingreso-salida.html'));
});
app.get('/operador/ingreso-salida', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/ingreso-salida.html'));
});
app.get('/admin/ingreso-salida', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/ingreso-salida.html'));
});
app.get('/admin/ingreso-salida.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/ingreso-salida.html'));
});
app.get('/admin/lector-placas', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/lector-placas.html'));
});
app.get('/admin/lector-placas.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/lector-placas.html'));
});
app.get('/operador/lector-placas', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/lector-placas.html'));
});
app.get('/operador/lector-placas.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/lector-placas.html'));
});
app.get('/admin/tarifas', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/tarifas.html'));
});
app.get('/admin/tarifas.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/tarifas.html'));
});

app.get('/admin/reportes', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/reportes.html'));
});
app.get('/admin/reportes.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/reportes.html'));
});

app.get('/admin/configuracion', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/configuracion.html'));
});
app.get('/admin/configuracion.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/configuracion.html'));
});

app.get('/admin/tipos-vehiculos', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/tipos-vehiculos.html'));
});
app.get('/admin/tipos-vehiculos.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/tipos-vehiculos.html'));
});

app.get('/setup-movil', (req, res) => {
    res.sendFile(path.join(publicDir, 'setup-movil.html'));
});
app.get('/setup-movil.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'setup-movil.html'));
});

// Manejo de rutas no encontradas
app.use((req, res) => {
    res.status(404).sendFile(path.join(publicDir, '404.html'));
});

const PORT = process.env.PORT || 3000;
const PORT_SETUP = process.env.PORT_SETUP || 3080;
const certPath = path.join(certsDir, 'dev-cert.pem');
const keyPath = path.join(certsDir, 'dev-key.pem');
const httpsFlag = String(process.env.HTTPS || '').trim().toLowerCase();
const forceHttps = httpsFlag === 'true' || httpsFlag === '1';
const forceHttp = httpsFlag === 'false' || httpsFlag === '0';
const hasCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);

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

function runAfterListen() {
    require('./config/migrate').runStartupMigrations()
        .then(() => console.log('Migraciones de esquema: OK'))
        .catch((err) => console.warn('Migraciones de esquema:', err.message));

    try {
        require('./services/setupHttpServer').startSetupServer({
            port: PORT_SETUP,
            appPort: PORT,
            useHttps
        });
    } catch (err) {
        console.warn('Servidor de guía móvil:', err.message);
    }
}

function imprimirUrls(protocol) {
    console.log(`Servidor corriendo en el puerto ${PORT} (${protocol.toUpperCase()})`);
    console.log(`Local:   ${protocol}://localhost:${PORT}`);
    const ips = obtenerIpsLocales();
    if (ips.length === 0) {
        console.log('Red:     (no se detectó IP de red local)');
    } else {
        ips.forEach((ip) => {
            console.log(`Móvil:   ${protocol}://${ip}:${PORT}`);
        });
    }
    console.log(`Raíz:    ${projectRoot}`);
    console.log(`Conectar celular: http://localhost:${PORT_SETUP}/`);
}

if (forceHttps && !hasCerts) {
    console.error('HTTPS=true pero faltan certificados en certs/.');
    console.error('Ejecuta Preparar-HTTPS.bat (o npm run certs) como administrador.');
    process.exit(1);
}

// HTTPS automático si hay certs; HTTPS=true fuerza; HTTPS=false fuerza HTTP
const useHttps = !forceHttp && (forceHttps || hasCerts);

if (useHttps) {
    const credentials = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };
    https.createServer(credentials, app).listen(PORT, '0.0.0.0', () => {
        imprimirUrls('https');
        runAfterListen();
    });
} else {
    if (!hasCerts) {
        console.log('Aviso: sin certificados en certs/. Usando HTTP. Para HTTPS: Preparar-HTTPS.bat o npm run certs');
    }
    http.createServer(app).listen(PORT, '0.0.0.0', () => {
        imprimirUrls('http');
        runAfterListen();
    });
}
