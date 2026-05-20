const express = require('express');
const { body } = require('express-validator');
const {
  // Onboarding nuevo (multi-rol estilo Uber)
  activarModo,
  actualizarPerfil,
  subirFoto,
  enviarARevision,
  conectarse,
  // Operacion
  crearPerfil,                  // legacy
  actualizarDisponibilidad,
  misEntregas,
  pedidosDisponibles,
  aceptarPedido,
  miRuta,
} = require('../controllers/repartidoresController');
const { proteger } = require('../middleware/auth');

const router = express.Router();

// Todas las rutas requieren login. NO restringimos por rol aqui:
// cualquier usuario puede ACTIVAR modo repartidor desde su perfil.
// La validacion fina (verificacion_estado, estado_cuenta) la hace
// cada controlador.
router.use(proteger);

// ─── Onboarding (wizard multi-paso) ──────────────────────
router.post ('/activar',           activarModo);
router.patch('/perfil',            actualizarPerfil);
router.post ('/foto',              subirFoto);
router.post ('/enviar-a-revision', enviarARevision);

// ─── Conexion (Go Online estilo Uber) ────────────────────
router.patch('/conectarse', [
  body('conectado').isBoolean(),
], conectarse);

// ─── Operacion del repartidor ya verificado ──────────────
router.patch('/disponibilidad', [
  body('disponible').isBoolean(),
  body('latitud').isFloat(),
  body('longitud').isFloat(),
], actualizarDisponibilidad);

router.get ('/mis-entregas',        misEntregas);
router.get ('/pedidos-disponibles', pedidosDisponibles);
router.get ('/mi-ruta',             miRuta);
router.post('/aceptar-pedido', [
  body('pedido_id').isUUID(),
], aceptarPedido);

// ─── Endpoint legacy (crear perfil completo en una sola llamada) ───
router.post('/perfil', [
  body('tipo_vehiculo').isIn(['motocicleta', 'bicicleta']),
  body('placa_vehiculo').notEmpty().withMessage('La placa es obligatoria'),
  body('clabe_bancaria').isLength({ min: 18, max: 18 }).withMessage('CLABE debe tener 18 dígitos'),
  body('banco').notEmpty().withMessage('El banco es obligatorio'),
], crearPerfil);

module.exports = router;
