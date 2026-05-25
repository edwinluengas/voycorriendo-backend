const express = require('express');
const { proteger } = require('../middleware/auth');
const {
  obtenerMisRoles,
  cambiarModo,
  guardarPushToken,
} = require('../controllers/usuariosController');

const router = express.Router();

// Todas las rutas requieren sesion
router.use(proteger);

// Multi-rol (estilo Uber/Rappi)
router.get('/mis-roles', obtenerMisRoles);
router.post('/cambiar-modo', cambiarModo);

// Push notifications
router.patch('/push-token', guardarPushToken);

module.exports = router;
