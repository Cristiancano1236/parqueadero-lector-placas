# ParkSystem — Parqueadero con lector de placas

Aplicación **Node.js + Express + MariaDB/MySQL** para gestionar parqueaderos multi-empresa: ingresos/salidas, tarifas, pagos, **mensualidades**, reportes, turnos de caja y **lector automático de placas** (PaddleOCR en el servidor).

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
  - OCR con **PaddleOCR (ONNX)** en el servidor — sin API de pago, sin Python, sin GPU
  - Clasificación automática carro (`ABC123`) / moto (`ABC12D`)
  - Ingreso automático con consenso multi-frame y cooldown
- **HTTPS local** para pruebas de cámara desde el celular en la misma WiFi

---

## Requisitos

- **Node.js 18+** y npm
- **MariaDB / MySQL 10.4+**
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
OCR: modelos PaddleOCR listos
```

- Login: `GET /` → `public/index.html`
- Mensualidades: menú **Mensualidades** (tras iniciar sesión)
- Lector: menú **Lector de placas** (tras iniciar sesión)

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

## Lector de placas (PaddleOCR)

Flujo:

1. El celular captura un frame (ImageCapture o `<video>`)
2. Lo comprime a JPEG (~960 px) y lo envía a `POST /api/lector/reconocer`
3. El servidor corre **PP-OCRv5_mobile** (detección + reconocimiento)
4. `src/utils/placa.js` extrae una placa colombiana válida del texto
5. El cliente acumula lecturas (consenso multi-frame) e ingresa el vehículo

Modelos (ya incluidos en el repo):

```text
models/paddleocr/ppocr_v5_mobile/
  PP-OCRv5_mobile_det_infer.onnx
  PP-OCRv5_mobile_rec_infer.onnx
  ppocrv5_dict.txt
```

En la UI del lector puedes:

- Dejar el escaneo automático activo (modo kiosco)
- Usar **Probar imágenes de referencia** (`public/test/placa-*.png`)
- Activar **Mostrar depuración** (texto crudo + tiempo de OCR)

---

## Build / distribución portable

`sharp` y `onnxruntime-node` usan binarios nativos: un `.exe` único con `pkg` no es fiable.  
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
  models/          ← modelos OCR
  node_modules/    ← dependencias de producción (incluye nativos)
  scripts/
```

En el PC destino hace falta **Node.js 18+** y MariaDB/MySQL.  
Edita `.env`, ejecuta `schema.sql` si hace falta, y abre `iniciar.bat`.

---

## Estructura del proyecto

```text
src/
  server.js                 # Express + HTTPS + rutas
  paths.js                  # Raíz del proyecto (dev / dist)
  config/db.js
  middleware/
  routes/                   # API REST (auth, movimientos, lector, …)
  services/plateOcr.js      # PaddleOCR (ONNX)
  utils/placa.js            # Normalización / clasificación de placas
public/
  admin/mensualidades.html  # Gestión de mensualidades
  admin/lector-placas.html  # Kiosco de lectura
  js/lector-placas.js
  js/placa-utils.js
  test/                     # Imágenes de referencia OCR
models/paddleocr/           # Modelos ONNX (servidor)
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
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Conexión MySQL/MariaDB |

---

## Notas

- `certs/` y `.env` están en `.gitignore` (no subir secretos ni PEM)
- En producción cambia `JWT_SECRET` y usa contraseñas fuertes
- El empaquetado antiguo con `pkg` (`.exe` único) se dejó de lado porque no incluye bien los binarios nativos del OCR; usa `npm run build` (portable)

## Licencia

ISC © Ciscode
