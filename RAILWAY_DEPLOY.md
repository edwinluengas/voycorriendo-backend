# 🚂 Deploy en Railway — VoyCorriendo Backend

Esta guía arregla el crash del 13 de abril y deja el backend corriendo estable en la nube.

## ¿Qué causó el crash?

El `DB_HOST=db.uxchuyfwxhkpjykbgahy.supabase.co` es la **conexión directa de Supabase**, que en el plan gratuito solo resuelve por **IPv6**. Railway hace egress solo por **IPv4** → conexión a Postgres nunca se establece → `conectarDB()` llama a `process.exit(1)` → Railway reporta "Deployment crashed".

## ✅ Solución: usar el Transaction Pooler

### Paso 1 — Obtener las credenciales del Pooler en Supabase

1. Entrar a https://supabase.com/dashboard/project/uxchuyfwxhkpjykbgahy/settings/database
2. Scroll hasta **"Connection string"** y cambiar el tipo a **"Transaction"** (Pooler).
3. Anotar los valores que te muestra Supabase:
   - **Host** — algo tipo `aws-0-us-east-1.pooler.supabase.com`
   - **Port** — `6543`
   - **Database** — `postgres`
   - **User** — `postgres.uxchuyfwxhkpjykbgahy` (fíjate que el user YA trae tu project-ref al final)
   - **Password** — la misma de siempre (`Luengas1979%`)

### Paso 2 — Actualizar variables en Railway

En https://railway.com/project/6efcc274-c892-4abc-b507-c419b2ba9f8b → servicio `voycorriendo-backend` → **Variables**, configurar (o actualizar) estas:

```
NODE_ENV=production
DB_HOST=aws-0-us-east-1.pooler.supabase.com   ← el que te dio Supabase
DB_PORT=6543
DB_NAME=postgres
DB_USER=postgres.uxchuyfwxhkpjykbgahy          ← con project-ref al final
DB_PASSWORD=Luengas1979%
DB_SSL=true
JWT_SECRET=VoyCorriendoZacatepec2026SuperSecretoJWT
JWT_EXPIRES_IN=7d
ALLOWED_ORIGINS=https://voycorriendo.app,exp://*
LIMITE_EFECTIVO=1000
API_PUBLIC_URL=https://<tu-dominio-railway>   ← después del primer deploy
```

> **No** pongas `PORT`. Railway lo inyecta automáticamente y el código ya lo respeta (`process.env.PORT || 3000`).

Las de Twilio/Firebase/Mercado Pago/Google Maps se agregan cuando cada servicio se integre.

### Paso 3 — Redeploy

Railway hace redeploy automático cuando cambias variables. Si no, ve a **Deployments → Redeploy**.

### Paso 4 — Verificar

1. En los logs del deploy debes ver:
   ```
   [DB] Conectando a aws-0-us-east-1.pooler.supabase.com:6543 ssl=true
   [DB] Conexion a PostgreSQL establecida correctamente.
   Modelos conectados a la base de datos.
   VOYCORRIENDO API corriendo en puerto XXXX
   ```
2. Abrir `https://<tu-dominio-railway>/api/salud` → debe devolver:
   ```json
   {"ok":true,"app":"VoyCorriendo API","version":"1.0.0","estado":"funcionando",...}
   ```
3. Railway te marcará el servicio en verde ✅ (healthcheck pasa).

### Paso 5 — Actualizar la app móvil

Ya con Railway estable, en `voycorriendo-app/app.json` cambiar:

```json
"extra": {
  "apiUrl":    "https://<tu-dominio-railway>/api",
  "socketUrl": "https://<tu-dominio-railway>"
}
```

Rebuildear APK: `cd voycorriendo-app && npm run build:apk`.

## 🛡️ Mejoras de robustez ya aplicadas hoy al código

- **`src/server.js`**:
  - Listener en `0.0.0.0` (no solo en loopback).
  - Ruta raíz `/` para pings de healthcheck genéricos.
  - `uncaughtException` / `unhandledRejection` logueados (antes el proceso moría sin dejar rastro).
  - Graceful shutdown en `SIGTERM` y `SIGINT` (Railway los envía al redeploy).
- **`src/config/database.js`**:
  - Retry con backoff (3 intentos × 3 segundos) antes de salir.
  - Log claro con el host al que está conectando.
  - Detección automática del host directo de Supabase → imprime la pista de usar pooler.
- **`railway.json`** nuevo: declara start command, healthcheck `/api/salud`, restart policy on-failure.

## 🆘 Si sigue fallando después del fix

Revisa los logs y busca:

- `ETIMEDOUT` al host del pooler → región incorrecta (prueba otra).
- `password authentication failed` → el user debe ser `postgres.<ref>`, no solo `postgres`.
- `SSL required` → confirma `DB_SSL=true`.
- Cualquier otro error → copia y pega acá, lo vemos.
