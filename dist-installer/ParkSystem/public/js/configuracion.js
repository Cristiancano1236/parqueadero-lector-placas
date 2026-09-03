// Configuración de empresa (admin)
// Relacionado con: public/admin/configuracion.html y API /api/empresa

document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    const role = localStorage.getItem('userRole');
    if (!token) { window.location.href = '/'; return; }
    if (role !== 'admin') { window.location.href = '/admin/dashboard'; return; }

    document.getElementById('userName').textContent = localStorage.getItem('userName') || 'Usuario';
    document.querySelector('.sidebar-toggle').addEventListener('click',()=>document.querySelector('.sidebar').classList.toggle('show'));
    document.getElementById('btnLogout').addEventListener('click',()=>{ localStorage.clear(); location.href='/'; });

    // Cargar datos
    cargarEmpresa();
    cargarConfig();
    cargarIaConfig();

    // Guardar
    document.getElementById('btnSaveEmpresa').addEventListener('click', guardarEmpresa);
    document.getElementById('btnSaveConfig').addEventListener('click', guardarConfig);
    document.getElementById('btnSaveIa')?.addEventListener('click', guardarIaConfig);
    document.getElementById('btnTestIa')?.addEventListener('click', probarIaConfig);
    document.getElementById('btnToggleIaKey')?.addEventListener('click', toggleIaKeyVisibility);
    document.getElementById('ia_modelo')?.addEventListener('change', syncModeloCustom);
    document.getElementById('formIa')?.addEventListener('submit', (e) => {
        e.preventDefault();
        guardarIaConfig();
    });

    // Logo: vista previa y subida
    const fileInput = document.getElementById('e_logo_file');
    const preview = document.getElementById('e_logo_preview');
    const uploadBtn = document.getElementById('btnUploadLogo');
    if (fileInput) {
        fileInput.addEventListener('change', () => {
            const f = fileInput.files && fileInput.files[0];
            if (!f) { preview.src=''; preview.classList.add('d-none'); return; }
            // Validar tamaño (<= 2MB) y tipo (PNG/JPG/GIF)
            const max = 2 * 1024 * 1024;
            const okType = ['image/png','image/jpeg','image/jpg','image/gif'].includes(f.type);
            if (!okType) { setAlert('alertEmpresa','danger','Tipo de archivo no permitido. Usa PNG/JPG.'); fileInput.value=''; return; }
            if (f.size > max) { setAlert('alertEmpresa','danger','El archivo excede 2MB.'); fileInput.value=''; return; }
            const reader = new FileReader();
            reader.onload = e => { preview.src = e.target.result; preview.classList.remove('d-none'); };
            reader.readAsDataURL(f);
        });
    }
    if (uploadBtn) {
        uploadBtn.addEventListener('click', subirLogo);
    }
});

async function cargarEmpresa(){
    try{
        const r = await fetch('/api/empresa/me',{ headers:{ 'Authorization':`Bearer ${localStorage.getItem('token')}` }});
        const j = await r.json();
        if(!r.ok) throw new Error(j.message||'Error cargando empresa');
        const e = j.data;
        document.getElementById('e_nombre').value = e.nombre || '';
        document.getElementById('e_nit').value = e.nit || '';
        document.getElementById('e_direccion').value = e.direccion || '';
        document.getElementById('e_telefono').value = e.telefono || '';
        document.getElementById('e_email').value = e.email || '';
        const preview = document.getElementById('e_logo_preview');
        if (preview) {
            // Intentar cargar desde endpoint BLOB; si 404, ocultar
            fetch('/api/empresa/logo', { headers:{'Authorization':`Bearer ${localStorage.getItem('token')}`} })
                .then(r=> r.ok ? r.blob() : Promise.reject())
                .then(b=>{ preview.src = URL.createObjectURL(b); preview.classList.remove('d-none'); })
                .catch(()=> preview.classList.add('d-none'));
        }
    }catch(err){ setAlert('alertEmpresa', 'danger', err.message); }
}

// Función para cargar configuración de empresa
// Relacionado con: src/routes/empresa.js GET /api/empresa/config
// Nota: Las capacidades ya no se cargan aquí, se gestionan desde Tipos de Vehículos
async function cargarConfig(){
    try{
        const r = await fetch('/api/empresa/config',{ headers:{ 'Authorization':`Bearer ${localStorage.getItem('token')}` }});
        const j = await r.json();
        if(!r.ok) throw new Error(j.message||'Error cargando configuración');
        const c = j.data;
        // Las capacidades ya no se cargan, se gestionan desde tipos-vehiculos.html
        document.getElementById('c_apertura').value = (c.horario_apertura||'').toString().substring(0,5);
        document.getElementById('c_cierre').value = (c.horario_cierre||'').toString().substring(0,5);
        document.getElementById('c_iva').value = c.iva_porcentaje ?? 0;
        document.getElementById('c_moneda').value = c.moneda || 'COP';
        document.getElementById('c_tz').value = c.zona_horaria || 'America/Bogota';
        document.getElementById('c_reglamento').value = c.reglamento || '';
        const chk = document.getElementById('c_24h');
        if (chk) {
            chk.checked = !!c.operacion_24h;
            toggleHorasPor24h();
            chk.addEventListener('change', toggleHorasPor24h);
        }
    }catch(err){ setAlert('alertConfig', 'danger', err.message); }
}

async function guardarEmpresa(){
    const payload = {
        nombre: document.getElementById('e_nombre').value.trim(),
        nit: document.getElementById('e_nit').value.trim(),
        direccion: document.getElementById('e_direccion').value.trim(),
        telefono: document.getElementById('e_telefono').value.trim(),
        email: document.getElementById('e_email').value.trim()
    };
    const btn = document.getElementById('btnSaveEmpresa');
    const prev = btn.innerHTML; btn.disabled = true; btn.innerHTML = spinner('Guardando...');
    try{
        const r = await fetch('/api/empresa',{
            method:'PUT', headers:{'Content-Type':'application/json','Authorization':`Bearer ${localStorage.getItem('token')}`}, body: JSON.stringify(payload)
        });
        const j = await r.json();
        if(!r.ok) throw new Error(j.message||'Error al guardar');
        setAlert('alertEmpresa', 'success', 'Datos de empresa actualizados.');
    }catch(err){ setAlert('alertEmpresa','danger', err.message); }
    finally{ btn.disabled=false; btn.innerHTML = prev; }
}

// Función para guardar configuración de empresa
// Relacionado con: src/routes/empresa.js PUT /api/empresa/config
// Nota: Las capacidades ya no se envían aquí, se gestionan desde tipos-vehiculos.html
async function guardarConfig(){
    const payload = {
        // Las capacidades ya no se envían, se gestionan desde el panel de Tipos de Vehículos
        horario_apertura: document.getElementById('c_apertura').value,
        horario_cierre: document.getElementById('c_cierre').value,
        iva_porcentaje: Number(document.getElementById('c_iva').value||0),
        moneda: document.getElementById('c_moneda').value.trim()||'COP',
        zona_horaria: document.getElementById('c_tz').value.trim()||'America/Bogota',
        operacion_24h: document.getElementById('c_24h').checked,
        reglamento: document.getElementById('c_reglamento').value.trim() || null
    };
    const btn = document.getElementById('btnSaveConfig');
    const prev = btn.innerHTML; btn.disabled = true; btn.innerHTML = spinner('Guardando...');
    try{
        const r = await fetch('/api/empresa/config',{
            method:'PUT', headers:{'Content-Type':'application/json','Authorization':`Bearer ${localStorage.getItem('token')}`}, body: JSON.stringify(payload)
        });
        const j = await r.json();
        if(!r.ok) throw new Error(j.message||'Error al guardar');
        setAlert('alertConfig', 'success', 'Configuración actualizada.');
    }catch(err){ setAlert('alertConfig','danger', err.message); }
    finally{ btn.disabled=false; btn.innerHTML = prev; }
}

function toggleHorasPor24h(){
    const on = document.getElementById('c_24h').checked;
    document.getElementById('c_apertura').disabled = on;
    document.getElementById('c_cierre').disabled = on;
}

function setAlert(id, type, msg){
    const el = document.getElementById(id);
    el.className = `alert alert-${type}`;
    el.textContent = msg;
}

function spinner(text){
    return `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> ${text}`;
}

const MODELOS_IA = [
    'gemini-3.1-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.1-pro-preview',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro'
];

function syncModeloCustom() {
    const sel = document.getElementById('ia_modelo');
    const wrap = document.getElementById('ia_modelo_custom_wrap');
    if (!sel || !wrap) return;
    wrap.classList.toggle('d-none', sel.value !== 'custom');
}

function modeloSeleccionado() {
    const sel = document.getElementById('ia_modelo');
    if (!sel) return 'gemini-3.1-flash-lite';
    if (sel.value === 'custom') {
        return (document.getElementById('ia_modelo_custom').value || '').trim();
    }
    return sel.value;
}

function setModeloSelect(modelo) {
    const sel = document.getElementById('ia_modelo');
    const custom = document.getElementById('ia_modelo_custom');
    const value = modelo || 'gemini-3.1-flash-lite';
    if (MODELOS_IA.includes(value)) {
        sel.value = value;
        custom.value = '';
    } else {
        sel.value = 'custom';
        custom.value = value;
    }
    syncModeloCustom();
}

function setIaBadge(configurado) {
    const badge = document.getElementById('ia_badge');
    if (!badge) return;
    if (configurado) {
        badge.className = 'badge bg-success ms-2';
        badge.textContent = 'Configurado';
    } else {
        badge.className = 'badge bg-secondary ms-2';
        badge.textContent = 'No configurado';
    }
}

function toggleIaKeyVisibility() {
    const input = document.getElementById('ia_api_key');
    const icon = document.getElementById('ia_key_icon');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    if (icon) {
        icon.classList.toggle('fa-eye', !show);
        icon.classList.toggle('fa-eye-slash', show);
    }
}

async function cargarIaConfig() {
    try {
        const r = await fetch('/api/ia/config', {
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message || 'Error cargando configuración de IA');
        const d = j.data || {};
        setIaBadge(!!d.configurado);
        setModeloSelect(d.modelo);
        document.getElementById('ia_api_key').value = '';
        const preview = document.getElementById('ia_key_preview');
        if (d.configurado && d.api_key_preview) {
            preview.textContent = `Clave guardada: ${d.api_key_preview}. Déjalo vacío para conservarla o pega una nueva para reemplazarla.`;
        } else {
            preview.textContent = 'Aún no hay una API Key guardada. El lector de placas no funcionará hasta configurarla.';
        }
    } catch (err) {
        setAlert('alertIa', 'danger', err.message);
    }
}

async function guardarIaConfig() {
    const payload = { modelo: modeloSeleccionado() };
    if (!payload.modelo) {
        setAlert('alertIa', 'warning', 'Indica un modelo de Gemini.');
        return;
    }
    const key = (document.getElementById('ia_api_key').value || '').trim();
    if (key) payload.api_key = key;

    const btn = document.getElementById('btnSaveIa');
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = spinner('Guardando...');
    try {
        const r = await fetch('/api/ia/config', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify(payload)
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message || 'Error al guardar');
        document.getElementById('ia_api_key').value = '';
        await cargarIaConfig();
        setAlert('alertIa', 'success', j.message || 'Configuración de IA guardada.');
    } catch (err) {
        setAlert('alertIa', 'danger', err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = prev;
    }
}

async function probarIaConfig() {
    const payload = { modelo: modeloSeleccionado() };
    const key = (document.getElementById('ia_api_key').value || '').trim();
    if (key) payload.api_key = key;

    const btn = document.getElementById('btnTestIa');
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = spinner('Probando...');
    try {
        const r = await fetch('/api/ia/config/probar', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify(payload)
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message || 'La prueba falló');
        const data = j.data || {};
        if (data.modelo) setModeloSelect(data.modelo);
        if (data.uso_fallback && data.modelo) {
            setAlert(
                'alertIa',
                'success',
                `Tu clave no admite el modelo recomendado. Ya dejamos seleccionado el que sí funciona (${data.modelo}). Pulsa Guardar.`
            );
        } else {
            const modeloOk = data.modelo ? ` Modelo: ${data.modelo}.` : '';
            setAlert('alertIa', 'success', (j.message || 'Conexión con Gemini correcta.') + modeloOk);
        }
    } catch (err) {
        setAlert('alertIa', 'danger', err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = prev;
    }
}

// Subir logo y colocar URL pública en el campo de texto (no guarda aún en BD)
async function subirLogo(){
    const file = document.getElementById('e_logo_file') && document.getElementById('e_logo_file').files[0];
    if (!file) { setAlert('alertEmpresa','warning','Selecciona un archivo de logo.'); return; }
    const btn = document.getElementById('btnUploadLogo');
    const prev = btn.innerHTML; btn.disabled = true; btn.innerHTML = spinner('Subiendo...');
    try{
        const form = new FormData();
        form.append('logo', file);
        const r = await fetch('/api/empresa/logo', { method:'POST', headers:{ 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: form });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message||'Error al subir logo');
        const logoPreview = document.getElementById('e_logo_preview');
        if (logoPreview) {
            // Recargar desde el endpoint BLOB para mostrar la imagen real guardada
            fetch('/api/empresa/logo', { headers:{ 'Authorization': `Bearer ${localStorage.getItem('token')}` } })
                .then(r => r.ok ? r.blob() : Promise.reject())
                .then(b => { logoPreview.src = URL.createObjectURL(b); logoPreview.classList.remove('d-none'); })
                .catch(() => {});
        }
        setAlert('alertEmpresa','success','Logo subido y guardado correctamente.');
    }catch(err){ setAlert('alertEmpresa','danger', err.message); }
    finally{ btn.disabled=false; btn.innerHTML = prev; }
}


