require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { createServer } = require('http');
const { Server } = require('socket.io');

const { conectarDB, sequelize } = require('./config/database');

// Rutas
const authRoutes         = require('./routes/auth.routes');
const negociosRoutes     = require('./routes/negocios.routes');
const pedidosRoutes      = require('./routes/pedidos.routes');
const repartidoresRoutes = require('./routes/repartidores.routes');

const app = express();
const httpServer = createServer(app);

// ─── Socket.io (tiempo real) ─────────────────────────────
const io = new Server(httpServer, {
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') || '*', methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  socket.on('unirse_pedido', (pedido_id) => {
    socket.join(`pedido:${pedido_id}`);
    console.log(`📦 Socket ${socket.id} se unió al pedido ${pedido_id}`);
  });

  socket.on('actualizar_ubicacion', (data) => {
    // Repartidor emite su ubicación → cliente la recibe en tiempo real
    io.to(`pedido:${data.pedido_id}`).emit('ubicacion_repartidor', {
      lat: data.lat,
      lng: data.lng,
    });
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Cliente desconectado: ${socket.id}`);
  });
});

// Hacemos io accesible desde controladores
app.set('io', io);

// ─── Middlewares ─────────────────────────────────────────
app.use(helmet());
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

// ─── Rutas ───────────────────────────────────────────────
app.get('/api/salud', (req, res) => {
  res.json({
    ok: true,
    app: 'Mandaditos API',
    version: '1.0.0',
    estado: 'funcionando',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth',         authRoutes);
app.use('/api/negocios',     negociosRoutes);
app.use('/api/pedidos',      pedidosRoutes);
app.use('/api/repartidores', repartidoresRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, mensaje: 'Ruta no encontrada.' });
});

// Error global
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.stack);
  res.status(500).json({ ok: false, mensaje: 'Error interno del servidor.' });
});

// ─── Arrancar servidor ───────────────────────────────────
const PORT = process.env.PORT || 3000;

const iniciar = async () => {
  await conectarDB();
  // Las tablas ya fueron creadas con schema.sql — no alterar
  await sequelize.sync({ force: false });
  console.log('✅ Modelos conectados a la base de datos.');
  httpServer.listen(PORT, () => {
    console.log(`\n🛵  MANDADITOS API corriendo en puerto ${PORT}`);
    console.log(`🌐  Salud: http://localhost:${PORT}/api/salud`);
    console.log(`📌  Entorno: ${process.env.NODE_ENV || 'development'}\n`);
  });
};

iniciar();

module.exports = { app, io };
