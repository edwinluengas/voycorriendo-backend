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
  estadoEliminacion,
  eliminarMiCuenta,
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

// Eliminación de cuenta (requisito de Google Play y derecho de
// cancelación de la LFPDPPP). El GET dice qué pasará y qué lo impide;
// el DELETE ejecuta y exige la contraseña.
router.get   ('/mi-cuenta/eliminacion', estadoEliminacion);
router.delete('/mi-cuenta',             eliminarMiCuenta);

module.exports = router;
