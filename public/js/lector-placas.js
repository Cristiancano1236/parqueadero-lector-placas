(function () {
    const token = localStorage.getItem('token');
    const userName = localStorage.getItem('userName') || 'Usuario';
    const userNameEl = document.getElementById('userName');
    if (userNameEl) userNameEl.textContent = userName;

    document.querySelector('.sidebar-toggle')?.addEventListener('click', () => {
        document.querySelector('.sidebar')?.classList.toggle('show');
    });
    document.getElementById('btnLogout')?.addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.clear();
        window.location.href = '/';
    });

    try {
        const rol = localStorage.getItem('rol') || localStorage.getItem('role') || localStorage.getItem('userRole');
        if (rol && rol !== 'admin') {
            document.querySelectorAll('.admin-only').forEach((el) => { el.style.display = 'none'; });
        }
    } catch (_) {}

    const video = document.getElementById('videoCam');
    const workCanvas = document.getElementById('workCanvas');
    const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    const placaDetectadaEl = document.getElementById('placaDetectada');
    const tipoDetectadoEl = document.getElementById('tipoDetectado');
    const confianzaOcrEl = document.getElementById('confianzaOcr');
    const statusPill = document.getElementById('statusPill');
    const msgBox = document.getElementById('msgBox');
    const placaManual = document.getElementById('placaManual');
    const btnStart = document.getElementById('btnStartCam');
    const btnStop = document.getElementById('btnStopCam');
    const btnManual = document.getElementById('btnIngresoManual');
    const btnTestRef = document.getElementById('btnTestRef');
    const ultimoIngresoBox = document.getElementById('ultimoIngresoBox');
    const ultimoIngresoBody = document.getElementById('ultimoIngresoBody');
    const chkDebug = document.getElementById('chkDebug');
    const debugPanel = document.getElementById('debugPanel');
    const debugThumbBox = document.getElementById('debugThumbBox');
    const debugRawText = document.getElementById('debugRawText');

    const OCR_INTERVAL_MS = 700;
    const COOLDOWN_MS = 10000;
    const MAX_UPLOAD_WIDTH = 960;
    const JPEG_QUALITY = 0.82;
    const CONSENSUS_LEN = 5;
    const CONSENSUS_MIN = 4;
    const CONSENSUS_RATIO = 0.6;
    const DEBUG_KEY = 'lector_debug_enabled';

    let stream = null;
    let imageCapture = null;
    let ocrLoopTimer = null;
    let scanning = false;
    let busyOcr = false;
    let busyIngreso = false;
    let placaBuffer = [];
    let lastIngresoAt = new Map();
    let ultimoIngreso = null;
    let empresaInfo = null;
    let debugCanvasEl = null;

    function setStatus(kind, text) {
        const map = {
            idle: 'status-idle',
            scanning: 'status-scanning',
            ok: 'status-ok',
            warn: 'status-warn',
            err: 'status-err'
        };
        statusPill.className = `status-pill ${map[kind] || map.idle}`;
        statusPill.innerHTML = `<i class="fas fa-circle"></i> ${text}`;
    }

    function showMsg(type, text) {
        msgBox.className = `alert alert-${type}`;
        msgBox.textContent = text;
        msgBox.classList.remove('d-none');
    }

    function hideMsg() {
        msgBox.classList.add('d-none');
    }

    function beep(ok) {
        try {
            const ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctxAudio.createOscillator();
            const gain = ctxAudio.createGain();
            osc.connect(gain);
            gain.connect(ctxAudio.destination);
            osc.frequency.value = ok ? 880 : 220;
            gain.gain.value = 0.08;
            osc.start();
            setTimeout(() => {
                osc.stop();
                ctxAudio.close();
            }, ok ? 120 : 250);
        } catch (_) {}
    }

    function updatePlacaUi(placa) {
        const tipo = placa ? PlacaUtils.clasificarTipoPlaca(placa) : null;
        placaDetectadaEl.textContent = placa || '------';
        if (tipo === 'carro') {
            tipoDetectadoEl.className = 'badge bg-primary';
            tipoDetectadoEl.textContent = 'Carro';
        } else if (tipo === 'moto') {
            tipoDetectadoEl.className = 'badge bg-success';
            tipoDetectadoEl.textContent = 'Moto';
        } else {
            tipoDetectadoEl.className = 'badge bg-secondary';
            tipoDetectadoEl.textContent = '—';
        }
    }

    // ---------- Depuración ----------

    function ensureDebugCanvas() {
        if (!debugCanvasEl) {
            debugCanvasEl = document.createElement('canvas');
            debugThumbBox.innerHTML = '';
            debugThumbBox.appendChild(debugCanvasEl);
        }
        return debugCanvasEl;
    }

    function updateDebugView(sourceCanvas, rawText, ms) {
        if (!chkDebug.checked || !sourceCanvas) return;
        const c = ensureDebugCanvas();
        const maxW = 220;
        const scale = Math.min(1, maxW / sourceCanvas.width);
        c.width = Math.max(1, Math.floor(sourceCanvas.width * scale));
        c.height = Math.max(1, Math.floor(sourceCanvas.height * scale));
        c.getContext('2d').drawImage(sourceCanvas, 0, 0, c.width, c.height);
        const rawTrim = rawText ? String(rawText).replace(/\s+/g, ' ').trim() : '';
        debugRawText.textContent = [
            'Motor: PaddleOCR (servidor)',
            ms != null ? `${ms} ms` : '',
            rawTrim && `OCR crudo: ${rawTrim}`
        ].filter(Boolean).join(' · ');
    }

    chkDebug.checked = localStorage.getItem(DEBUG_KEY) !== '0';
    debugPanel.classList.toggle('d-none', !chkDebug.checked);
    chkDebug.addEventListener('change', () => {
        localStorage.setItem(DEBUG_KEY, chkDebug.checked ? '1' : '0');
        debugPanel.classList.toggle('d-none', !chkDebug.checked);
    });

    // ---------- Consenso multi-frame ----------

    function sharesEnough(a, b) {
        if (!a || !b || a.length !== b.length) return false;
        let matches = 0;
        for (let i = 0; i < a.length; i++) if (a[i] === b[i]) matches++;
        return matches >= 3;
    }

    function pushToBuffer(placa) {
        if (placaBuffer.length && !sharesEnough(placa, placaBuffer[placaBuffer.length - 1])) {
            placaBuffer = [];
        }
        placaBuffer.push(placa);
        if (placaBuffer.length > CONSENSUS_LEN) placaBuffer.shift();
    }

    function computeConsensus() {
        if (placaBuffer.length < CONSENSUS_MIN) return null;
        const length = 6;
        let winner = '';
        for (let i = 0; i < length; i++) {
            const counts = {};
            for (const p of placaBuffer) {
                const c = p[i];
                counts[c] = (counts[c] || 0) + 1;
            }
            let bestChar = null;
            let bestCount = -1;
            for (const c of Object.keys(counts)) {
                if (counts[c] > bestCount) {
                    bestCount = counts[c];
                    bestChar = c;
                }
            }
            winner += bestChar;
        }
        if (!PlacaUtils.esPlacaValida(winner)) return null;
        const matches = placaBuffer.filter((p) => p === winner).length;
        if (matches / placaBuffer.length >= CONSENSUS_RATIO) return winner;
        return null;
    }

    // ---------- Empresa ----------

    async function ensureEmpresaConfig() {
        if (empresaInfo) return;
        try {
            const res = await fetch('/api/empresa/me', {
                headers: { Authorization: `Bearer ${token}` }
            });
            const j = await res.json();
            if (res.ok && j.success) empresaInfo = j.data;
        } catch (_) {}
    }

    // ---------- Captura de frames ----------

    function drawSourceToCanvas(source, w, h, maxW = MAX_UPLOAD_WIDTH) {
        if (!w || !h) return null;
        const scale = Math.min(1, maxW / w);
        const tw = Math.max(1, Math.floor(w * scale));
        const th = Math.max(1, Math.floor(h * scale));
        workCanvas.width = tw;
        workCanvas.height = th;
        workCtx.drawImage(source, 0, 0, tw, th);
        return workCanvas;
    }

    async function captureFullResSource() {
        if (imageCapture) {
            try {
                const bitmap = await imageCapture.grabFrame();
                const canvas = drawSourceToCanvas(bitmap, bitmap.width, bitmap.height);
                if (typeof bitmap.close === 'function') bitmap.close();
                if (canvas) return canvas;
            } catch (_) {}
        }
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) return null;
        return drawSourceToCanvas(video, vw, vh);
    }

    function canvasToJpegBlob(canvas) {
        return new Promise((resolve) => {
            canvas.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY);
        });
    }

    /**
     * Sube un frame al servidor para OCR con PaddleOCR.
     * @returns {Promise<{ placa: string|null, tipo: string|null, textoCrudo: string, confianza: number, ms: number }>}
     */
    async function reconocerEnServidor(blobOrBuffer) {
        const res = await fetch('/api/lector/reconocer', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'image/jpeg'
            },
            body: blobOrBuffer
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.message || `Error OCR (${res.status})`);
        }
        return data.data || {};
    }

    // ---------- Ingreso ----------

    async function registrarIngreso(placaRaw, { fromManual = false } = {}) {
        const placa = PlacaUtils.normalizarPlaca(placaRaw);
        const tipo = PlacaUtils.clasificarTipoPlaca(placa);
        if (!tipo) {
            showMsg('warning', 'Placa inválida. Carro: ABC123 · Moto: ABC12D');
            setStatus('warn', 'Placa inválida');
            beep(false);
            return;
        }

        const now = Date.now();
        const last = lastIngresoAt.get(placa) || 0;
        if (!fromManual && now - last < COOLDOWN_MS) {
            setStatus('warn', `Cooldown ${placa}`);
            return;
        }

        if (busyIngreso) return;
        busyIngreso = true;
        hideMsg();
        updatePlacaUi(placa);
        setStatus('scanning', 'Registrando ingreso…');

        try {
            await ensureEmpresaConfig();
            const res = await fetch('/api/movimientos/ingreso', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ placa, auto_tipo: true })
            });
            const data = await res.json();

            if (res.status === 409) {
                lastIngresoAt.set(placa, Date.now());
                showMsg('warning', data.message || 'El vehículo ya está dentro');
                setStatus('warn', 'Ya está dentro');
                beep(false);
                return;
            }

            if (!res.ok) {
                showMsg('danger', data.message || 'Error al registrar ingreso');
                setStatus('err', 'Error de ingreso');
                beep(false);
                return;
            }

            lastIngresoAt.set(placa, Date.now());
            ultimoIngreso = data.data;
            showMsg('success', `Ingreso OK: ${data.data.placa} (${data.data.tipo})`);
            setStatus('ok', 'Ingreso registrado');
            beep(true);

            ultimoIngresoBody.innerHTML = `
                <div><strong>Placa:</strong> ${data.data.placa}</div>
                <div><strong>Tipo:</strong> ${data.data.tipo}</div>
                <div><strong>Movimiento:</strong> #${data.data.movimientoId}</div>
                <div><strong>Entrada:</strong> ${new Date(data.data.fechaEntrada).toLocaleString('es-CO')}</div>
            `;
            ultimoIngresoBox.classList.remove('d-none');
        } catch (err) {
            console.error(err);
            showMsg('danger', 'No se pudo conectar con el servidor');
            setStatus('err', 'Error de red');
            beep(false);
        } finally {
            busyIngreso = false;
            placaBuffer = [];
        }
    }

    // ---------- Loop principal ----------

    async function runOcrOnce() {
        if (!scanning || busyOcr || busyIngreso) return;
        busyOcr = true;
        try {
            const frame = await captureFullResSource();
            if (!frame) {
                setStatus('scanning', 'Escaneando…');
                return;
            }

            const blob = await canvasToJpegBlob(frame);
            if (!blob) return;

            const result = await reconocerEnServidor(blob);
            const { placa, confianza, textoCrudo, ms } = result;
            confianzaOcrEl.textContent = `OCR ${confianza || 0}%`;
            updateDebugView(frame, textoCrudo, ms);

            if (!placa) {
                setStatus('scanning', 'Buscando placa…');
                return;
            }

            updatePlacaUi(placa);
            placaManual.value = placa;
            pushToBuffer(placa);

            const matches = placaBuffer.filter((p) => p === placa).length;
            setStatus('scanning', `Detectando ${placa} (${matches}/${placaBuffer.length})`);

            const winner = computeConsensus();
            if (winner) {
                await registrarIngreso(winner);
            }
        } catch (err) {
            console.error('OCR error', err);
            setStatus('err', err.message || 'Error OCR');
        } finally {
            busyOcr = false;
        }
    }

    function startOcrLoop() {
        stopOcrLoop();
        ocrLoopTimer = setInterval(runOcrOnce, OCR_INTERVAL_MS);
        // Primera pasada inmediata
        runOcrOnce();
    }

    function stopOcrLoop() {
        if (ocrLoopTimer) {
            clearInterval(ocrLoopTimer);
            ocrLoopTimer = null;
        }
    }

    async function startCamera() {
        hideMsg();
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            });
            video.srcObject = stream;
            await video.play();

            imageCapture = null;
            try {
                const track = stream.getVideoTracks()[0];
                if (track && typeof ImageCapture !== 'undefined') {
                    imageCapture = new ImageCapture(track);
                }
            } catch (_) {
                imageCapture = null;
            }

            scanning = true;
            placaBuffer = [];
            btnStart.disabled = true;
            btnStop.disabled = false;
            setStatus('scanning', 'Escaneo automático activo');
            startOcrLoop();
        } catch (err) {
            console.error(err);
            showMsg('danger', 'No se pudo acceder a la cámara. Use HTTPS/localhost y permita el permiso.');
            setStatus('err', 'Sin cámara');
            btnStart.disabled = false;
            btnStop.disabled = true;
        }
    }

    function stopCamera() {
        scanning = false;
        stopOcrLoop();
        if (stream) {
            stream.getTracks().forEach((t) => t.stop());
            stream = null;
        }
        imageCapture = null;
        video.srcObject = null;
        btnStart.disabled = false;
        btnStop.disabled = true;
        setStatus('idle', 'Detenido');
        confianzaOcrEl.textContent = 'OCR idle';
    }

    // ---------- Prueba con imágenes de referencia ----------

    async function testOneImage(src, expected) {
        const res = await fetch(src + '?ts=' + Date.now());
        if (!res.ok) throw new Error('No se pudo cargar ' + src);
        const blob = await res.blob();

        // Mostrar preview en depuración
        if (chkDebug.checked) {
            const bmp = await createImageBitmap(blob);
            const preview = drawSourceToCanvas(bmp, bmp.width, bmp.height);
            if (typeof bmp.close === 'function') bmp.close();
            if (preview) updateDebugView(preview, '(enviando…)', null);
        }

        const result = await reconocerEnServidor(blob);
        if (chkDebug.checked && workCanvas.width) {
            updateDebugView(workCanvas, result.textoCrudo, result.ms);
        }
        return {
            ok: result.placa === expected,
            placa: result.placa,
            conf: result.confianza,
            raw: result.textoCrudo,
            ms: result.ms
        };
    }

    async function probarImagenReferencia() {
        hideMsg();
        setStatus('scanning', 'Probando imágenes de referencia…');
        btnTestRef.disabled = true;
        try {
            const tests = [
                { src: '../test/placa-omg650.png', expected: 'OMG650' },
                { src: '../test/placa-cee015.png', expected: 'CEE015' }
            ];

            const resultados = [];
            for (const t of tests) {
                try {
                    const r = await testOneImage(t.src, t.expected);
                    resultados.push({ ...r, label: t.expected });
                } catch (err) {
                    resultados.push({
                        ok: false,
                        placa: null,
                        conf: 0,
                        raw: String(err.message || err),
                        label: t.expected
                    });
                }
            }

            const ultimaConLectura = [...resultados].reverse().find((r) => r.placa);
            if (ultimaConLectura) {
                updatePlacaUi(ultimaConLectura.placa);
                placaManual.value = ultimaConLectura.placa;
                confianzaOcrEl.textContent = `OCR ${ultimaConLectura.conf || 0}%`;
            }

            const resumen = resultados
                .map((r) => {
                    const timing = r.ms != null ? `, ${r.ms}ms` : '';
                    return `${r.label}: ${r.placa || '(sin lectura)'} ${r.ok ? 'OK' : 'FALLÓ'} (${r.conf || 0}%${timing})`;
                })
                .join(' · ');
            const allOk = resultados.every((r) => r.ok);
            showMsg(allOk ? 'success' : 'warning', resumen);
            setStatus(allOk ? 'ok' : 'warn', allOk ? 'Referencias OK' : 'Referencias parciales');
            beep(allOk);
        } catch (err) {
            console.error(err);
            showMsg('danger', err.message || 'Error en prueba de referencia');
            setStatus('err', 'Error prueba');
        } finally {
            btnTestRef.disabled = false;
        }
    }

    btnStart.addEventListener('click', startCamera);
    btnStop.addEventListener('click', stopCamera);
    btnTestRef.addEventListener('click', probarImagenReferencia);

    btnManual.addEventListener('click', () => {
        registrarIngreso(placaManual.value, { fromManual: true });
    });

    placaManual.addEventListener('input', () => {
        const p = PlacaUtils.normalizarPlaca(placaManual.value);
        placaManual.value = p;
        updatePlacaUi(p || null);
    });

    placaManual.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            registrarIngreso(placaManual.value, { fromManual: true });
        }
    });

    document.getElementById('btnPrintTicket')?.addEventListener('click', () => {
        if (!ultimoIngreso) return;
        const html = `
            <div style="text-align:center;font-family:Arial,sans-serif">
                <h3 style="margin:0">${empresaInfo?.nombre || 'ParkSystem'}</h3>
                <div>Comprobante de Ingreso</div>
                <hr>
                <div>Movimiento: <strong>#${ultimoIngreso.movimientoId}</strong></div>
                <div>Placa: <strong>${ultimoIngreso.placa}</strong></div>
                <div>Tipo: <strong>${ultimoIngreso.tipo}</strong></div>
                <div>Entrada: <strong>${new Date(ultimoIngreso.fechaEntrada).toLocaleString('es-CO')}</strong></div>
            </div>
        `;
        const job = {
            titulo: 'Comprobante de Ingreso',
            html,
            widthMm: 58,
            qr: JSON.stringify({
                t: 'ingreso',
                e: empresaInfo?.nit,
                m: ultimoIngreso.movimientoId,
                p: ultimoIngreso.placa,
                fe: ultimoIngreso.fechaEntrada
            })
        };
        sessionStorage.setItem('printJob', JSON.stringify(job));
        window.open('print.html', '_blank');
    });

    window.addEventListener('beforeunload', () => {
        stopCamera();
    });

    // Kiosk: arranque automático
    startCamera();
})();
