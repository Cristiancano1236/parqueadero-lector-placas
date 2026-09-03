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
    const btnManual = document.getElementById('btnIngresoManual');
    const ultimoIngresoBox = document.getElementById('ultimoIngresoBox');
    const ultimoIngresoBody = document.getElementById('ultimoIngresoBody');

    const OCR_INTERVAL_MS = 900;
    const COOLDOWN_MS = 10000;
    const MAX_UPLOAD_WIDTH = 960;
    // Debe coincidir con el `aspect-ratio` del contenedor .lector-wrap (ver lector-placas.html)
    const PREVIEW_ASPECT = 16 / 10;
    const JPEG_QUALITY = 0.82;
    const CONSENSUS_LEN = 2;
    const CONSENSUS_MIN = 2;
    const CONSENSUS_RATIO = 1;
    const CONFIANZA_DIRECTA = 90;
    const CAMERA_RETRY_MS = 4000;
    const CAMERA_RETRY_MAX = 5;
    const QUOTA_COOLDOWN_MS = 20000;
    const OVERLOAD_COOLDOWN_MS = 5000;

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
    let cameraRetryCount = 0;
    let cameraRetryTimer = null;
    let pausaTimer = null;

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

    /**
     * Calcula el rectángulo centrado que replica `object-fit: cover`: recorta
     * el eje que sobra para igualar `targetAspect`, sin deformar la imagen.
     * Así lo que se envía a la IA coincide con lo que el operador ve encuadrado
     * en pantalla (el <video> usa object-fit: cover sobre un contenedor 16:10).
     */
    function coverCropRect(w, h, targetAspect) {
        const srcAspect = w / h;
        if (srcAspect > targetAspect) {
            // Fuente más ancha que el objetivo: recorta los lados
            const cw = Math.round(h * targetAspect);
            const sx = Math.round((w - cw) / 2);
            return { sx, sy: 0, sw: cw, sh: h };
        }
        // Fuente más alta que el objetivo (típico celular en retrato): recorta arriba/abajo
        const ch = Math.round(w / targetAspect);
        const sy = Math.round((h - ch) / 2);
        return { sx: 0, sy, sw: w, sh: ch };
    }

    function drawSourceToCanvas(source, w, h, maxW = MAX_UPLOAD_WIDTH, applyCoverCrop = true) {
        if (!w || !h) return null;
        const crop = applyCoverCrop ? coverCropRect(w, h, PREVIEW_ASPECT) : { sx: 0, sy: 0, sw: w, sh: h };
        const scale = Math.min(1, maxW / crop.sw);
        const tw = Math.max(1, Math.floor(crop.sw * scale));
        const th = Math.max(1, Math.floor(crop.sh * scale));
        workCanvas.width = tw;
        workCanvas.height = th;
        workCtx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, tw, th);
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
     * Sube un frame al servidor para reconocimiento con Gemini AI.
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
            const err = new Error(data.message || `Error OCR (${res.status})`);
            err.code = data.code;
            err.status = res.status;
            throw err;
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

    /**
     * Pausa el escaneo automático durante `ms` mostrando una cuenta regresiva
     * clara, y lo reanuda solo al terminar. Se usa cuando Gemini responde que
     * está saturado o que se agotó la cuota, para no seguir golpeando la API
     * cada `OCR_INTERVAL_MS` y así evitar una cascada de errores repetidos.
     */
    function pausarEscaneo(ms, mensajeBase) {
        stopOcrLoop();
        if (pausaTimer) {
            clearInterval(pausaTimer);
            pausaTimer = null;
        }
        let restante = Math.ceil(ms / 1000);
        const actualizar = () => {
            setStatus('warn', `${mensajeBase} ${restante}s…`);
        };
        actualizar();
        pausaTimer = setInterval(() => {
            restante -= 1;
            if (restante <= 0) {
                clearInterval(pausaTimer);
                pausaTimer = null;
                if (scanning) startOcrLoop();
                return;
            }
            actualizar();
        }, 1000);
    }

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
            const { placa, confianza } = result;
            confianzaOcrEl.textContent = `IA ${confianza || 0}%`;

            if (!placa) {
                setStatus('scanning', 'Buscando placa…');
                return;
            }

            updatePlacaUi(placa);
            placaManual.value = placa;

            if ((confianza || 0) >= CONFIANZA_DIRECTA) {
                setStatus('scanning', `Detectada ${placa} (${confianza}%)`);
                await registrarIngreso(placa);
                return;
            }

            pushToBuffer(placa);
            const matches = placaBuffer.filter((p) => p === placa).length;
            setStatus('scanning', `Confirmando ${placa} (${matches}/${CONSENSUS_MIN})`);

            const winner = computeConsensus();
            if (winner) {
                await registrarIngreso(winner);
            }
        } catch (err) {
            console.error('OCR error', err.message || err);
            if (err.code === 'GEMINI_NOT_CONFIGURED') {
                showMsg('warning', 'Falta la API Key de Gemini. Configúrala en Configuración → Inteligencia Artificial.');
                const msgEl = document.getElementById('msgBox');
                if (msgEl) {
                    msgEl.innerHTML = 'Falta la API Key de Gemini. <a href="configuracion.html" class="alert-link">Abrir configuración</a>.';
                }
                setStatus('warn', 'IA no configurada');
                scanning = false;
                stopOcrLoop();
                return;
            }
            if (err.code === 'GEMINI_QUOTA') {
                showMsg('warning', 'Se alcanzó el límite de solicitudes de Gemini. El escaneo se reanuda automáticamente en unos segundos.');
                pausarEscaneo(QUOTA_COOLDOWN_MS, 'Límite de Gemini alcanzado. Reintentando en');
                return;
            }
            if (err.code === 'GEMINI_OVERLOADED') {
                showMsg('warning', err.message || 'Gemini está saturado en este momento.');
                pausarEscaneo(OVERLOAD_COOLDOWN_MS, 'Gemini saturado. Reintentando en');
                return;
            }
            setStatus('err', err.message || 'Error OCR');
            showMsg('danger', err.message || 'Error al reconocer la placa');
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
            cameraRetryCount = 0;
            setStatus('scanning', 'Escaneo automático activo');
            startOcrLoop();
        } catch (err) {
            console.error(err);
            setStatus('err', 'Sin cámara');
            if (cameraRetryCount < CAMERA_RETRY_MAX) {
                cameraRetryCount += 1;
                showMsg('danger', `No se pudo acceder a la cámara. Reintentando… (${cameraRetryCount}/${CAMERA_RETRY_MAX})`);
                clearTimeout(cameraRetryTimer);
                cameraRetryTimer = setTimeout(startCamera, CAMERA_RETRY_MS);
            } else {
                showMsg('danger', 'No se pudo acceder a la cámara. Use HTTPS/localhost, permita el permiso y recargue la página.');
            }
        }
    }

    function stopCamera() {
        scanning = false;
        stopOcrLoop();
        clearTimeout(cameraRetryTimer);
        if (stream) {
            stream.getTracks().forEach((t) => t.stop());
            stream = null;
        }
        imageCapture = null;
        video.srcObject = null;
        setStatus('idle', 'Detenido');
        confianzaOcrEl.textContent = 'IA idle';
    }

    // Nota: la prueba con imágenes de referencia (placas simuladas "en
    // movimiento") vive aparte en public/test/test-runner.html, pensada
    // para desarrollo/QA y no para la pantalla del operador.

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
