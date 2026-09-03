(function () {
    const token = localStorage.getItem('token');

    const btnRun = document.getElementById('btnRun');
    const runStatus = document.getElementById('runStatus');
    const summaryBox = document.getElementById('summaryBox');
    const resultsBody = document.getElementById('resultsBody');

    const THRESHOLD_MS = 2000;
    const MAX_UPLOAD_WIDTH = 960;
    const PREVIEW_ASPECT = 16 / 10;
    const JPEG_QUALITY = 0.82;
    const GAP_BETWEEN_CALLS_MS = 4000;
    const QUOTA_WAIT_MS = 20000;
    const OVERLOAD_WAIT_MS = 4000;

    // Placas de referencia. `expected: null` = caso sin valor exacto verificable
    // (se revisa a ojo), no cuenta para el resumen de aciertos.
    const TESTS = [
        { src: 'placa-qfo640.png', expected: 'QFO640', label: 'QFO640' },
        { src: 'placa-omg650.png', expected: 'OMG650', label: 'OMG650' },
        { src: 'placa-cee015.png', expected: 'CEE015', label: 'CEE015' },
        { src: 'placa-parcial-doble.png', expected: null, label: 'Doble placa parcial' }
    ];

    // "enfocada" = baseline; las otras dos simulan un vehículo en movimiento:
    // barrido horizontal (motion blur) + recorte levemente descentrado.
    const VARIANTS = [
        { key: 'Enfocada', blurPx: 0, offsetFrac: 0 },
        { key: 'Movimiento leve', blurPx: 5, offsetFrac: 0.04 },
        { key: 'Movimiento fuerte', blurPx: 16, offsetFrac: 0.09 }
    ];

    function coverCropRect(w, h, targetAspect) {
        const srcAspect = w / h;
        if (srcAspect > targetAspect) {
            const cw = Math.round(h * targetAspect);
            const sx = Math.round((w - cw) / 2);
            return { sx, sy: 0, sw: cw, sh: h };
        }
        const ch = Math.round(w / targetAspect);
        const sy = Math.round((h - ch) / 2);
        return { sx: 0, sy, sw: w, sh: ch };
    }

    /**
     * Dibuja `bitmap` recortado a `PREVIEW_ASPECT` (igual que el lector real),
     * con un pequeño desplazamiento del punto de recorte (simula que el
     * vehículo no queda perfectamente centrado) y le aplica un barrido de
     * movimiento horizontal dibujando varias copias desplazadas con alpha bajo.
     */
    function buildVariantCanvas(bitmap, offsetFrac, blurPx) {
        const crop = coverCropRect(bitmap.width, bitmap.height, PREVIEW_ASPECT);
        const offsetX = Math.round(crop.sw * offsetFrac);
        const sx = Math.max(0, Math.min(bitmap.width - crop.sw, crop.sx + offsetX));

        const scale = Math.min(1, MAX_UPLOAD_WIDTH / crop.sw);
        const tw = Math.max(1, Math.floor(crop.sw * scale));
        const th = Math.max(1, Math.floor(crop.sh * scale));

        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext('2d');

        if (blurPx <= 0) {
            ctx.drawImage(bitmap, sx, crop.sy, crop.sw, crop.sh, 0, 0, tw, th);
            return canvas;
        }

        const pasos = 6;
        ctx.globalAlpha = 1 / pasos;
        for (let i = 0; i < pasos; i++) {
            const dx = Math.round((i - (pasos - 1) / 2) * (blurPx / pasos) * scale);
            ctx.drawImage(bitmap, sx, crop.sy, crop.sw, crop.sh, dx, 0, tw, th);
        }
        ctx.globalAlpha = 1;
        return canvas;
    }

    function canvasToJpegBlob(canvas) {
        return new Promise((resolve) => {
            canvas.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY);
        });
    }

    async function reconocer(blob) {
        const res = await fetch('/api/lector/reconocer', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'image/jpeg'
            },
            body: blob
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.message || `Error OCR (${res.status})`);
            err.code = data.code;
            throw err;
        }
        return data.data || {};
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Igual que en el lector real: si Gemini responde cuota agotada o
     * saturado, espera y reintenta una vez en vez de reportar fallo directo.
     */
    async function reconocerConBackoff(blob) {
        try {
            return await reconocer(blob);
        } catch (err) {
            if (err.code === 'GEMINI_QUOTA') {
                runStatus.textContent = 'Límite de Gemini alcanzado, esperando para reintentar…';
                await delay(QUOTA_WAIT_MS);
                return reconocer(blob);
            }
            if (err.code === 'GEMINI_OVERLOADED') {
                await delay(OVERLOAD_WAIT_MS);
                return reconocer(blob);
            }
            throw err;
        }
    }

    function addRow({ label, variante, previewUrl, esperado, obtenido, confianza, ms, msServidor, ok, informativo, mensaje }) {
        const tr = document.createElement('tr');
        const resultadoHtml = informativo
            ? '<span class="badge bg-secondary">Revisión manual</span>'
            : `<span class="badge ${ok ? 'bg-success' : 'bg-danger'} ok-badge">${ok ? 'OK' : 'FALLÓ'}</span>`;
        tr.innerHTML = `
            <td>${label}</td>
            <td>${variante}</td>
            <td>${previewUrl ? `<img src="${previewUrl}" class="thumb" alt="preview">` : '—'}</td>
            <td>${esperado ?? '—'}</td>
            <td>${obtenido || (mensaje ? `<span class="text-danger">${mensaje}</span>` : '(sin lectura)')}</td>
            <td>${confianza != null ? `${confianza}%` : '—'}</td>
            <td class="${ms != null && ms > THRESHOLD_MS ? 'text-warning fw-semibold' : ''}">${ms != null ? `${ms} ms` : '—'}</td>
            <td>${msServidor != null ? `${msServidor} ms` : '—'}</td>
            <td>${resultadoHtml}</td>
        `;
        resultsBody.appendChild(tr);
    }

    async function runOne(test, variant) {
        const res = await fetch(test.src + '?ts=' + Date.now());
        if (!res.ok) throw new Error('No se pudo cargar ' + test.src);
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = buildVariantCanvas(bitmap, variant.offsetFrac, variant.blurPx);
        if (typeof bitmap.close === 'function') bitmap.close();
        const previewUrl = canvas.toDataURL('image/jpeg', 0.5);
        const uploadBlob = await canvasToJpegBlob(canvas);

        const t0 = performance.now();
        try {
            const result = await reconocerConBackoff(uploadBlob);
            const ms = Math.round(performance.now() - t0);
            const informativo = test.expected == null;
            const ok = !informativo && result.placa === test.expected && ms < THRESHOLD_MS;
            addRow({
                label: test.label,
                variante: variant.key,
                previewUrl,
                esperado: test.expected,
                obtenido: result.placa,
                confianza: result.confianza,
                ms,
                msServidor: result.ms,
                ok,
                informativo
            });
            return { ok, informativo, ms };
        } catch (err) {
            const ms = Math.round(performance.now() - t0);
            addRow({
                label: test.label,
                variante: variant.key,
                previewUrl,
                esperado: test.expected,
                obtenido: null,
                confianza: null,
                ms,
                ok: false,
                informativo: test.expected == null,
                mensaje: err.message || 'Error'
            });
            return { ok: false, informativo: test.expected == null, ms };
        }
    }

    async function runAll() {
        btnRun.disabled = true;
        resultsBody.innerHTML = '';
        summaryBox.textContent = '';
        const resumen = [];

        for (const test of TESTS) {
            for (const variant of VARIANTS) {
                runStatus.textContent = `Probando ${test.label} — ${variant.key}…`;
                const r = await runOne(test, variant);
                resumen.push(r);
                await delay(GAP_BETWEEN_CALLS_MS);
            }
        }

        const evaluables = resumen.filter((r) => !r.informativo);
        const aciertos = evaluables.filter((r) => r.ok).length;
        const tiempos = evaluables.map((r) => r.ms);
        const prom = tiempos.length ? Math.round(tiempos.reduce((a, b) => a + b, 0) / tiempos.length) : 0;
        const max = tiempos.length ? Math.max(...tiempos) : 0;

        runStatus.textContent = 'Pruebas finalizadas.';
        summaryBox.textContent = `Aciertos: ${aciertos}/${evaluables.length} · Promedio: ${prom} ms · Máximo: ${max} ms`;
        btnRun.disabled = false;
    }

    btnRun.addEventListener('click', () => {
        runAll().catch((err) => {
            console.error(err);
            runStatus.textContent = 'Error al ejecutar las pruebas: ' + (err.message || err);
            btnRun.disabled = false;
        });
    });
})();
