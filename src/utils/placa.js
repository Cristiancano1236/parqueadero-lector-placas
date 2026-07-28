/**
 * Utilidades de placa colombiana (carro / moto) — backend.
 */
const RE_CARRO = /^[A-Z]{3}\d{3}$/;
const RE_MOTO = /^[A-Z]{3}\d{2}[A-Z]$/;

const CIUDADES = [
    'MEDELLIN', 'BOGOTA', 'CALI', 'BARRANQUILLA', 'CARTAGENA', 'BUCARAMANGA',
    'CUCUTA', 'PEREIRA', 'MANIZALES', 'IBAGUE', 'VILLAVICENCIO', 'PASTO',
    'NEIVA', 'ARMENIA', 'COLOMBIA'
];

const LETTER_FIX = { '0': 'O', '1': 'I', '8': 'B', '5': 'S', '2': 'Z', '6': 'G' };
const DIGIT_FIX = { 'O': '0', 'Q': '0', 'D': '0', 'I': '1', 'L': '1', 'Z': '2', 'S': '5', 'B': '8', 'G': '6' };
const LAST_DIGIT_LOOKALIKES = { 'O': '0', 'Q': '0', 'I': '1' };

function normalizarPlaca(placa) {
    if (!placa) return '';
    return String(placa)
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z0-9]/g, '');
}

function quitarCiudades(texto) {
    let t = String(texto || '').toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    for (const c of CIUDADES) {
        t = t.split(c).join(' ');
    }
    return t;
}

function clasificarTipoPlaca(placa) {
    const p = normalizarPlaca(placa);
    if (RE_CARRO.test(p)) return 'carro';
    if (RE_MOTO.test(p)) return 'moto';
    return null;
}

function esPlacaValida(placa) {
    return clasificarTipoPlaca(placa) !== null;
}

function corregirCandidato(raw6) {
    const s = normalizarPlaca(raw6);
    if (s.length !== 6) return null;

    let carro = '';
    let okCarro = true;
    for (let i = 0; i < 6; i++) {
        const ch = s[i];
        if (i < 3) {
            const v = /[A-Z]/.test(ch) ? ch : (LETTER_FIX[ch] || null);
            if (!v) { okCarro = false; break; }
            carro += v;
        } else {
            const v = /[0-9]/.test(ch) ? ch : (DIGIT_FIX[ch] || null);
            if (!v) { okCarro = false; break; }
            carro += v;
        }
    }
    if (okCarro && RE_CARRO.test(carro)) return carro;

    let moto = '';
    let okMoto = true;
    for (let i = 0; i < 6; i++) {
        const ch = s[i];
        if (i < 3 || i === 5) {
            const v = /[A-Z]/.test(ch) ? ch : (LETTER_FIX[ch] || null);
            if (!v) { okMoto = false; break; }
            moto += v;
        } else {
            const v = /[0-9]/.test(ch) ? ch : (DIGIT_FIX[ch] || null);
            if (!v) { okMoto = false; break; }
            moto += v;
        }
    }
    if (okMoto && RE_MOTO.test(moto)) return moto;

    if (clasificarTipoPlaca(s)) return s;
    return null;
}

function extraerPlacaDeTexto(texto) {
    const limpio = normalizarPlaca(quitarCiudades(texto));
    if (!limpio) return null;

    if (limpio.length === 6) {
        if (clasificarTipoPlaca(limpio) === 'moto' && LAST_DIGIT_LOOKALIKES[limpio[5]]) {
            const asCarro = corregirCandidato(limpio);
            if (asCarro && clasificarTipoPlaca(asCarro) === 'carro') return asCarro;
        }
        if (clasificarTipoPlaca(limpio)) return limpio;
    } else if (clasificarTipoPlaca(limpio)) {
        return limpio;
    }

    const exactos = [];
    for (let i = 0; i <= limpio.length - 6; i++) {
        const slice = limpio.slice(i, i + 6);
        if (clasificarTipoPlaca(slice)) exactos.push(slice);
    }
    if (exactos.length) {
        const preferidos = exactos.map((p) => {
            if (clasificarTipoPlaca(p) === 'moto' && LAST_DIGIT_LOOKALIKES[p[5]]) {
                const asCarro = corregirCandidato(p);
                if (asCarro && clasificarTipoPlaca(asCarro) === 'carro') return asCarro;
            }
            return p;
        });
        return preferidos.find((p) => clasificarTipoPlaca(p) === 'carro') || preferidos[0];
    }

    const corregidos = [];
    for (let i = 0; i <= limpio.length - 6; i++) {
        const fixed = corregirCandidato(limpio.slice(i, i + 6));
        if (fixed) corregidos.push(fixed);
    }
    if (!corregidos.length) return null;
    return corregidos.find((p) => clasificarTipoPlaca(p) === 'carro') || corregidos[0];
}

module.exports = {
    RE_CARRO,
    RE_MOTO,
    normalizarPlaca,
    clasificarTipoPlaca,
    esPlacaValida,
    extraerPlacaDeTexto
};
