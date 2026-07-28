// Módulo UI Mensualidades
// - Lista, filtro y paginación (GET /api/mensualidades)
// - Crear/editar mensualidad (POST/PUT /api/mensualidades)
// - Registrar pagos por periodo (POST /api/mensualidades/:id/pagos)
// - Tipos de vehículo cargados dinámicamente desde /api/tipos-vehiculos

(function () {
    const token = localStorage.getItem('token');
    if (!token) { window.location.href = '/'; return; }

    let currentPage = 1;
    const pageSize = 10;
    let lastQuery = { q: '' };
    let currentTab = 'activos'; // 'activos' | 'cancelada'
    let selectedDueFilters = new Set();
    let empresaInfo = null;

    // Utilidades
    const toast = (msg, type = 'info') => {
        try {
            const cont = document.getElementById('toastContainer');
            const el = document.createElement('div');
            el.className = `toast align-items-center text-bg-${type} border-0 show`;
            el.role = 'alert';
            el.innerHTML = `<div class="d-flex"><div class="toast-body">${msg}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
            cont.appendChild(el);
            setTimeout(() => el.remove(), 3500);
        } catch (_e) { alert(msg); }
    };

    // Inicialización de UI básica
    document.getElementById('userName').textContent = localStorage.getItem('userName') || 'Usuario';
    document.querySelector('.sidebar-toggle').addEventListener('click', () =>
        document.querySelector('.sidebar').classList.toggle('show'));
    document.getElementById('btnLogout').addEventListener('click', () => {
        localStorage.clear(); location.href = '/';
    });
    (function () {
        const role = localStorage.getItem('userRole');
        if (role !== 'admin') {
            document.querySelectorAll('.admin-only').forEach(el => el.classList.add('d-none'));
        }
    })();

    // Cargar info de empresa para recibos
    (async () => {
        try {
            const r = await fetch('/api/empresa/me', { headers: { 'Authorization': `Bearer ${token}` } });
            const j = await r.json();
            if (r.ok) empresaInfo = j.data || {};
            try {
                const lr = await fetch('/api/empresa/logo', { headers: { 'Authorization': `Bearer ${token}` } });
                if (lr.ok) {
                    const blob = await lr.blob();
                    empresaInfo.logo_url = await new Promise(resolve => {
                        const fr = new FileReader();
                        fr.onload = () => resolve(fr.result);
                        fr.readAsDataURL(blob);
                    });
                }
            } catch (_e) { }
            // Cargar reglamento desde configuración
            try {
                const cr = await fetch('/api/empresa/config', { headers: { 'Authorization': `Bearer ${token}` } });
                const cj = await cr.json();
                if (cr.ok && cj.data) empresaInfo.reglamento = cj.data.reglamento || null;
            } catch (_e) { }
        } catch (_e) { }
    })();

    // Cargar tipos de vehículos y poblar el select #id_tipo
    async function loadTiposVehiculos() {
        try {
            const r = await fetch('/api/tipos-vehiculos', { headers: { 'Authorization': `Bearer ${token}` } });
            const j = await r.json();
            if (!r.ok) return;
            const sel = document.getElementById('id_tipo');
            const tipos = j.data || j || [];
            tipos.forEach(t => {
                if (!t.activo && t.activo !== undefined) return;
                const opt = document.createElement('option');
                opt.value = t.id_tipo;
                opt.textContent = t.nombre;
                sel.appendChild(opt);
            });
        } catch (_e) { }
    }

    loadTiposVehiculos();

    // Mostrar/ocultar campos según tipo de servicio
    function toggleTipoServicio(val) {
        const esArriendo = val === 'arriendo';
        document.getElementById('rowVehiculo').style.display = esArriendo ? 'none' : '';
        document.getElementById('rowArriendo').style.display = esArriendo ? '' : 'none';
        document.getElementById('placa').required = !esArriendo;
        document.getElementById('referencia_espacio').required = esArriendo;
    }
    document.getElementById('tipo_servicio').addEventListener('change', e => toggleTipoServicio(e.target.value));

    // Lógica de pestañas
    document.querySelectorAll('#tabsMens .nav-link').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#tabsMens .nav-link').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTab = btn.getAttribute('data-tab');
            currentPage = 1;
            selectedDueFilters.clear();
            syncDueFilterChips();
            toggleDueFiltersBar();
            const btnNueva = document.getElementById('btnNueva');
            if (btnNueva) btnNueva.style.display = currentTab === 'activos' ? '' : 'none';
            loadList();
        });
    });

    function toggleDueFiltersBar() {
        const bar = document.getElementById('dueFiltersBar');
        if (bar) bar.style.display = currentTab === 'activos' ? '' : 'none';
    }

    function syncDueFilterChips() {
        document.querySelectorAll('#dueFilterChips .due-filter-chip').forEach(chip => {
            const due = chip.getAttribute('data-due');
            const isAll = due === '';
            const active = isAll ? selectedDueFilters.size === 0 : selectedDueFilters.has(due);
            chip.classList.toggle('active', active);
        });
        const btnClear = document.getElementById('btnClearDueFilters');
        if (btnClear) btnClear.style.display = selectedDueFilters.size > 0 ? '' : 'none';
        updateDueFilterSummary();
    }

    function updateDueFilterSummary() {
        const el = document.getElementById('dueFilterSummary');
        if (!el) return;
        if (selectedDueFilters.size === 0) {
            el.textContent = '';
            return;
        }
        const labels = {
            vencido: 'Vencidos',
            proximo: 'Próximos',
            al_dia: 'Al día',
            inactivo: 'Inactivos'
        };
        const names = [...selectedDueFilters].map(k => labels[k] || k).join(' + ');
        el.innerHTML = `<span class="badge bg-primary-subtle text-primary border border-primary-subtle">${names}</span>`;
    }

    function updateDueCounts(counts) {
        if (!counts) return;
        const map = { all: 'count-all', vencido: 'count-vencido', proximo: 'count-proximo', al_dia: 'count-al_dia', inactivo: 'count-inactivo' };
        Object.entries(map).forEach(([key, id]) => {
            const el = document.getElementById(id);
            if (el) el.textContent = counts[key] ?? 0;
        });
    }

    document.querySelectorAll('#dueFilterChips .due-filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const due = chip.getAttribute('data-due');
            if (due === '') {
                selectedDueFilters.clear();
            } else {
                if (selectedDueFilters.has(due)) selectedDueFilters.delete(due);
                else selectedDueFilters.add(due);
            }
            syncDueFilterChips();
            currentPage = 1;
            loadList();
        });
    });

    document.getElementById('btnClearDueFilters')?.addEventListener('click', () => {
        selectedDueFilters.clear();
        syncDueFilterChips();
        currentPage = 1;
        loadList();
    });

    toggleDueFiltersBar();

    // Lista
    async function loadList() {
        const q = document.getElementById('q').value.trim();
        lastQuery = { q };
        try {
            const params = new URLSearchParams({ q, page: currentPage, pageSize });
            if (currentTab === 'activos') {
                params.set('tab', 'activos');
                if (selectedDueFilters.size > 0) {
                    params.set('due', [...selectedDueFilters].join(','));
                }
            } else {
                params.set('estado', currentTab);
            }
            const r = await fetch(`/api/mensualidades?${params.toString()}`, { headers: { 'Authorization': `Bearer ${token}` } });
            const j = await r.json();
            if (!r.ok) throw new Error(j.message || 'Error');
            if (j.counts) updateDueCounts(j.counts);
            renderTable(j.data || [], j.total || 0);
        } catch (e) { toast(e.message, 'danger'); }
    }

    function renderTable(rows, total) {
        const tb = document.getElementById('tbMens');
        tb.innerHTML = '';
        if (!rows.length) {
            const msg = selectedDueFilters.size > 0
                ? 'No hay registros con los filtros seleccionados'
                : 'No hay mensualidades para mostrar';
            tb.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4"><i class="fas fa-inbox fa-2x mb-2 d-block opacity-50"></i>${msg}</td></tr>`;
        }
        rows.forEach(m => {
            const esArriendo = m.tipo_servicio === 'arriendo';
            const idLabel = esArriendo
                ? `<span class="badge bg-secondary"><i class="fas fa-home me-1"></i>${m.referencia_espacio || 'Sin referencia'}</span>`
                : `<span class="badge bg-light text-dark border"><i class="fas fa-car me-1"></i>${m.placa || '-'}</span>`;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>
                    <div class="d-flex align-items-center gap-2">
                        ${idLabel}
                        ${renderDueBadge(m)}
                    </div>
                    <div class="small text-muted mt-1">${renderNextInfo(m)}</div>
                </td>
                <td>
                    <div class="fw-semibold">${m.titular_nombre || ''}</div>
                    <div class="small text-muted">${m.titular_documento || ''} ${m.titular_telefono ? ' • ' + m.titular_telefono : ''}</div>
                </td>
                <td>${renderTipoServicio(m.tipo_servicio)}</td>
                <td>$${new Intl.NumberFormat('es-CO').format(m.valor_mensual || 0)}</td>
                <td>${m.fecha_inicio ? new Date(m.fecha_inicio).toLocaleDateString('es-CO') : ''}</td>
                <td>${m.fecha_fin ? new Date(m.fecha_fin).toLocaleDateString('es-CO') : ''}</td>
                <td>${renderEstado(m.estado)}</td>
                <td class="text-nowrap">
                    ${currentTab !== 'cancelada' ? `
                    <button class="btn btn-sm btn-outline-primary me-1" data-action="edit" data-id="${m.id_mensualidad}" title="Editar"><i class="fas fa-pen"></i></button>
                    <button class="btn btn-sm btn-outline-success me-1" data-action="pago" data-id="${m.id_mensualidad}" title="Registrar pago"><i class="fas fa-dollar-sign"></i></button>` : ''}
                    <button class="btn btn-sm btn-outline-secondary me-1" data-action="pagos" data-id="${m.id_mensualidad}" title="Historial de pagos"><i class="fas fa-receipt"></i></button>
                    <button class="btn btn-sm btn-outline-danger admin-only" data-action="delete" data-id="${m.id_mensualidad}" data-nombre="${(m.titular_nombre || '').replace(/"/g,'&quot;')}" title="${currentTab === 'cancelada' ? 'Eliminar permanentemente' : 'Desactivar / Eliminar'}"><i class="fas fa-trash"></i></button>
                </td>`;
            tb.appendChild(tr);
        });
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        document.getElementById('pageInfo').textContent = `Página ${currentPage} de ${totalPages}`;
        document.getElementById('btnPrev').disabled = currentPage <= 1;
        document.getElementById('btnNext').disabled = currentPage >= totalPages;
    }

    function renderEstado(e) {
        if (e === 'activa') return '<span class="badge bg-success">Activa</span>';
        if (e === 'vencida') return '<span class="badge bg-warning text-dark">Vencida</span>';
        if (e === 'cancelada') return '<span class="badge bg-secondary">Cancelada</span>';
        return `<span class="badge bg-light text-dark">${e || '-'}</span>`;
    }

    function renderTipoServicio(ts) {
        if (ts === 'arriendo') return '<span class="badge bg-info text-dark">Arriendo</span>';
        return '<span class="badge bg-primary">Mensualidad</span>';
    }

    function renderDueBadge(m) {
        if (m.due_status === 'inactivo') return '<span class="badge bg-secondary">Inactivo</span>';
        if (m.due_status === 'vencido') {
            const n = m.overdue_payments || 1;
            return `<span class="badge bg-danger" title="Pagos vencidos">Vencida ×${n}</span>`;
        }
        if (m.due_status === 'proximo') {
            const d = m.days_to_next || 0;
            const cls = d <= 2 ? 'bg-danger' : 'bg-warning text-dark';
            return `<span class="badge ${cls}" title="Próximo pago en ${d} día(s)">Próximo en ${d}d</span>`;
        }
        return '<span class="badge bg-success">Al día</span>';
    }

    function renderNextInfo(m) {
        if (m.due_status === 'inactivo') return 'Sin próximos pagos';
        if (m.due_status === 'vencido') return `Tiene ${m.overdue_payments || 1} pago(s) vencido(s)`;
        if (m.next_payment_date) return `Próximo pago: ${new Date(m.next_payment_date).toLocaleDateString('es-CO')}`;
        return '';
    }

    // Paginación y filtros
    document.getElementById('btnBuscar').addEventListener('click', () => { currentPage = 1; loadList(); });
    document.getElementById('q').addEventListener('keydown', ev => { if (ev.key === 'Enter') { currentPage = 1; loadList(); } });
    document.getElementById('btnPrev').addEventListener('click', () => { if (currentPage > 1) { currentPage--; loadList(); } });
    document.getElementById('btnNext').addEventListener('click', () => { currentPage++; loadList(); });

    // Nueva mensualidad / arriendo
    const mensModal = new bootstrap.Modal(document.getElementById('mensModal'));
    document.getElementById('btnNueva').addEventListener('click', () => {
        document.getElementById('mensModalTitle').textContent = 'Nueva mensualidad';
        document.getElementById('mensForm').reset();
        document.getElementById('id_mensualidad').value = '';
        toggleTipoServicio('mensualidad');
        mensModal.show();
    });

    // Guardar (crear/editar)
    document.getElementById('btnGuardar').addEventListener('click', async () => {
        try {
            const payload = collectMensForm();
            const id = document.getElementById('id_mensualidad').value;
            const url = id ? `/api/mensualidades/${id}` : '/api/mensualidades';
            const method = id ? 'PUT' : 'POST';
            const r = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(payload)
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j.message || 'Error');
            toast(j.message || 'Guardado', 'success');
            mensModal.hide();
            loadList();
        } catch (e) { toast(e.message, 'danger'); }
    });

    function collectMensForm() {
        const tipoServicio = document.getElementById('tipo_servicio').value || 'mensualidad';
        const esArriendo = tipoServicio === 'arriendo';
        const id_tipoVal = document.getElementById('id_tipo').value;
        const payload = {
            tipo_servicio: tipoServicio,
            titular_nombre: document.getElementById('titular_nombre').value.trim(),
            titular_documento: document.getElementById('titular_documento').value.trim(),
            titular_telefono: document.getElementById('titular_telefono').value.trim(),
            titular_email: document.getElementById('titular_email').value.trim(),
            valor_mensual: Number(document.getElementById('valor_mensual').value || 0),
            fecha_inicio: document.getElementById('fecha_inicio').value,
            fecha_fin: document.getElementById('fecha_fin').value || null,
            auto_renovar: document.getElementById('auto_renovar').checked,
            observaciones: document.getElementById('observaciones').value.trim()
        };
        if (esArriendo) {
            payload.referencia_espacio = document.getElementById('referencia_espacio').value.trim();
        } else {
            payload.placa = document.getElementById('placa').value.trim().toUpperCase();
            if (id_tipoVal) payload.id_tipo = parseInt(id_tipoVal);
        }
        return payload;
    }

    // Delegación de acciones en tabla
    document.getElementById('tbMens').addEventListener('click', async ev => {
        const btn = ev.target.closest('button[data-action]');
        if (!btn) return;
        const id = btn.getAttribute('data-id');
        const action = btn.getAttribute('data-action');

        if (action === 'edit') {
            try {
                const r = await fetch(`/api/mensualidades/${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
                const j = await r.json();
                if (!r.ok) throw new Error(j.message || 'Error');
                fillMensForm(j.data);
                const tipo = j.data.tipo_servicio === 'arriendo' ? 'arriendo' : 'mensualidad';
                document.getElementById('mensModalTitle').textContent = `Editar ${tipo} #${id}`;
                mensModal.show();
            } catch (e) { toast(e.message, 'danger'); }

        } else if (action === 'pago') {
            document.getElementById('pago_id_mensualidad').value = id;
            document.getElementById('pagoMensForm').reset();
            try {
                const r = await fetch('/api/turnos/actual', { headers: { 'Authorization': `Bearer ${token}` } });
                const j = await r.json();
                const hayTurno = r.ok && j && j.data;
                if (!hayTurno) { if (window.requireOpenShift) await window.requireOpenShift(); return; }
            } catch (_) { if (window.requireOpenShift) await window.requireOpenShift(); return; }
            await preloadPagoSugerencia(id);
            const modal = new bootstrap.Modal(document.getElementById('pagoMensModal'));
            modal.show();

        } else if (action === 'delete') {
            const nombre = btn.getAttribute('data-nombre') || `#${id}`;
            const esCancelada = currentTab === 'cancelada';
            showConfirmDelete(nombre, esCancelada, async () => {
                try {
                    const r = await fetch(`/api/mensualidades/${id}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    const j = await r.json();
                    if (!r.ok) throw new Error(j.message || 'Error');
                    const tipo = j.action === 'deleted' ? 'danger' : 'warning';
                    toast(j.message || 'Operación realizada', tipo);
                    loadList();
                } catch (e) { toast(e.message, 'danger'); }
            });

        } else if (action === 'pagos') {
            try {
                const r = await fetch(`/api/mensualidades/${id}/pagos`, { headers: { 'Authorization': `Bearer ${token}` } });
                const j = await r.json();
                if (!r.ok) throw new Error(j.message || 'Error');
                const list = j.data || [];
                const html = list.length ? list.map(p =>
                    `<div class="d-flex justify-content-between align-items-center border-bottom py-2">
                        <div>
                            ${new Date(p.fecha_pago).toLocaleString('es-CO')}
                            <div class="small text-muted">${p.periodo_desde} a ${p.periodo_hasta}</div>
                        </div>
                        <div class="text-end">
                            <div class="small">${p.metodo_pago}</div>
                            <div class="fw-semibold">$${new Intl.NumberFormat('es-CO').format(p.monto)}</div>
                        </div>
                        <div class="ms-2">
                            <button type="button" class="btn btn-sm btn-outline-primary" title="Reimprimir recibo"
                                data-action="reprint"
                                data-fecha="${p.fecha_pago}"
                                data-desde="${p.periodo_desde}"
                                data-hasta="${p.periodo_hasta}"
                                data-metodo="${p.metodo_pago}"
                                data-monto="${p.monto}"
                                data-referencia="${p.referencia_pago || ''}">
                                <i class="fas fa-print"></i>
                            </button>
                        </div>
                    </div>`
                ).join('') : '<div class="text-muted">Sin pagos registrados</div>';

                const wrap = document.createElement('div');
                wrap.className = 'modal fade';
                wrap.innerHTML = `
                    <div class="modal-dialog modal-sm"><div class="modal-content">
                        <div class="modal-header"><h6 class="modal-title">Historial de pagos</h6><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
                        <div class="modal-body">${html}</div>
                        <div class="modal-footer"><button class="btn btn-secondary" data-bs-dismiss="modal">Cerrar</button></div>
                    </div></div>`;
                document.body.appendChild(wrap);
                const modal = new bootstrap.Modal(wrap);
                wrap.addEventListener('hidden.bs.modal', () => wrap.remove());
                wrap.addEventListener('click', async ev => {
                    const btnPrint = ev.target.closest('button[data-action="reprint"]');
                    if (!btnPrint) return;
                    try {
                        const dr = await fetch(`/api/mensualidades/${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
                        const dj = await dr.json();
                        if (!dr.ok) throw new Error(dj.message || 'Error');
                        const mens = dj.data || {};
                        const pago = {
                            periodo_desde: btnPrint.getAttribute('data-desde'),
                            periodo_hasta: btnPrint.getAttribute('data-hasta'),
                            metodo_pago: btnPrint.getAttribute('data-metodo'),
                            monto: Number(btnPrint.getAttribute('data-monto') || 0),
                            referencia_pago: btnPrint.getAttribute('data-referencia') || '',
                            fecha_pago: btnPrint.getAttribute('data-fecha')
                        };
                        const htmlRecibo = renderReciboMensualidad(mens, pago, empresaInfo);
                        const qrPayload = { t: 'mens', e: empresaInfo?.nit, m: mens.id_mensualidad, p: mens.placa, pd: pago.periodo_desde, ph: pago.periodo_hasta, total: pago.monto };
                        imprimirHTML(htmlRecibo, 'Recibo de Pago Mensualidad', 80, qrPayload);
                    } catch (e) { toast(e.message, 'danger'); }
                });
                modal.show();
            } catch (e) { toast(e.message, 'danger'); }
        }
    });

    function fillMensForm(d) {
        const tipo = d.tipo_servicio || 'mensualidad';
        document.getElementById('id_mensualidad').value = d.id_mensualidad;
        document.getElementById('tipo_servicio').value = tipo;
        toggleTipoServicio(tipo);
        document.getElementById('placa').value = d.placa || '';
        document.getElementById('id_tipo').value = d.id_tipo || '';
        document.getElementById('referencia_espacio').value = d.referencia_espacio || '';
        document.getElementById('titular_nombre').value = d.titular_nombre || '';
        document.getElementById('titular_documento').value = d.titular_documento || '';
        document.getElementById('titular_telefono').value = d.titular_telefono || '';
        document.getElementById('titular_email').value = d.titular_email || '';
        document.getElementById('valor_mensual').value = d.valor_mensual || 0;
        document.getElementById('fecha_inicio').valueAsDate = d.fecha_inicio ? new Date(d.fecha_inicio) : null;
        document.getElementById('fecha_fin').value = d.fecha_fin || '';
        document.getElementById('auto_renovar').checked = !!d.auto_renovar;
        document.getElementById('observaciones').value = d.observaciones || '';
    }

    // Precargar sugerencia de pago
    async function preloadPagoSugerencia(id) {
        try {
            const r = await fetch(`/api/mensualidades/${id}/sugerencia-pago`, { headers: { 'Authorization': `Bearer ${token}` } });
            const j = await r.json();
            if (!r.ok) throw new Error(j.message || 'Error');
            const d = j.data || {};
            const monthsInput = document.getElementById('months');
            const montoInput = document.getElementById('monto');
            const label = document.getElementById('periodo_label');

            const base = {
                valor: Number(d.valor_mensual || 0),
                desde: d.periodo_desde ? new Date(d.periodo_desde) : null
            };
            monthsInput.value = d.months || 1;
            montoInput.value = (base.valor * (d.months || 1)).toFixed(2);
            if (base.desde) {
                const hasta = addMonthsMinusOneDay(base.desde, d.months || 1);
                label.value = `${fmtDate(base.desde)} - ${fmtDate(hasta)}`;
                monthsInput.dataset.baseDesde = base.desde.toISOString();
                monthsInput.dataset.baseValor = String(base.valor);
                label.dataset.periodFrom = base.desde.toISOString().slice(0, 10);
                label.dataset.periodTo = hasta.toISOString().slice(0, 10);
            } else {
                label.value = '';
                monthsInput.dataset.baseDesde = '';
                monthsInput.dataset.baseValor = String(base.valor);
                label.dataset.periodFrom = '';
                label.dataset.periodTo = '';
            }
            attachMonthsHandlers();
        } catch (e) { toast(e.message, 'danger'); }
    }

    function addMonthsMinusOneDay(from, months) {
        const d = new Date(from);
        d.setMonth(d.getMonth() + months);
        d.setDate(d.getDate() - 1);
        return d;
    }

    function fmtDate(d) { return d.toISOString().slice(0, 10); }

    function attachMonthsHandlers() {
        const monthsInput = document.getElementById('months');
        const btnPlus = document.getElementById('btnMesMas');
        const btnMinus = document.getElementById('btnMesMenos');
        const label = document.getElementById('periodo_label');
        const montoInput = document.getElementById('monto');

        const recalc = delta => {
            const baseDesdeISO = monthsInput.dataset.baseDesde;
            const baseValor = Number(monthsInput.dataset.baseValor || 0);
            let n = parseInt(monthsInput.value || '1');
            if (delta) { n = Math.max(1, n + delta); monthsInput.value = n; }
            if (baseDesdeISO) {
                const desde = new Date(baseDesdeISO);
                const hasta = addMonthsMinusOneDay(desde, n);
                label.value = `${fmtDate(desde)} - ${fmtDate(hasta)}`;
                label.dataset.periodFrom = fmtDate(desde);
                label.dataset.periodTo = fmtDate(hasta);
            }
            montoInput.value = (baseValor * n).toFixed(2);
        };

        btnPlus.onclick = () => recalc(1);
        btnMinus.onclick = () => recalc(-1);
        monthsInput.oninput = () => recalc(0);
    }

    // Registrar pago
    document.getElementById('btnRegPago').addEventListener('click', async () => {
        try {
            const id = document.getElementById('pago_id_mensualidad').value;
            const payload = {
                periodo_desde: document.getElementById('periodo_label').dataset.periodFrom || null,
                periodo_hasta: document.getElementById('periodo_label').dataset.periodTo || null,
                metodo_pago: document.getElementById('metodo_pago').value,
                monto: Number(document.getElementById('monto').value || 0),
                referencia_pago: document.getElementById('referencia_pago').value.trim()
            };
            if (window.requireOpenShift) await window.requireOpenShift();
            const r = await fetch(`/api/mensualidades/${id}/pagos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(payload)
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j.message || 'Error');
            toast('Pago registrado', 'success');
            bootstrap.Modal.getInstance(document.getElementById('pagoMensModal')).hide();

            try {
                const dr = await fetch(`/api/mensualidades/${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
                const dj = await dr.json();
                if (dr.ok) {
                    const mens = dj.data || {};
                    const html = renderReciboMensualidad(mens, payload, empresaInfo);
                    const qrPayload = { t: 'mens', e: empresaInfo?.nit, m: id, p: mens.placa, pd: payload.periodo_desde, ph: payload.periodo_hasta, total: payload.monto };
                    imprimirHTML(html, 'Recibo de Pago Mensualidad', 80, qrPayload);
                }
            } catch (_e) { }

            loadList();
        } catch (e) { toast(e.message, 'danger'); }
    });

    loadList();
})();

// Modal de confirmación estilizado para eliminar/desactivar
function showConfirmDelete(nombre, esPermanente, onConfirm) {
    const modalEl = document.getElementById('confirmDeleteModal');
    if (!modalEl) { if (confirm(nombre)) onConfirm(); return; }

    const icon = document.getElementById('confirmDeleteIcon');
    const iconI = document.getElementById('confirmDeleteIconI');
    const title = document.getElementById('confirmDeleteTitle');
    const question = document.getElementById('confirmDeleteQuestion');
    const bullets = document.getElementById('confirmDeleteBullets');
    const btnOk = document.getElementById('btnConfirmDeleteOk');

    if (esPermanente) {
        icon.style.background = '#fee2e2';
        iconI.style.color = '#dc2626';
        iconI.className = 'fas fa-trash-alt fs-5';
        title.textContent = 'Eliminar permanentemente';
        question.textContent = `¿Eliminar el registro de "${nombre}"?`;
        bullets.innerHTML = `<div class="d-flex gap-2"><i class="fas fa-exclamation-triangle text-danger mt-1"></i><span>Esta acción <strong>no se puede deshacer</strong>. El registro se borrará de forma definitiva.</span></div>`;
        btnOk.className = 'btn btn-danger';
        btnOk.innerHTML = '<i class="fas fa-trash-alt me-1"></i>Eliminar';
    } else {
        icon.style.background = '#fef3c7';
        iconI.style.color = '#d97706';
        iconI.className = 'fas fa-user-slash fs-5';
        title.textContent = 'Desactivar registro';
        question.textContent = `¿Desactivar el registro de "${nombre}"?`;
        bullets.innerHTML = `
            <div class="d-flex gap-2 mb-2"><i class="fas fa-history text-warning mt-1"></i><span>Si tiene <strong>pagos registrados</strong>: se desactivará y podrás verlo en la pestaña <em>Desactivados</em>.</span></div>
            <div class="d-flex gap-2"><i class="fas fa-trash text-danger mt-1"></i><span>Si <strong>no tiene pagos</strong>: se eliminará permanentemente.</span></div>`;
        btnOk.className = 'btn btn-warning';
        btnOk.innerHTML = '<i class="fas fa-user-slash me-1"></i>Confirmar';
    }

    const modal = new bootstrap.Modal(modalEl);

    const handler = () => {
        modal.hide();
        btnOk.removeEventListener('click', handler);
        onConfirm();
    };
    btnOk.removeEventListener('click', handler);
    btnOk.addEventListener('click', handler);

    modal.show();
}

// Extrae solo YYYY-MM-DD de un valor que puede ser Date, ISO string o 'YYYY-MM-DD'
function soloFecha(d) {
    if (!d) return '';
    const s = (d instanceof Date) ? d.toISOString() : String(d);
    return s.slice(0, 10);
}

// Render de recibo de pago de mensualidad (ticket 80 mm)
function renderReciboMensualidad(mens, pago, empresa) {
    const e = empresa || {};
    const fmtCOP = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(Number(n || 0));
    const fechaMostrar = (pago && pago.fecha_pago) ? new Date(pago.fecha_pago).toLocaleString('es-CO') : new Date().toLocaleString('es-CO');
    const header = `
        <div style="text-align:center">
            ${e.logo_url ? `<img src="${e.logo_url}" alt="logo" style="max-height:60px">` : ''}
            <div><strong>${e.nombre || 'Empresa'}</strong></div>
            <div>NIT: ${e.nit || ''}</div>
            <div>${e.direccion || ''} ${e.telefono ? ' - ' + e.telefono : ''}</div>
            <hr/>
            <div><strong>PAGO MENSUALIDAD</strong></div>
        </div>`;
    const esArriendo = mens.tipo_servicio === 'arriendo';
    const body = `
        <div>${esArriendo ? 'Arriendo' : 'Mensualidad'}: <strong>#${mens.id_mensualidad || ''}</strong></div>
        ${esArriendo
            ? `<div>Espacio: <strong>${mens.referencia_espacio || ''}</strong></div>`
            : `<div>Placa: <strong>${mens.placa || ''}</strong></div>`}
        <div>Titular: <strong>${mens.titular_nombre || ''}</strong></div>
        <div>Periodo: <strong>${soloFecha(pago.periodo_desde)} - ${soloFecha(pago.periodo_hasta)}</strong></div>
        <div>Método: <strong>${pago.metodo_pago || ''}</strong></div>
        <div>Monto: <strong>${fmtCOP(pago.monto)}</strong></div>
        ${pago.referencia_pago ? `<div>Referencia: <strong>${pago.referencia_pago}</strong></div>` : ''}
        <div>Fecha: ${fechaMostrar}</div>
        <div>Atendido por: ${localStorage.getItem('userName') || ''}</div>`;
    const reglamentoHtml = (empresa && empresa.reglamento)
        ? `<hr/><div style="font-size:9px;text-align:justify;line-height:1.4">${String(empresa.reglamento).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])).replace(/\n/g,'<br>')}</div>`
        : '';
    const footer = `
        <hr/>
        <div style="text-align:center;margin-top:6px">
            <div>Desarrollado por <strong>Ciscode</strong></div>
            <div>
                <a href="https://ciscodedev.netlify.app" target="_blank" style="text-decoration:none;color:#000">ciscode.co</a>
                &nbsp;|&nbsp;
                <a href="https://www.youtube.com/@Ciscode" target="_blank" style="text-decoration:none;color:#000">YouTube</a>
            </div>
        </div>`;
    return header + body + reglamentoHtml + footer;
}

// Ventana de impresión
// Página de impresión/PDF compatible con todos los dispositivos (incluyendo iOS)
function imprimirHTML(html, titulo, anchoMM, qrPayload) {
    const key = 'pj_' + Date.now();
    localStorage.setItem(key, JSON.stringify({
        html: html,
        titulo: titulo || 'Ticket',
        width: anchoMM || 80,
        qrPayload: qrPayload || null
    }));
    const w = window.open('/admin/print.html?key=' + encodeURIComponent(key), '_blank');
    if (!w) { alert('Por favor permite las ventanas emergentes para imprimir el ticket.'); }
}
