# ParkSystem — Parqueadero con lector de placas

Aplicación **Node.js + Express + MariaDB/MySQL** para gestionar parqueaderos multi-empresa: ingresos/salidas, tarifas, pagos, **mensualidades**, reportes, turnos de caja y **lector automático de placas** (Gemini AI).

La interfaz está en `public/` y la sirve el mismo servidor.

---

## Características

- Autenticación JWT con control de intentos de login
- Multi-empresa (aislamiento por `id_empresa`)
- Vehículos, movimientos, tarifas, pagos (efectivo / tarjeta / QR)
- **Mensualidades**: altas, renovaciones, pagos asociados, consulta de historial y sugerencia de cobro
- Dashboard, reportes y exportación a Excel
- Turnos de caja (apertura / cierre)
- Logo de empresa como BLOB
- **Lector de placas (kiosco)**
  - Cámara del dispositivo (móvil o PC)
  - Reconocimiento con **Gemini AI** (cada empresa configura su propia API Key)
  - Clasificación automática carro (`ABC123`) / moto (`ABC12D`)
  - Ingreso automático con consenso y cooldown
- **HTTPS local** para pruebas de cámara desde el celular en la misma WiFi

---

## Requisitos

- **Node.js 18+** y npm
- **MariaDB / MySQL 10.4+**
- Conexión a internet (el lector llama a la API de Gemini)
- Una **API Key de Gemini** ([Google AI Studio](https://aistudio.google.com/apikey); el sistema elige el modelo)
- (Opcional) [mkcert](https://github.com/FiloSottile/mkcert) para HTTPS local

---

## Instalación (desarrollo)

```bash
npm install
```

Crea `.env` en la raíz (puedes copiar `.env.example`):

```env
PORT=3000
HTTPS=true
JWT_SECRET=cambiar_este_secreto_local
APP_ENCRYPTION_KEY=cambiar_esta_clave_de_cifrado
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=tu_password
DB_NAME=parqueadero
```

Crea la base de datos ejecutando `schema.sql` en MariaDB/MySQL.

Empresa / usuario de ejemplo (tras el seed o con el script local):

```bash
node scripts/crear-empresa-local.js
```

(Por defecto el script usa NIT `12345` y un admin local — revisa el script si necesitas otros datos.)

---

## Ejecución

```bash
npm start          # producción / normal
npm run dev        # con nodemon
```

Al arrancar verás algo como:

```text
Servidor corriendo en el puerto 3000 (HTTPS)
Local:   https://localhost:3000
Móvil:   https://192.168.x.x:3000
Migraciones de esquema: OK
```

- Login: `GET /` → `public/index.html`
- Mensualidades: menú **Mensualidades** (tras iniciar sesión)
- Lector: menú **Lector de placas** (tras iniciar sesión)
- API Key de Gemini: **Configuración → Inteligencia Artificial** (solo admin)

---

## HTTPS local (cámara / móvil)

La cámara del navegador en el celular exige HTTPS (o localhost).

1. Instalar mkcert (Windows):

   ```bash
   winget install FiloSottile.mkcert
   ```

2. Generar certificados (localhost + IP LAN):

   ```bash
   npm run certs
   ```

3. En `.env`:

   | Valor | Efecto |
   |-------|--------|
   | `HTTPS=true` | Fuerza HTTPS (falla si no hay `certs/`) |
   | `HTTPS=false` | Fuerza HTTP |
   | *(omitido)* | HTTPS automático si existen `certs/dev-cert.pem` y `certs/dev-key.pem` |

4. Arranca con `npm start` y abre las URLs `https://` que imprime la consola.

### Confiar en el certificado en el móvil (una sola vez)

1. En el PC: `mkcert -CAROOT` → copia `rootCA.pem` al teléfono  
2. **Android:** Ajustes → Seguridad → instalar certificado CA  
3. **iOS:** instalar perfil y confiar en el certificado  
4. Abre `https://IP:3000` (la IP que muestra el servidor)

Si cambia la IP del PC (otro WiFi), vuelve a ejecutar `npm run certs` y reinicia el servidor.

---

## Lector de placas (Gemini AI)

Cada quien que clone o descargue el proyecto usa **su propia API Key**. No hay una clave compartida en el código.

### Cómo configurar Gemini (el usuario no elige el modelo a mano)

El sistema usa **`gemini-3.1-flash-lite`** (rápido y barato para leer placas). El operador solo pega su API Key.

1. Entra a [Google AI Studio](https://aistudio.google.com/apikey) e inicia sesión con Google.
2. Clic en **Create API key** y copia la clave (`AIza…`).
3. En ParkSystem: **admin** → **Configuración** → **Inteligencia Artificial**.
4. Pega la clave, deja el modelo en **Rápido (recomendado)** y pulsa **Probar conexión**.
5. Si esa clave no admite el modelo recomendado (cuentas nuevas o de solo pago), la prueba prueba otros y deja seleccionado el que sí funciona. Luego pulsa **Guardar**.

La clave se guarda **cifrada** en la base de datos (por empresa) y nunca se vuelve a mostrar completa.

El plan gratuito de Google se agota fácil en un kiosco. Para producción, activa facturación en [AI Studio → Uso y facturación](https://aistudio.google.com/usage); la misma clave sigue sirviendo. [Límites](https://ai.google.dev/gemini-api/docs/rate-limits).

### Flujo de lectura

1. El celular captura un frame (ImageCapture o `<video>`)
2. Lo comprime a JPEG (~960 px) y lo envía a `POST /api/lector/reconocer`
3. El servidor llama a **Gemini** (`gemini-3.1-flash-lite` por defecto)
4. `src/utils/placa.js` valida que sea una placa colombiana
5. Si la confianza es alta (≥ 90 %) se ingresa de inmediato; si no, se confirman 2 lecturas seguidas

En la UI del lector puedes:

- Dejar el escaneo automático activo (modo kiosco)
- Usar **Probar imágenes de referencia** (`public/test/placa-*.png`)
- Activar **Mostrar depuración** (texto crudo + tiempo de la IA)

---

## Build / distribución portable

`npm run build` genera una **carpeta portable** lista para copiar a otro PC Windows:

```bash
npm run build
```

Salida:

```text
dist/parqueadero/
  iniciar.bat      ← doble clic para arrancar
  LEEME.txt
  .env.example
  schema.sql
  src/
  public/
  node_modules/
  scripts/
```

En el PC destino hace falta **Node.js 18+**, MariaDB/MySQL e internet.  
Edita `.env`, ejecuta `schema.sql` si hace falta, abre `iniciar.bat` y configura la API Key de Gemini en el panel.

---

## Estructura del proyecto

```text
src/
  server.js                 # Express + HTTPS + rutas
  paths.js                  # Raíz del proyecto (dev / dist)
  config/db.js
  config/migrate.js         # Columnas nuevas en instalaciones existentes
  middleware/
  routes/                   # API REST (auth, movimientos, lector, ia, …)
  services/geminiPlateOcr.js
  utils/placa.js            # Normalización / clasificación de placas
  utils/crypto.js           # AES-256-GCM para la API Key
public/
  admin/configuracion.html  # Empresa + horarios + IA (API Key)
  admin/mensualidades.html
  admin/lector-placas.html
  js/lector-placas.js
  js/placa-utils.js
  test/                     # Imágenes de referencia
scripts/
  generar-certs.ps1
  build.ps1
  crear-empresa-local.js
schema.sql
.env.example
```

---

## API (resumen)

Todas las rutas bajo `/api/*` (salvo login) requieren `Authorization: Bearer <token>`.

| Área | Endpoints clave |
|------|-----------------|
| Auth | `POST /api/auth/login` `{ empresa, usuario, password }` |
| IA | `GET/PUT /api/ia/config`, `POST /api/ia/config/probar` (admin) |
| Lector | `POST /api/lector/reconocer` body = JPEG/PNG crudo → `{ placa, tipo, textoCrudo, confianza, ms }` |
| Movimientos | `POST /api/movimientos/ingreso` `{ placa, auto_tipo: true }` |
| Mensualidades | `GET/POST /api/mensualidades`, `GET/PUT/DELETE /api/mensualidades/:id`, `GET/POST /api/mensualidades/:id/pagos`, `GET /api/mensualidades/:id/sugerencia-pago` |
| Vehículos / tarifas / reportes / turnos / empresa | ver rutas en `src/routes/` |

---

## Scripts npm

| Script | Descripción |
|--------|-------------|
| `npm start` | Arranca el servidor |
| `npm run dev` | Arranca con nodemon |
| `npm run certs` | Genera certificados HTTPS locales (mkcert) |
| `npm run build` | Genera `dist/parqueadero/` portable |
| `npm run build:clean` | Borra `dist/` |

---

## Variables de entorno

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto (default `3000`) |
| `HTTPS` | `true` / `false` / omitir (auto si hay certs) |
| `JWT_SECRET` | Secreto JWT |
| `APP_ENCRYPTION_KEY` | Clave para cifrar la API Key de Gemini en la BD. Si se omite, se deriva de `JWT_SECRET` |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Conexión MySQL/MariaDB |

---

## Notas

- `certs/` y `.env` están en `.gitignore` (no subir secretos ni PEM)
- En producción cambia `JWT_SECRET` y `APP_ENCRYPTION_KEY`; no los subas a un repo público
- Cada empresa configura su propia API Key de Gemini desde el panel; no hay claves en el código
- El lector requiere internet; si Gemini responde 429 (cuota), espera o revisa tu plan

## Licencia

ISC © Ciscode
