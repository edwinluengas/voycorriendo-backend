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
  marcarRecogido,
  miRuta,
  miPerfil,
  ganancias,
  solicitarDeposito,
  retiroDiario,
} = require('../controllers/repartidoresController');
const { proteger } = require('../middleware/auth');

const router = express.Router();

// Todas las rutas requieren login. NO restringimos por rol aqui:
// cualquier usuario puede ACTIVAR modo repartidor desde su perfil.
// La validacion fina (verificacion_estado, estado_cuenta) la hace
// cada controlador.
router.use(proteger);

// ─── Latido de actividad ─────────────────────────────────
// Cualquier request de un repartidor cuenta como señal de vida: su app
// consulta pedidos disponibles cada 10 s mientras trabaja. Esto es lo que
// distingue "está trabajando" de "prendió el switch y cerró la app" — sin
// ello, un switch olvidado hacía creer que había servicio a domicilio y se
// aceptaban pedidos que nadie recogía (pedido real MND-151740, 2026-07-30).
// No bloquea la respuesta: se dispara y sigue.
router.use(async (req, res, next) => {
  next();
  try {
    const { Repartidor } = require('../models');
    const rep = await Repartidor.findOne({
      where: { usuario_id: req.usuario.id },
      attributes: ['id', 'conectado'],
    });
    if (rep?.conectado) require('../services/disponibilidad.service').registrarLatido(rep.id);
  } catch (_) { /* el latido nunca debe afectar la petición del usuario */ }
});

// ─── Onboarding (wizard multi-paso) ──────────────────────
router.post ('/activar',           activarModo);
router.patch('/perfil', [
  body('tier').optional().isIn(['daily', 'weekly']).withMessage('tier debe ser daily o weekly'),
], actualizarPerfil);
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

router.get ('/mi-perfil',           miPerfil);
router.get ('/mis-entregas',        misEntregas);
router.get ('/pedidos-disponibles', pedidosDisponibles);
router.get ('/mi-ruta',             miRuta);
router.get ('/ganancias',           ganancias);
router.post('/solicitar-deposito',  solicitarDeposito);
router.post('/retiro-diario',       retiroDiario);
router.post('/aceptar-pedido', [
  body('pedido_id').isUUID(),
], aceptarPedido);
router.patch('/pedidos/:id/recogido', marcarRecogido);

// ─── Endpoint legacy (crear perfil completo en una sola llamada) ───
router.post('/perfil', [
  // Bicicleta eliminada del servicio (2026-07-26)
  body('tipo_vehiculo').isIn(['motocicleta']).withMessage('Solo se permiten entregas en motocicleta.'),
  body('placa_vehiculo').notEmpty().withMessage('La placa es obligatoria'),
  body('clabe_bancaria').isLength({ min: 18, max: 18 }).withMessage('CLABE debe tener 18 dígitos'),
  body('banco').notEmpty().withMessage('El banco es obligatorio'),
], crearPerfil);

module.exports = router;
