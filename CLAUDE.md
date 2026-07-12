# VoyCorriendo Backend — Claude Instructions

## Memoria del proyecto
Toda la memoria persistente vive en:
`C:\Users\edwin\.claude\projects\C--Users-edwin\memory\`
El índice es `MEMORY.md`. Leer `project_voycorriendo.md` al inicio de cada sesión.

---

## Stack técnico
- **Node.js** + **Express** + **Sequelize** ORM
- **DB:** PostgreSQL vía Supabase (pooler de Railway en producción)
- **Auth:** JWT + token_version para revocación
- **Storage:** Supabase Storage REST API (key JWT legacy `eyJ...`)
- **Pagos:** Mercado Pago Checkout Pro
- **SMS:** Twilio (trial, +17542462564)
- **Tiempo real:** Socket.io

## Ramas y repos
- **Rama activa backend:** `master`
- **App móvil local:** `C:\Users\edwin\voycorriendo-app` (rama `claude/voy-corriendo-app-updates-MQIyw`)
- **Producción:** Railway — `https://voycorriendo-backend-production.up.railway.app`

---

## Reglas de trabajo
- Rama principal es `master` — cambios van directamente aquí
- No pedir autorización para ejecutar comandos — actuar como ingeniero de sistemas
- Deploy: `git push origin master` → Railway auto-despliega
- Al terminar trabajo significativo: actualizar `project_voycorriendo.md` en memoria

---

## Estructura de archivos clave
| Archivo | Propósito |
|---------|-----------|
| `src/server.js` | Entry point — middlewares, rutas, migraciones auto-run al arrancar |
| `src/models/index.js` | Todos los modelos Sequelize exportados |
| `src/middleware/auth.js` | `proteger` (JWT) + `restringirA(...roles)` |
| `src/config/precios.js` | PEDIDO_MINIMO, VOYTOKENS, PAGO_REPARTIDOR |
| `src/services/economia.service.js` | `procesarEntrega()` — liquida ledger al entregar pedido |
| `src/services/storage.service.js` | Upload a Supabase Storage (base64 → bucket) |
| `src/utils/crypto.js` | AES-256-GCM para CLABE bancaria |

---

## Modelos principales
| Modelo | Tabla | Notas |
|--------|-------|-------|
| `Usuario` | `usuarios` | multi-rol, `modo_activo`, `token_version`, OTP bcrypt |
| `Pedido` | `pedidos` | `codigo_entrega` (4 dígitos, crypto.randomInt), `propina`, `paga_con` |
| `Negocio` | `negocios` | `clabe_bancaria` cifrada AES-256-GCM |
| `Repartidor` | `repartidores` | `clabe_bancaria` cifrada AES-256-GCM |
| `FondoRepartidor` | `fondo_repartidor` | tracking efectivo + propinas (no escrow) |
| `LedgerConciliacion` | `ledger_conciliacion` | registro por pedido: subtotal, comisión, liquidación |
| `RestaurantToken` | `restaurant_tokens` | tokens de negocio, consumo FIFO al confirmar pedido |

---

## Patrón de migraciones
Las migraciones son SQL idempotente ejecutado en `server.js → migrarDB()` al arrancar.
Para agregar una columna nueva:
```js
await run(`ALTER TABLE tabla ADD COLUMN IF NOT EXISTS columna TYPE DEFAULT valor`);
```
Nunca usar archivos de migración separados — todo va en `migrarDB()`.

---

## Auth y roles
- `proteger` — verifica JWT + `token_version` (revocación) + estado cuenta
- `restringirA('negocio', 'admin')` — restringe por `usuario.rol` (rol de registro, NO modo_activo)
- Multi-rol: `req.usuario.modo_activo` es el rol activo en sesión
- Para scoping de datos: siempre buscar entidad por `usuario_id: req.usuario.id`, nunca por param URL sin verificar ownership

---

## Reglas de negocio (CRÍTICAS — no romper)
1. **La plataforma NUNCA custodia dinero de comida.** No implementar wallet, escrow ni saldos para fondos de terceros.
2. **La tarifa de envío la paga el CLIENTE** y es ingreso del REPARTIDOR, sujeto a comisión de plataforma según método de pago.
3. **EXPRESS siempre viaja solo** — no se puede combinar en batch con otros pedidos.
4. **Propina** va 100% al fondo del repartidor, sin comisión de plataforma. Usar `findOrCreate + increment` (no upsert con literal SQL).
5. **Pedido mínimo:** `PEDIDO_MINIMO` desde `config/precios.js` (actualmente $100 MXN).
6. **Efectivo:** límite $500 MXN de **subtotal** (el envío se suma encima — validado en `crearPedido`).
7. **Transferencia SPEI:** solo para negocios con `categoria === 'ahivoy store'` (Voy Store® — marca registrada IMPI).

---

## Seguridad OWASP (no revertir estos fixes)
- `codigo_entrega`: generado con `crypto.randomInt(1000, 10000)` en `crearPedido`. **Nunca regenerar** en `aceptarPedido` ni en ningún otro controlador.
- `obtenerPedido`: excluir `codigo_entrega` de la respuesta cuando el caller es repartidor (`esRepartidor && !esCliente && !esAdmin`).
- `calificarPedido`: validar `propina` en [0, 1000] y `calificaciones` como entero [1, 5] antes de tocar la DB.
- OTP: hasheado con bcrypt (cost 10), max 5 intentos, `crypto.randomInt()`.
- CLABE bancaria: cifrada/descifrada con `src/utils/crypto.js` (AES-256-GCM).
- Logs: enmascarar PII (teléfonos → `***XXXX`).
- JWT logout: incrementar `token_version` en el usuario.

---

## Endpoints nuevos (v1.2.10)
| Método | Ruta | Controlador |
|--------|------|-------------|
| GET | `/api/repartidores/ganancias` | `repartidoresController.ganancias` |
| POST | `/api/repartidores/solicitar-deposito` | `repartidoresController.solicitarDeposito` |
| GET | `/api/negocios/mi-negocio/ganancias` | `negociosController.gananciasNegocio` |
