// Callbacks globales de Cloudflare Turnstile (deben estar fuera del DOMContentLoaded)
function onTurnstileSuccess() {
    const btn = document.getElementById('btnLogin');
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = 'Iniciar Sesión';
}

function onTurnstileError() {
    const btn = document.getElementById('btnLogin');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Verificando seguridad...';
}

function onTurnstileExpired() {
    const btn = document.getElementById('btnLogin');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Verificando seguridad...';
    if (window.turnstile) window.turnstile.reset();
}

// Polling de respaldo: si Turnstile completó antes de que el callback estuviera listo
(function pollTurnstileReady() {
    const interval = setInterval(function () {
        const tokenInput = document.querySelector('[name="cf-turnstile-response"]');
        if (tokenInput && tokenInput.value) {
            onTurnstileSuccess();
            clearInterval(interval);
        }
    }, 200);
    // Dejar de revisar después de 30 segundos
    setTimeout(function () { clearInterval(interval); }, 30000);
})();

// Esperar a que el documento esté completamente cargado
document.addEventListener('DOMContentLoaded', function() {
    // Verificar si ya hay un token válido
    const token = localStorage.getItem('token');
    if (token) {
        redirectToDashboard(localStorage.getItem('userRole'));
        return;
    }

    // Obtener elementos del DOM
    const loginForm = document.getElementById('loginForm');
    const passwordInput = document.getElementById('password');
    const togglePassword = document.getElementById('togglePassword');
    const toggleIcon = document.getElementById('toggleIcon');

    // Función para alternar la visibilidad de la contraseña
    togglePassword.addEventListener('click', function() {
        const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
        passwordInput.setAttribute('type', type);
        
        // Cambiar el ícono
        if (type === 'password') {
            toggleIcon.classList.remove('fa-eye-slash');
            toggleIcon.classList.add('fa-eye');
        } else {
            toggleIcon.classList.remove('fa-eye');
            toggleIcon.classList.add('fa-eye-slash');
        }
    });

    // Función para validar el formulario
    loginForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        event.stopPropagation();

        // Validar el formulario usando las clases de Bootstrap
        if (loginForm.checkValidity()) {
            // Obtener los valores del formulario
            const empresa = document.getElementById('empresa').value;
            const usuario = document.getElementById('usuario').value;
            const password = document.getElementById('password').value;
            const recordar = document.getElementById('recordar').checked;

            try {
                // Obtener el token de Turnstile antes de enviar
                const turnstileToken = document.querySelector('[name="cf-turnstile-response"]')?.value;
                if (!turnstileToken) {
                    mostrarError('Verificación de seguridad pendiente. Por favor espera un momento e intenta de nuevo.');
                    return;
                }

                mostrarCargando();
                
                // Enviar datos al servidor
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ empresa, usuario, password, turnstileToken })
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.message || 'Error en el inicio de sesión');
                }

                // Guardar token y datos del usuario
                localStorage.setItem('token', data.data.token);
                localStorage.setItem('userName', data.data.nombre);
                localStorage.setItem('userRole', data.data.rol);
                localStorage.setItem('empresaId', data.data.id_empresa);
                localStorage.setItem('empresaNit', empresa);

                // Marcar el día de login (YYYY-MM-DD) para mostrar el banner diario una vez
                try {
                    var today = new Date();
                    var yyyy = today.getFullYear();
                    var mm = String(today.getMonth()+1).padStart(2,'0');
                    var dd = String(today.getDate()).padStart(2,'0');
                    localStorage.setItem('gfLoginDay', yyyy+'-'+mm+'-'+dd);
                    // Al iniciar sesión, reiniciar el recordatorio de cierre para el nuevo día
                    localStorage.removeItem('gfDismissedDay');
                } catch(_e) {}

                // Siempre guardar el último NIT utilizado para pre-llenar el login
                localStorage.setItem('lastUsedNit', empresa);

                // Guardar usuario y NIT si "recordar" está marcado
                if (recordar) {
                    localStorage.setItem('savedUsername', usuario);
                    localStorage.setItem('savedEmpresa', empresa);
                } else {
                    localStorage.removeItem('savedUsername');
                    localStorage.removeItem('savedEmpresa');
                }

                // Redireccionar según el rol
                redirectToDashboard(data.data.rol);

            } catch (error) {
                mostrarError(error.message);
                restaurarBoton();
                // Resetear el widget de Turnstile para permitir un nuevo intento
                if (window.turnstile) {
                    window.turnstile.reset();
                }
            }
        }

        loginForm.classList.add('was-validated');
    });

    // Función para redireccionar al dashboard
    function redirectToDashboard(rol) {
        const baseUrl = window.location.origin;
        const dashboardUrl = rol === 'admin' ? '/admin/dashboard' : '/operador/dashboard';
        window.location.href = baseUrl + dashboardUrl;
    }

    // Función para mostrar el estado de carga
    function mostrarCargando() {
        const boton = document.getElementById('btnLogin');
        boton.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Iniciando sesión...';
        boton.disabled = true;
    }

    // Función para restaurar el botón (Turnstile sigue válido tras un error de credenciales)
    function restaurarBoton() {
        const boton = document.getElementById('btnLogin');
        boton.innerHTML = 'Iniciar Sesión';
        boton.disabled = false;
    }

    // Función para mostrar errores
    function mostrarError(mensaje) {
        // Crear el elemento de alerta
        const alertaDiv = document.createElement('div');
        alertaDiv.className = 'alert alert-danger alert-dismissible fade show mt-3';
        alertaDiv.role = 'alert';
        alertaDiv.innerHTML = `
            ${mensaje}
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        `;

        // Insertar la alerta antes del formulario
        loginForm.parentNode.insertBefore(alertaDiv, loginForm);

        // Eliminar la alerta después de 5 segundos
        setTimeout(() => {
            alertaDiv.remove();
        }, 5000);
    }

    // Cargar datos guardados al iniciar
    const usuarioGuardado = localStorage.getItem('savedUsername');
    const empresaGuardada = localStorage.getItem('savedEmpresa');
    const lastUsedNit = localStorage.getItem('lastUsedNit');

    if (usuarioGuardado && empresaGuardada) {
        // "Recordar" estaba marcado: restaurar usuario y NIT
        document.getElementById('usuario').value = usuarioGuardado;
        document.getElementById('empresa').value = empresaGuardada;
        document.getElementById('recordar').checked = true;
    } else if (lastUsedNit) {
        // Solo pre-llenar el NIT con el último utilizado
        document.getElementById('empresa').value = lastUsedNit;
    }
});