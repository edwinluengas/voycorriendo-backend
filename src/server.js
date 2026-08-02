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
// El job de "pagos semanales SPEI" se ELIMINÓ (2026-07-29): leía filas de
// DriverPayment que NINGÚN código creaba nunca, así que cada viernes corría y
// no pagaba nada — daba la falsa impresión de que las liquidaciones estaban
// automatizadas. El pago real al repartidor se hace por
// `repartidoresController.solicitarDeposito` / `retiroDiario`, y el corte del
// negocio por `POST /admin/negocios/:id/liquidar-semanal`.
const { iniciarJobPedidoTimeout } = require('./jobs/pedidoTimeout.job');
const { iniciarJobLimpiezaIneCliente } = require('./jobs/limpiezaIneCliente.job');
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

  // Sala PRIVADA por usuario. Existe para lo que no debe pasar por la sala
  // compartida del pedido: a `pedido:<id>` están unidos el cliente, el
  // negocio Y el repartidor, así que todo lo que se emite ahí lo ven los
  // tres. El código de entrega se manda por aquí.
  if (socket.userId) socket.join(`usuario:${socket.userId}`);

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
      // Sala personal: por aquí le llega el aviso de "otro pedido en tu misma
      // ruta" (solo a quien de verdad le queda de paso, no a todos).
      socket.join(`repartidor:${rep.id}`);
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
      // Moverse con un pedido asignado es la señal de vida más fuerte que
      // existe: está literalmente en la calle entregando.
      require('./services/disponibilidad.service').registrarLatido(rep.id);
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

// Railway pone un único reverse proxy delante de la app — sin esto,
// express-rate-limit usa la IP del proxy para TODOS los requests (ve el
// mismo IP siempre), así que el límite de 200/15min termina siendo GLOBAL
// para todos los usuarios juntos en vez de por persona (un solo usuario con
// mucho tráfico legítimo podía bloquear a todos los demás). `1` = confiar
// en un solo hop de proxy, ni más ni menos.
app.set('trust proxy', 1);

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

// Configuración pública que la app consulta al arrancar. Permite prender o
// apagar cosas (p. ej. el pago con tarjeta) cambiando una variable de entorno
// en Railway, SIN tener que compilar y distribuir un APK nuevo. No expone
// nada sensible: son las mismas reglas que el cliente ya ve en pantalla.
app.get('/api/config-publica', (req, res) => {
  const p = require('./config/precios');
  res.json({
    ok: true,
    data: {
      metodos_pago_activos: p.metodosPagoActivos(),
      limite_efectivo:      p.LIMITE_EFECTIVO,
      pedido_minimo:        p.PEDIDO_MINIMO,
      fee_envio:            { standard: p.TARIFAS_CLIENTE.STANDARD, express: p.TARIFAS_CLIENTE.EXPRESS },
      max_km:               p.MAX_DISTANCE_KM,
      max_pedidos_ruta:     3,
      // Canales por los que HOY se puede entregar un código de recuperación.
      // La app usa esto para no ofrecerle al usuario una opción que no va a
      // llegarle: el correo depende de que haya proveedor configurado y el
      // SMS de que Twilio esté activo. Telegram siempre se ofrece — depende
      // de que cada usuario lo tenga vinculado, no del servidor.
      canales_recuperacion: require('./utils/canalesRecuperacion').canalesActivos(),
      // Plazas donde opera el servicio. La app las usa para que el cliente
      // elija la suya (o se detecta por GPS): son pueblos distintos y a ~25 km,
      // asi que el catalogo de uno no tiene por que verse en el otro.
      ciudades: require('./config/ciudades').CIUDADES.map((c) => ({
        slug: c.slug, nombre: c.nombre, marca: c.marca, estado: c.estado,
        latitud: c.latitud, longitud: c.longitud,
      })),
      ciudad_default: require('./config/ciudades').CIUDAD_DEFAULT,
    },
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

// ─── Páginas legales públicas ──────────────────────────────
// Google Play exige una URL pública de política de privacidad para publicar
// la app: no basta con tenerla dentro. Van en la raíz (/privacidad y
// /terminos), no bajo /api, porque las abre una persona en su navegador.
app.use('/', require('./routes/legal.routes'));

// ─── Panel web de administracion ───────────────────────────
// Sirve los archivos estaticos del panel admin en /admin
// (login.html, dashboard.html, etc.)
// El panel admin no debe aparecer en buscadores ni quedar cacheado en el
// navegador/CDN: cualquier pista pública de dónde está y qué contiene es
// ayuda gratis para quien busque atacarlo. El contenido en sí no expone
// datos (todo lo pide con token), pero no hay razón para publicarlo.
app.use('/admin', (req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.set('Cache-Control', 'no-store');
  next();
});
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

  // ─── Sistema de tokens: ELIMINADO (2026-07-19) ────────────
  // El modelo de negocio con tokens se retiró por completo; nada del código
  // los lee ni los escribe. Aquí quedaban el CREATE de `token_tiers`,
  // `token_consumos` y su seed — y ese INSERT fallaba en CADA arranque
  // ("null value in column id"), porque la tabla se creó alguna vez sin el
  // DEFAULT de id. Era un error recurrente en los logs que ya no significaba
  // nada: sembrar precios de un producto que no existe. Se quitaron los
  // CREATE y el seed. Las TABLAS viejas se dejan en la base (sin DROP) por si
  // alguien quiere consultar el histórico; están inertes.

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
  // Defensivo: esta tabla se creó alguna vez SIN este default (versión vieja
  // del código, antes de que existiera "DEFAULT gen_random_uuid()" aquí) y
  // como CREATE TABLE IF NOT EXISTS nunca la vuelve a tocar, el INSERT de
  // abajo llevaba fallando en silencio desde entonces — la tabla quedó
  // vacía y todo corrió sobre el fallback hardcodeado (ver hallazgo real
  // del mismo bug en config_comisiones, 2026-07-22). Este ALTER se
  // autorepara sin importar en qué estado esté la tabla.
  await run(`ALTER TABLE config_zonas ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
  await run(`INSERT INTO config_zonas (tipo_envio, max_km, fee_base, surcharge_inicio_km, surcharge_por_km)
    VALUES
      ('standard', 5, 40, NULL, NULL),
      ('express',  5, 60, NULL, NULL)
    ON CONFLICT (tipo_envio) DO UPDATE SET max_km = EXCLUDED.max_km, fee_base = EXCLUDED.fee_base,
      surcharge_inicio_km = EXCLUDED.surcharge_inicio_km, surcharge_por_km = EXCLUDED.surcharge_por_km`);

  // Configuración de comisiones por método de pago y tipo de envío
  await run(`CREATE TABLE IF NOT EXISTS config_comisiones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    metodo_pago VARCHAR(50) NOT NULL,
    tipo_envio VARCHAR(20) NOT NULL,
    comision_plataforma NUMERIC(10,2) NOT NULL,
    pago_repartidor NUMERIC(10,2) NOT NULL,
    UNIQUE(metodo_pago, tipo_envio)
  )`);
  // Defensivo — mismo motivo que config_zonas arriba. Este fue el bug REAL
  // que causó que los repartidores cobraran $30 en vez de $35: el INSERT de
  // abajo (y el UPDATE del modelo v1.2.17 más adelante) llevaban fallando en
  // silencio desde siempre porque la tabla nunca tuvo el default de id, así
  // que quedaba vacía y economia.service usaba el fallback viejo de
  // config.service.getComision(). Corregido en producción + aquí para que
  // se autorepare en cualquier entorno.
  await run(`ALTER TABLE config_comisiones ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
  await run(`INSERT INTO config_comisiones (metodo_pago, tipo_envio, comision_plataforma, pago_repartidor)
    VALUES
      ('digital',  'standard', 35, 35),
      ('digital',  'express',  35, 60),
      ('efectivo', 'standard', 35, 35),
      ('efectivo', 'express',  35, 60)
    ON CONFLICT (metodo_pago, tipo_envio) DO UPDATE SET comision_plataforma = EXCLUDED.comision_plataforma, pago_repartidor = EXCLUDED.pago_repartidor`);

  // Tabla de promociones configurables
  await run(`CREATE TABLE IF NOT EXISTS promo_config (
    clave VARCHAR(100) PRIMARY KEY,
    activo BOOLEAN NOT NULL DEFAULT false,
    fecha_inicio TIMESTAMPTZ,
    fecha_fin TIMESTAMPTZ,
    descripcion TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  // Defensivo — mismo bug de default faltante que config_zonas/config_comisiones.
  await run(`ALTER TABLE promo_config ALTER COLUMN updated_at SET DEFAULT NOW()`);
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

  // Contador propio de llamadas facturables a Google Maps. Las cuotas de la
  // consola de Google topan CANTIDAD de solicitudes, no dinero: este es el
  // freno que vive en nuestro código (ver services/cuotaGoogle.service.js).
  await run(`CREATE TABLE IF NOT EXISTS google_api_uso (
    dia DATE PRIMARY KEY,
    llamadas INTEGER NOT NULL DEFAULT 0,
    alertado_diario BOOLEAN NOT NULL DEFAULT false,
    alertado_mensual BOOLEAN NOT NULL DEFAULT false,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Columnas nuevas en tablas existentes
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS paga_con NUMERIC(10,2)`);
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS propina NUMERIC(10,2) DEFAULT 0`);
  // Se quitaron los ALTER de `restaurant_tokens` y de
  // `negocios.tokens_negativos_permitidos`: pertenecen al sistema de tokens
  // eliminado y se ejecutaban en cada arranque para mantener columnas que
  // nadie lee.

  // ── v1.2.17 — Modelo de negocio definitivo ────────────────
  // comision_plataforma = $35 flat, cobrada al RESTAURANTE (no al cliente).
  // No se toca pago_repartidor aquí: ese es el 100% del envío y se fija más
  // abajo junto con la tarifa (antes este UPDATE lo regresaba a 35 en cada
  // arranque y peleaba con el valor vigente).
  await run(`UPDATE config_comisiones SET comision_plataforma = 35 WHERE comision_plataforma != 35`);
  // Desactivar promo_efectivo_sin_comision — ya no aplica en el modelo flat
  await run(`UPDATE promo_config SET activo = false WHERE clave = 'promo_efectivo_sin_comision'`);
  // Deuda acumulada del restaurante con la plataforma (fees efectivo no pagados)
  await run(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS deuda_plataforma NUMERIC(10,2) NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS bloqueado_por_deuda BOOLEAN NOT NULL DEFAULT false`);
  // Actualizar radio máximo de entrega a 5 km (era 6 para standard, 4 para express)
  await run(`UPDATE config_zonas SET max_km = 5 WHERE tipo_envio = 'standard' AND max_km != 5`);
  await run(`UPDATE config_zonas SET max_km = 5 WHERE tipo_envio = 'express'  AND max_km != 5`);
  // TARIFA PLANA (2026-07-26): el envío no depende de la distancia. La fila
  // 'standard' tenía surcharge_inicio_km=3 / surcharge_por_km=5 desde el seed
  // original, así que todo pedido a más de 3 km cobraba $5 extra por km — por
  // eso la tarifa "cambiaba" entre pedidos (ej. 4.71 km → $43.55 en vez de
  // $35). Se limpian las columnas y el código ya no las lee (utils/precios.js).
  await run(`UPDATE config_zonas SET surcharge_inicio_km = NULL, surcharge_por_km = NULL
    WHERE surcharge_inicio_km IS NOT NULL OR surcharge_por_km IS NOT NULL`);
  // Tarifa estándar $35 → $40 (2026-07-26): a 5 km de cobertura, $35 dejaba
  // al repartidor por debajo del salario mínimo por hora una vez descontados
  // gasolina, mantenimiento y depreciación. El pago al repartidor es el 100%
  // del envío, así que sube junto con la tarifa.
  await run(`UPDATE config_zonas SET fee_base = 40 WHERE tipo_envio = 'standard' AND fee_base != 40`);
  await run(`UPDATE config_zonas SET fee_base = 60 WHERE tipo_envio = 'express'  AND fee_base != 60`);
  await run(`UPDATE config_comisiones SET pago_repartidor = 40 WHERE tipo_envio = 'standard' AND pago_repartidor != 40`);
  await run(`UPDATE config_comisiones SET pago_repartidor = 60 WHERE tipo_envio = 'express'  AND pago_repartidor != 60`);
  // Pedido mínimo actualizado a $150 (solo si la tabla config_zonas es la fuente — el check principal está en precios.js)
  // Ledger: liquidación al negocio y al repartidor son pagos INDEPENDIENTES
  // (montos y fechas distintas) — antes compartían una sola columna
  // `conciliado`, así que el que se pagara primero (negocio o repartidor)
  // marcaba la fila como liquidada y el otro perdía su parte de ese pedido
  // para siempre. Se reemplaza por dos banderas separadas.
  await run(`ALTER TABLE ledger_conciliacion ADD COLUMN IF NOT EXISTS conciliado_negocio BOOLEAN NOT NULL DEFAULT false`);
  await run(`ALTER TABLE ledger_conciliacion ADD COLUMN IF NOT EXISTS conciliado_negocio_en TIMESTAMPTZ`);
  await run(`ALTER TABLE ledger_conciliacion ADD COLUMN IF NOT EXISTS conciliado_repartidor BOOLEAN NOT NULL DEFAULT false`);
  await run(`ALTER TABLE ledger_conciliacion ADD COLUMN IF NOT EXISTS conciliado_repartidor_en TIMESTAMPTZ`);
  // Migra el estado de la columna legacy (si alguna fila ya estaba marcada,
  // se asume liquidada en ambos lados para no perder ni duplicar pagos) y la
  // elimina — ya no se usa en ningún camino de código.
  await run(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledger_conciliacion' AND column_name = 'conciliado') THEN
        UPDATE ledger_conciliacion SET conciliado_negocio = true, conciliado_negocio_en = conciliado_en, conciliado_repartidor = true, conciliado_repartidor_en = conciliado_en WHERE conciliado = true;
        ALTER TABLE ledger_conciliacion DROP COLUMN conciliado;
        ALTER TABLE ledger_conciliacion DROP COLUMN conciliado_en;
      END IF;
    END $$;
  `);

  // Registro de liquidaciones (depósitos reales) a negocio y repartidor —
  // separado del ledger para dejar constancia de cada pago: cuánto se debía
  // (monto_calculado) vs cuánto se depositó de verdad (monto_depositado,
  // confirmado por un admin con referencia SPEI). Queda 'pendiente' desde que
  // se solicita/ejecuta el corte hasta que un admin confirma el depósito real.
  await run(`CREATE TABLE IF NOT EXISTS liquidaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entidad_tipo VARCHAR(20) NOT NULL CHECK (entidad_tipo IN ('negocio', 'repartidor')),
    entidad_id UUID NOT NULL,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('retiro_diario', 'corte_semanal')),
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'confirmado')),
    monto_calculado NUMERIC(10,2) NOT NULL,
    monto_depositado NUMERIC(10,2),
    diferencia NUMERIC(10,2),
    referencia_spei VARCHAR(100),
    pedidos_liquidados INTEGER NOT NULL DEFAULT 0,
    ledger_ids JSONB NOT NULL DEFAULT '[]',
    admin_id UUID,
    confirmado_en TIMESTAMPTZ,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_liquidaciones_entidad ON liquidaciones (entidad_tipo, entidad_id, estado)`);

  // Reserva ledger rows dentro de una liquidación pendiente (evita que dos
  // solicitudes simultáneas — negocio/repartidor pidiendo retiro dos veces
  // seguidas — reclamen el mismo pedido dos veces antes de que un admin
  // confirme el primero).
  await run(`ALTER TABLE ledger_conciliacion ADD COLUMN IF NOT EXISTS liquidacion_negocio_id UUID`);
  await run(`ALTER TABLE ledger_conciliacion ADD COLUMN IF NOT EXISTS liquidacion_repartidor_id UUID`);

  // Control de retiros pendientes — evita doble retiro del mismo saldo
  await run(`ALTER TABLE fondo_repartidor ADD COLUMN IF NOT EXISTS retiro_pendiente BOOLEAN NOT NULL DEFAULT false`);
  await run(`ALTER TABLE fondo_repartidor ADD COLUMN IF NOT EXISTS total_pagado_historico NUMERIC(10,2) NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE fondo_repartidor ADD COLUMN IF NOT EXISTS monto_pendiente_confirmar NUMERIC(10,2) NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE fondo_repartidor ADD COLUMN IF NOT EXISTS saldo_por_cobrar NUMERIC(10,2) NOT NULL DEFAULT 0`);

  // Modelo de liquidación cuenta concentradora (2026-07-23)
  await run(`CREATE TABLE IF NOT EXISTS perdidas_pedido (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id UUID NOT NULL UNIQUE,
    negocio_id UUID,
    repartidor_id UUID,
    monto NUMERIC(10,2) NOT NULL,
    tipo VARCHAR(15) NOT NULL DEFAULT 'normal',
    estado VARCHAR(15) NOT NULL DEFAULT 'activa',
    cargo_restaurante NUMERIC(10,2) NOT NULL DEFAULT 0,
    cargo_repartidor NUMERIC(10,2) NOT NULL DEFAULT 0,
    cargo_plataforma NUMERIC(10,2) NOT NULL DEFAULT 0,
    nota TEXT,
    creado_en TIMESTAMPTZ DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ DEFAULT NOW()
  )`);
  // Prorrateo de la comisión de Mercado Pago + IVA por transacción
  await run(`ALTER TABLE ledger_conciliacion ADD COLUMN IF NOT EXISTS fee_mp_negocio NUMERIC(10,2) NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE ledger_conciliacion ADD COLUMN IF NOT EXISTS fee_mp_repartidor NUMERIC(10,2) NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE ledger_conciliacion ADD COLUMN IF NOT EXISTS credito_aplicado NUMERIC(10,2) NOT NULL DEFAULT 0`);

  // Crédito de plataforma para clientes (2026-07-24) — otorgado libremente
  // por un admin, o como compensación por un pedido no entregado, usable
  // en cualquier tienda al pagar.
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS credito_disponible NUMERIC(10,2) NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS credito_aplicado NUMERIC(10,2) NOT NULL DEFAULT 0`);
  await run(`CREATE TABLE IF NOT EXISTS creditos_cliente (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id UUID NOT NULL,
    monto NUMERIC(10,2) NOT NULL,
    motivo TEXT NOT NULL,
    pedido_id UUID,
    otorgado_por UUID,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`);

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

  // ── Teléfonos internacionales (2026-07-26) ────────────────────
  // Puerto Escondido tiene mucha afluencia extranjera: el número deja de ser
  // "10 dígitos mexicanos" y pasa a ser (lada + número nacional). La unicidad
  // se vuelve COMPUESTA — dos países pueden tener el mismo número nacional.
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS lada VARCHAR(5) NOT NULL DEFAULT '52'`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pais VARCHAR(2) NOT NULL DEFAULT 'MX'`);
  // Se quita el UNIQUE simple sobre telefono y se crea el compuesto. Si ya
  // hubiera duplicados (imposible hoy: el UNIQUE viejo lo impedía), el
  // CREATE UNIQUE fallaría — por eso el índice se crea ANTES de soltar el
  // viejo y todo el bloque va en un DO con manejo de error explícito.
  await run(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='usuarios' AND indexname='usuarios_lada_telefono_key') THEN
      CREATE UNIQUE INDEX usuarios_lada_telefono_key ON usuarios (lada, telefono);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='usuarios_telefono_key') THEN
      ALTER TABLE usuarios DROP CONSTRAINT usuarios_telefono_key;
    END IF;
  END $$;`);

  // Recuperación de contraseña por SMS o email (2026-07-26)
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_codigo VARCHAR(100)`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_expira TIMESTAMPTZ`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_intentos SMALLINT NOT NULL DEFAULT 0`);

  // Entregas en bicicleta eliminadas (2026-07-26, decisión del dueño): toda
  // entrega es en motocicleta. Se migran los perfiles que quedaron en bici.
  await run(`ALTER TABLE repartidores ALTER COLUMN tipo_vehiculo TYPE VARCHAR(20) USING tipo_vehiculo::text`);
  await run(`DROP TYPE IF EXISTS "enum_repartidores_tipo_vehiculo"`);
  await run(`UPDATE repartidores SET tipo_vehiculo = 'motocicleta' WHERE tipo_vehiculo = 'bicicleta'`);
  await run(`ALTER TABLE repartidores ALTER COLUMN tipo_vehiculo SET DEFAULT 'motocicleta'`);

  // ── Candados de seguridad de cuentas (2026-07-26) ─────────────
  // Bloqueo por intentos fallidos + segundo factor obligatorio para admins.
  // Ver services/seguridadAdmin.service.js.
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS intentos_fallidos SMALLINT NOT NULL DEFAULT 0`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_hasta TIMESTAMPTZ`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_login_ip VARCHAR(45)`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS admin_2fa_activo BOOLEAN NOT NULL DEFAULT true`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS login2fa_codigo VARCHAR(100)`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS login2fa_expira TIMESTAMPTZ`);
  await run(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS login2fa_intentos SMALLINT NOT NULL DEFAULT 0`);
  // La bitácora se consulta por admin y por fecha; sin índice, cada revisión
  // de "quién hizo qué" barre la tabla completa.
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_admin_fecha ON audit_logs (admin_id, creado_en DESC)`);

  // ── Latido de actividad del repartidor (2026-07-30) ───────────
  // Sin esto, `conectado = true` era un flag que nadie apagaba: una cuenta
  // llevaba CINCO DÍAS marcada en línea (prendió el switch y cerró la app),
  // el sistema creyó que había servicio a domicilio y aceptó un pedido que
  // nadie recogió (MND-151740). Ahora se exige señal de vida reciente.
  await run(`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS ultimo_latido TIMESTAMPTZ`);
  await run(`CREATE INDEX IF NOT EXISTS idx_repartidores_disponibles
    ON repartidores (conectado, ultimo_latido) WHERE conectado = true`);
  // Los que ya estaban marcados como conectados no tienen latido: se apagan
  // para no arrastrar el dato mentiroso al primer arranque con este código.
  await run(`UPDATE repartidores SET conectado = false WHERE conectado = true AND ultimo_latido IS NULL`);

  // ── PICKUP habilitado en la base (2026-07-29) ─────────────────
  // El CHECK original solo admitía 'standard' y 'express', así que un pedido
  // para recoger en tienda REVENTABA con error 500 aunque el código lo
  // soportara desde hace tiempo (nunca se había podido usar).
  await run(`ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_tipo_envio_check`);
  await run(`ALTER TABLE pedidos ADD CONSTRAINT pedidos_tipo_envio_check
    CHECK (tipo_envio IN ('standard', 'express', 'pickup'))`);

  // El tope de efectivo vive en config/precios.js (hoy $700 de productos).
  // Había además un CHECK fijo de "total <= 1000" que, al subir el tope,
  // habría rechazado pedidos con un error 500 sin mensaje entendible. Se
  // reemplaza por un techo absurdo (solo atrapa basura) y la regla real la
  // aplica la aplicación, que sí puede explicarle al cliente qué pasó.
  await run(`ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS limite_efectivo`);
  await run(`ALTER TABLE pedidos ADD CONSTRAINT limite_efectivo
    CHECK (metodo_pago <> 'efectivo' OR total <= 10000)`);

  console.log('[migración] Completada.');
};

const iniciar = async () => {
  await conectarDB();
  // Las tablas ya fueron creadas con schema.sql - no alterar
  await sequelize.sync({ force: false });
  await migrarDB();
  console.log('Modelos conectados a la base de datos.');
  // 0.0.0.0 -> escuchar en todas las interfaces (necesario en Railway/Docker)
  iniciarJobPedidoTimeout();
  iniciarJobLimpiezaIneCliente();
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
