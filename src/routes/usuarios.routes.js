const express = require('express');
const { proteger } = require('../middleware/auth');
const {
  obtenerMisRoles,
  cambiarModo,
  guardarPushToken,
  misDirecciones,
  agregarDireccion,
  eliminarDireccion,
  misCalificaciones,
  getMetodoPagoDefault,
  setMetodoPagoDefault,
  getNotificaciones,
  setNotificaciones,
} = require('../controllers/usuariosController');

const router = express.Router();

router.use(proteger);

// Multi-rol
router.get('/mis-roles',    obtenerMisRoles);
router.post('/cambiar-modo', cambiarModo);

// Push notifications
router.patch('/push-token', guardarPushToken);

// Direcciones guardadas
router.get   ('/mis-direcciones',      misDirecciones);
router.post  ('/mis-direcciones',      agregarDireccion);
router.delete('/mis-direcciones/:id',  eliminarDireccion);

// Método de pago default
router.get  ('/metodo-pago-default', getMetodoPagoDefault);
router.patch('/metodo-pago-default', setMetodoPagoDefault);

// Mis calificaciones dadas
router.get('/mis-calificaciones', misCalificaciones);

// Preferencias de notificaciones
router.get  ('/notificaciones', getNotificaciones);
router.patch('/notificaciones', setNotificaciones);

module.exports = router;
