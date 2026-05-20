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
const { createServer } = require('http');
const { Server } = require('socket.io');

const { conectarDB, sequelize } = require('./config/database');

// Rutas
const authRoutes         = require('./routes/auth.routes');
const usuariosRoutes     = require('./routes/usuarios.routes');
const negociosRoutes     = require('./routes/negocios.routes');
const pedidosRoutes      = require('./routes/pedidos.routes');
const repartidoresRoutes = require('./routes/repartidores.routes');
const pagosRoutes        = require('./routes/pagos.routes');
const adminRoutes        = require('./routes/admin.routes');
const tokensRoutes       = require('./routes/tokens.routes');

const app = express();
const httpServer = createServer(app);

// Socket.io (tiempo real)
const io = new Server(httpServer, {
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') || '*', methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  socket.on('unirse_pedido', (pedido_id) => {
    socket.join(`pedido:${pedido_id}`);
    console.log(`Socket ${socket.id} se unio al pedido ${pedido_id}`);
  });

  // El dueño del negocio se une a su sala para recibir 'nuevo_pedido' en tiempo real
  socket.on('unirse_negocio', (negocio_id) => {
    socket.join(`negocio:${negocio_id}`);
    console.log(`Socket ${socket.id} se unio al negocio ${negocio_id}`);
  });

  socket.on('actualizar_ubicacion', (data) => {
    // Repartidor emite su ubicacion -> cliente la recibe en tiempo real
    io.to(`pedido:${data.pedido_id}`).emit('ubicacion_repartidor', {
      lat: data.lat,
      lng: data.lng,
    });
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

// ─── Panel web de administracion ───────────────────────────
// Sirve los archivos estaticos del panel admin en /admin
// (login.html, dashboard.html, etc.)
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));

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
