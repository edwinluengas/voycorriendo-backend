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
const adminRoutes        = require('./routes/admin.routes');
const tokensRoutes       = require('./routes/tokens.routes');
const telegramRoutes     = require('./routes/telegram.routes');

const app = express();
const httpServer = createServer(app);

// Socket.io (tiempo real)
const io = new Server(httpServer, {
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') || '*', methods: ['GET', 'POST'] },
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

  socket.on('unirse_pedido', (pedido_id) => {
    socket.join(`pedido:${pedido_id}`);
  });

  // El dueño del negocio se une a su sala para recibir 'nuevo_pedido' en tiempo real
  socket.on('unirse_negocio', (negocio_id) => {
    socket.join(`negocio:${negocio_id}`);
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
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
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
app.use('/api/admin',        adminRoutes);
app.use('/api/tokens',       tokensRoutes);
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

const iniciar = async () => {
  await conectarDB();
  // Las tablas ya fueron creadas con schema.sql - no alterar
  await sequelize.sync({ force: false });
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
