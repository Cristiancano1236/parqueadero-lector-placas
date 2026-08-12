/**
 * Resuelve la raíz del proyecto en desarrollo y en distribución empaquetada/portable.
 * - Desarrollo: carpeta del repo (padre de src/)
 * - Portable / junto al .exe: directorio desde el que se ejecuta la app
 */
const path = require('path');
const fs = require('fs');

function findProjectRoot() {
    // 1) Ejecutable pkg: carpeta del .exe
    if (process.pkg) {
        return path.dirname(process.execPath);
    }

    // 2) Variable explícita (útil en pruebas)
    if (process.env.PARQUEADERO_ROOT) {
        return path.resolve(process.env.PARQUEADERO_ROOT);
    }

    // 3) Subir desde este archivo (src/paths.js -> raíz)
    const fromFile = path.join(__dirname, '..');

    // 4) Si estamos en dist/src, la raíz útil es dist/ (donde está public/)
    const candidates = [
        fromFile,
        process.cwd()
    ];

    for (const root of candidates) {
        const hasPublic = fs.existsSync(path.join(root, 'public'));
        const hasEnv = fs.existsSync(path.join(root, '.env')) || fs.existsSync(path.join(root, '.env.example'));
        if (hasPublic || hasEnv) {
            return root;
        }
    }

    return fromFile;
}

const projectRoot = findProjectRoot();

module.exports = {
    projectRoot,
    publicDir: path.join(projectRoot, 'public'),
    certsDir: path.join(projectRoot, 'certs'),
    envPath: path.join(projectRoot, '.env')
};
