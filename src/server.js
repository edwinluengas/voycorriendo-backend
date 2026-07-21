require('dotenv').config();

// Logs para atrapar crashes silenciosos en Railway
process.on('uncaughtException',  (err) => console.error('[uncaughtException]',  err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { createServer } = require('http');
const { Server } = require('socket.io');

const { conectarDB, sequelize } = require('./config/database');
const { iniciarJobPagosSemanales } = require('./jobs/pagos-semanales.job');
const { iniciarJobPedidoTimeout } = require('./jobs/pedidoTimeout.job');
const { registrarWebhook } = require('./services/telegram.service');

// Rutas
const authRoutes         = require('./routes/auth.routes');
const usuariosRoutes     = require('./routes/usuarios.routes');
const negociosRoutes     = require('./routes/negocios.routes');
const pedidosRoutes      = require('./routes/pedidos.routes');
const repartidoresRoutes = require('./routes/repartidores.routes');
const pagosRoutes        = require('./routes/pagos.routes');
const tarjetasRoutes     = require('./routes/tarjetas.routes');
const adminRoutes        = require('./routes/admin.routes');
const telegramRoutes     = require('./routes/telegram.routes');

const app = express();
const httpServer = createServer(app);

// Socket.io (tiempo real)
const io = new Server(httpServer, {
  cors: { origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [], methods: ['GET', 'POST'] },
});

// Requiere JWT válido para toda conexión socket
io.use((socket, next) => {
  const token = socket.handshake.auth?.token
    || socket.handshake.headers?.authorization?.replace('Bearer ', '');
  if (!token) return next(new Error('AUTH_REQUIRED'));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.id;
    next();
  } catch {
    next(new Error('TOKEN_INVALIDO'));
  }
});

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id} usuario:${socket.userId}`);

  socket.on('unirse_pedido', async (pedido_id) => {
    try {
      const { Pedido, Repartidor, Negocio } = require('./models');
      const pedido = await Pedido.findByPk(pedido_id, {
        attributes: ['cliente_id', 'repartidor_id', 'negocio_id'],
        include: [
          { model: Repartidor, as: 'repartidor', attributes: ['usuario_id'] },
          { model: Negocio,    as: 'negocio',    attributes: ['usuario_id'] },
        ],
      });
      if (!pedido) return;
      const esCliente    = String(pedido.cliente_id) === String(socket.userId);
      const esRepartidor = pedido.repartidor?.usuario_id &&
        String(pedido.repartidor.usuario_id) === String(socket.userId);
      const esNegocio    = pedido.negocio?.usuario_id &&
        String(pedido.negocio.usuario_id) === String(socket.userId);
      if (!esCliente && !esRepartidor && !esNegocio) return;
      socket.join(`pedido:${pedido_id}`);
    } catch (e) {
      console.warn('[socket] Error validando acceso a pedido:', e.message);
    }
  });

  // El dueño del negocio se une a su sala para recibir 'nuevo_pedido' en tiempo real
  socket.on('unirse_negocio', async (negocio_id) => {
    try {
      const { Negocio } = require('./models');
      const negocio = await Negocio.findByPk(negocio_id, { attributes: ['usuario_id'] });
      if (!negocio || String(negocio.usuario_id) !== String(socket.userId)) return;
      socket.join(`negocio:${negocio_id}`);
    } catch (e) {
      console.warn('[socket] Error validando acceso a negocio:', e.message);
    }
  });

  // Repartidor aprobado se une a la sala global para recibir 'pedido_disponible' en tiempo real
  socket.on('unirse_repartidor', async () => {
    try {
      const { Repartidor } = require('./models');
      const rep = await Repartidor.findOne({
        where: { usuario_id: socket.userId, verificacion_estado: 'aprobado' },
        attributes: ['id'],
      });
      if (!rep) return;
      socket.join('repartidores_activos');
    } catch (e) {
      console.warn('[socket] Error validando repartidor:', e.message);
    }
  });

  socket.on('actualizar_ubicacion', async (data) => {
    const { pedido_id, lat, lng } = data || {};
    if (!pedido_id || lat === undefined || lng === undefined) return;

    // Verificar que este socket pertenece al repartidor asignado
    try {
      const Pedido = require('./models/Pedido');
      const Repartidor = require('./models/Repartidor');
      const rep = await Repartidor.findOne({ where: { usuario_id: socket.userId } });
      if (!rep) return;
      const pedido = await Pedido.findByPk(pedido_id, { attributes: ['repartidor_id'] });
      if (!pedido || String(pedido.repartidor_id) !== String(rep.id)) return;
    } catch (e) {
      console.warn('[socket] Error validando ubicacion:', e.message);
      return;
    }

    io.to(`pedido:${pedido_id}`).emit('ubicacion_repartidor', { lat, lng });
  });

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

// Hacemos io accesible desde controladores
app.set('io', io);

// Middlewares
// helmet con CSP relajada para que el panel /admin pueda cargar imagenes
// firmadas de Supabase, hacer fetch a /api y usar onclick="" inline.
// IMPORTANTE: scriptSrcAttr habilita los onclick="" (helmet lo bloquea por default).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'"],
      imgSrc:        ["'self'", 'data:', 'https:'],
      connectSrc:    ["'self'", 'https:'],
      fontSrc:       ["'self'", 'data:'],
    },
  },
}));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));

// Rate limiting global
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200,
  message: { ok: false, mensaje: 'Demasiadas solicitudes. Intenta en unos minutos.' },
}));

// Rutas
app.get('/', (req, res) => {
  res.json({
    ok: true,
    app: 'VoyCorriendo API',
    mensaje: '¡Vamos corriendo! API operativa.',
    salud: '/api/salud',
  });
});

app.get('/api/salud', (req, res) => {
  res.json({
    ok: true,
    app: 'VoyCorriendo API',
    version: '1.0.0',
    estado: 'funcionando',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth',         authRoutes);
app.use('/api/usuarios',     usuariosRoutes);
app.use('/api/negocios',     negociosRoutes);
app.use('/api/pedidos',      pedidosRoutes);
app.use('/api/repartidores', repartidoresRoutes);
app.use('/api/pagos',        pagosRoutes);
app.use('/api/tarjetas',     tarjetasRoutes);
app.use('/api/admin',        adminRoutes);
app.use('/api/telegram',     telegramRoutes);

// ─── Panel web de administracion ───────────────────────────
// Sirve los archivos estaticos del panel admin en /admin
// (login.html, dashboard.html, etc.)
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));

// Páginas legales
app.get('/terminos',   (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'terminos.html')));
app.get('/privacidad', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'privacidad.html')));

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, mensaje: 'Ruta no encontrada.' });
});

// Error global
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).json({ ok: false, mensaje: 'Error interno del servidor.' });
});

// Arrancar servidor
const PORT = process.env.PORT || 3000;

// Migraciones incrementales — idempotentes, seguras para correr en cada deploy
const migrarDB = async () => {
  const run = async (sql) => {
    try { await sequelize.query(sql); }
    catch (e) { console.warn('[migración] skipped:', sql.slice(0, 80), '→', e.message); }
  };

  // ─── OWASP audit v1.2.8 ──────────────────────────────────
  await run(`ALTER TABLE usuarios ALTER COLUMN otp_codigo TYPE VARCHAR(100)`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS otp_intentos SMALLINT NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE repartidores ALTER COLUMN clabe_bancaria TYPE TEXT`);
  await run(`ALTER TABLE negocios ALTER COLUMN clabe_bancaria TYPE TEXT`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS acepto_terminos BOOLEAN NOT NULL DEFAULT false`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS terminos_aceptados_en TIMESTAMPTZ`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS acepta_marketing BOOLEAN NOT NULL DEFAULT false`);
  await run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID NOT NULL,
    accion VARCHAR(100) NOT NULL,
    entidad_tipo VARCHAR(50) NOT NULL,
    entidad_id UUID,
    estado_antes JSONB,
    estado_despues JSONB,
    ip VARCHAR(45),
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ─── Modelo de negocio V2 ─────────────────────────────────
  // Token tiers configurables desde DB (Silver / Golden / Diamond)
  await run(`CREATE TABLE IF NOT EXISTS token_tiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(50) NOT NULL UNIQUE,
    label VARCHAR(50) NOT NULL,
    tokens INTEGER NOT NULL,
    precio NUMERIC(10,2) NOT NULL,
    vigencia_dias INTEGER NOT NULL,
    costo_por_token NUMERIC(10,4) NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT true,
    orden INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await run(`INSERT INTO token_tiers (nombre, label, tokens, precio, vigencia_dias, costo_por_token, orden)
    VALUES
      ('silver',  'Silver',  50,  1100, 45,  22, 1),
      ('golden',  'Golden',  200, 4000, 90,  20, 2),
      ('diamond', 'Diamond', 500, 9500, 120, 19, 3)
    ON CONFLICT (nombre) DO NOTHING`);

  // Historial FIFO de consumo de tokens por pedido
  await run(`CREATE TABLE IF NOT EXISTS token_consumos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_token_id UUID NOT NULL,
    restaurant_id UUID NOT NULL,
    pedido_id UUID NOT NULL,
    tokens_consumidos INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Configuración de zonas de entrega por tipo_envio
  await run(`CREATE TABLE IF NOT EXISTS config_zonas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo_envio VARCHAR(20) NOT NULL UNIQUE,
    max_km NUMERIC(5,2) NOT NULL,
    fee_base NUMERIC(10,2) NOT NULL,
    surcharge_inicio_km NUMERIC(5,2),
    surcharge_por_km NUMERIC(10,2),
    activo BOOLEAN NOT NULL DEFAULT true
  )`);
  await run(`INSERT INTO config_zonas (tipo_envio, max_km, fee_base, surcharge_inicio_km, surcharge_por_km)
    VALUES
      ('standard', 5, 35, 3, 5),
      ('express',  4, 60, NULL, NULL)
    ON CONFLICT (tipo_envio) DO NOTHING`);

  // Configuración de comisiones por método de pago y tipo de envío
  await run(`CREATE TABLE IF NOT EXISTS config_comisiones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    metodo_pago VARCHAR(50) NOT NULL,
    tipo_envio VARCHAR(20) NOT NULL,
    comision_plataforma NUMERIC(10,2) NOT NULL,
    pago_repartidor NUMERIC(10,2) NOT NULL,
    UNIQUE(metodo_pago, tipo_envio)
  )`);
  await run(`INSERT INTO config_comisiones (metodo_pago, tipo_envio, comision_plataforma, pago_repartidor)
    VALUES
      ('digital',  'standard', 5,  30),
      ('digital',  'express',  10, 50),
      ('efectivo', 'standard', 5,  30),
      ('efectivo', 'express',  10, 50)
    ON CONFLICT (metodo_pago, tipo_envio) DO NOTHING`);

  // Tabla de promociones configurables
  await run(`CREATE TABLE IF NOT EXISTS promo_config (
    clave VARCHAR(100) PRIMARY KEY,
    activo BOOLEAN NOT NULL DEFAULT false,
    fecha_inicio TIMESTAMPTZ,
    fecha_fin TIMESTAMPTZ,
    descripcion TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await run(`INSERT INTO promo_config (clave, activo, fecha_inicio, descripcion)
    VALUES ('promo_efectivo_sin_comision', true, NOW(),
      'Pedidos en efectivo: repartidor recibe tarifa completa, sin comisión de plataforma')
    ON CONFLICT (clave) DO NOTHING`);

  // Ledger de conciliación: lo cobrado vs lo pagado por pedido
  await run(`CREATE TABLE IF NOT EXISTS ledger_conciliacion (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id UUID NOT NULL UNIQUE,
    fee_envio_cobrado NUMERIC(10,2) NOT NULL,
    subtotal_productos NUMERIC(10,2) NOT NULL,
    pago_repartidor NUMERIC(10,2) NOT NULL,
    comision_plataforma NUMERIC(10,2) NOT NULL,
    metodo_pago VARCHAR(50) NOT NULL,
    tipo_envio VARCHAR(20) NOT NULL,
    liquidacion_comida VARCHAR(50),
    distancia_km NUMERIC(6,2),
    registrado_en TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Fondo del repartidor para pedidos en efectivo
  await run(`CREATE TABLE IF NOT EXISTS fondo_repartidor (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repartidor_id UUID NOT NULL UNIQUE,
    monto_disponible NUMERIC(10,2) NOT NULL DEFAULT 0,
    monto_reservado NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Caché de rutas Google Maps (evita llamadas redundantes)
  await run(`CREATE TABLE IF NOT EXISTS route_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    origen_hash VARCHAR(64) NOT NULL,
    destino_hash VARCHAR(64) NOT NULL,
    distancia_km NUMERIC(6,2) NOT NULL,
    duracion_min INTEGER,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(origen_hash, destino_hash)
  )`);

  // Columnas nuevas en tablas existentes
  await run(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS tokens_negativos_permitidos INTEGER NOT NULL DEFAULT -10`);
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS paga_con NUMERIC(10,2)`);
  await run(`ALTER TABLE restaurant_tokens ADD COLUMN IF NOT EXISTS precio_pagado NUMERIC(10,2)`);
  await run(`ALTER TABLE restaurant_tokens ADD COLUMN IF NOT EXISTS tokens_comprados INTEGER`);
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS propina NUMERIC(10,2) DEFAULT 0`);

  // Convertir pack_type de ENUM a VARCHAR (permite silver/golden/diamond + valores futuros)
  await run(`ALTER TABLE restaurant_tokens ALTER COLUMN pack_type TYPE VARCHAR(20) USING pack_type::text`);
  await run(`DROP TYPE IF EXISTS "enum_restaurant_tokens_pack_type"`);

  // ── v1.2.17 — Modelo de negocio definitivo ────────────────
  // Corregir config_comisiones: modelo flat $35 por pedido
  // pago_repartidor = 100% del envío ($35 standard, $60 express)
  // comision_plataforma = $35 flat (cobrada al restaurante, no al cliente)
  await run(`UPDATE config_comisiones SET comision_plataforma = 35, pago_repartidor = 35
    WHERE tipo_envio = 'standard'`);
  await run(`UPDATE config_comisiones SET comision_plataforma = 35, pago_repartidor = 60
    WHERE tipo_envio = 'express'`);
  // Desactivar promo_efectivo_sin_comision — ya no aplica en el modelo flat
  await run(`UPDATE promo_config SET activo = false WHERE clave = 'promo_efectivo_sin_comision'`);
  // Deuda acumulada del restaurante con la plataforma (fees efectivo no pagados)
  await run(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS deuda_plataforma NUMERIC(10,2) NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS bloqueado_por_deuda BOOLEAN NOT NULL DEFAULT false`);
  // Actualizar radio máximo de entrega a 5 km (era 6 para standard, 4 para express)
  await run(`UPDATE config_zonas SET max_km = 5 WHERE tipo_envio = 'standard' AND max_km != 5`);
  await run(`UPDATE config_zonas SET max_km = 5 WHERE tipo_envio = 'express'  AND max_km != 5`);
  // Pedido mínimo actualizado a $150 (solo si la tabla config_zonas es la fuente — el check principal está en precios.js)
  // Columna en ledger para identificar si el fee ya fue conciliado en el corte semanal
  await run(`ALTER TABLE ledger_conciliacion ADD COLUMN IF NOT EXISTS conciliado BOOLEAN NOT NULL DEFAULT false`);
  await run(`ALTER TABLE ledger_conciliacion ADD COLUMN IF NOT EXISTS conciliado_en TIMESTAMPTZ`);

  // Control de retiros pendientes — evita doble retiro del mismo saldo
  await run(`ALTER TABLE fondo_repartidor ADD COLUMN IF NOT EXISTS retiro_pendiente BOOLEAN NOT NULL DEFAULT false`);
  await run(`ALTER TABLE fondo_repartidor ADD COLUMN IF NOT EXISTS total_pagado_historico NUMERIC(10,2) NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE fondo_repartidor ADD COLUMN IF NOT EXISTS monto_pendiente_confirmar NUMERIC(10,2) NOT NULL DEFAULT 0`);

  // Perfil de usuario: direcciones guardadas, método de pago default, prefs notificaciones
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS direcciones_guardadas JSONB NOT NULL DEFAULT '[]'`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS metodo_pago_default VARCHAR(30) DEFAULT NULL`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS notif_pedidos BOOLEAN NOT NULL DEFAULT true`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS notif_marketing BOOLEAN NOT NULL DEFAULT false`);

  // Fix: cuentas registradas directo como repartidor/negocio/admin cuyo
  // modo_activo se quedó en el default 'cliente' (bug: registro no lo igualaba
  // al rol). Esto las dejaba viendo el stack de cliente y sin permiso en rutas
  // restringidas a su propio rol (ver restringirA en middleware/auth.js).
  await run(`UPDATE usuarios SET modo_activo = rol::text::"enum_usuarios_modo_activo" WHERE modo_activo = 'cliente' AND rol IN ('repartidor', 'negocio', 'admin')`);

  // nota_cancelacion: usada por el job de timeout de pedidos, existía en el
  // código pero nunca se creó la columna — se perdía silenciosamente.
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS nota_cancelacion VARCHAR(255)`);

  // Pago con tarjeta nativo (sin salir a Mercado Pago) + tarjetas guardadas
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS mp_customer_id VARCHAR(50)`);
  await run(`CREATE TABLE IF NOT EXISTS tarjetas_guardadas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id UUID NOT NULL,
    mp_card_id VARCHAR(50) NOT NULL,
    ultimos_4 VARCHAR(4) NOT NULL,
    marca VARCHAR(30),
    payment_method_id VARCHAR(30),
    issuer_id VARCHAR(30),
    exp_mes SMALLINT,
    exp_anio SMALLINT,
    titular VARCHAR(100),
    predeterminada BOOLEAN NOT NULL DEFAULT false,
    creado_en TIMESTAMPTZ DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ DEFAULT NOW()
  )`);
  await run(`ALTER TABLE tarjetas_guardadas ADD COLUMN IF NOT EXISTS payment_method_id VARCHAR(30)`);
  await run(`ALTER TABLE tarjetas_guardadas ADD COLUMN IF NOT EXISTS issuer_id VARCHAR(30)`);

  // Lock atómico contra doble cobro por doble-tap/reintento en pago con tarjeta
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pago_en_proceso BOOLEAN NOT NULL DEFAULT false`);

  // Bloqueo del negocio por deuda: ahora es por CANTIDAD de pedidos en
  // efectivo sin liquidar (15), no por monto acumulado ($1,000 antes).
  await run(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS pedidos_efectivo_pendientes INTEGER NOT NULL DEFAULT 0`);

  // Lista negra permanente: placas de repartidor y direcciones de negocio
  // que quedan vetadas para siempre tras un bloqueo por incumplimiento.
  await run(`DO $$ BEGIN
    CREATE TYPE enum_bloqueos_permanentes_tipo AS ENUM ('placa_repartidor', 'direccion_negocio');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await run(`CREATE TABLE IF NOT EXISTS bloqueos_permanentes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo enum_bloqueos_permanentes_tipo NOT NULL,
    valor VARCHAR(255) NOT NULL,
    motivo VARCHAR(255) NOT NULL,
    entidad_id_origen UUID,
    bloqueado_en TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tipo, valor)
  )`);

  // Snapshot inmutable de quién entregó cada pedido (foto + placa) — se
  // conserva aunque el repartidor luego cambie su foto o vehículo.
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS repartidor_foto_snapshot TEXT`);
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS repartidor_placa_snapshot VARCHAR(10)`);
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS repartidor_nombre_snapshot VARCHAR(100)`);

  // Baja permanente de repartidor por calificación reprobatoria
  await run(`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS baja_permanente BOOLEAN NOT NULL DEFAULT false`);

  // Negocio: la ubicación GPS confirmada ahora es obligatoria para enviar a
  // revisión / aprobar (ver negociosController.enviarARevision y
  // adminController.aprobarNegocio) — no requiere columna nueva, latitud/longitud
  // ya existían, solo se hizo obligatoria a nivel de aplicación.

  console.log('[migración] Completada.');
};

const iniciar = async () => {
  await conectarDB();
  // Las tablas ya fueron creadas con schema.sql - no alterar
  await sequelize.sync({ force: false });
  await migrarDB();
  console.log('Modelos conectados a la base de datos.');
  // 0.0.0.0 -> escuchar en todas las interfaces (necesario en Railway/Docker)
  iniciarJobPagosSemanales();
  iniciarJobPedidoTimeout();
  await registrarWebhook();
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\nVOYCORRIENDO API corriendo en puerto ${PORT}`);
    console.log(`Salud: http://localhost:${PORT}/api/salud`);
    console.log(`Entorno: ${process.env.NODE_ENV || 'development'}\n`);
  });
};

iniciar();

// Graceful shutdown (Railway envia SIGTERM en deploys)
const apagar = async (senal) => {
  console.log(`[shutdown] ${senal} recibido, cerrando servidor...`);
  httpServer.close(() => console.log('[shutdown] HTTP cerrado.'));
  try { await sequelize.close(); console.log('[shutdown] DB cerrada.'); } catch (_) {}
  process.exit(0);
};
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT',  () => apagar('SIGINT'));

module.exports = { app, io };
