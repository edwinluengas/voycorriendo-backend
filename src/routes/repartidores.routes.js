const express = require('express');
const { body } = require('express-validator');
const {
  crearPerfil, actualizarDisponibilidad,
  misEntregas, pedidosDisponibles, aceptarPedido,
} = require('../controllers/repartidoresController');
const { proteger, restringirA } = require('../middleware/auth');

const router = express.Router();

router.use(proteger);
router.use(restringirA('repartidor', 'admin'));

router.post('/perfil', [
  body('tipo_vehiculo').isIn(['motocicleta', 'bicicleta']),
  body('placa_vehiculo').notEmpty().withMessage('La placa es obligatoria'),
  body('clabe_bancaria').isLength({ min: 18, max: 18 }).withMessage('CLABE debe tener 18 dígitos'),
  body('banco').notEmpty().withMessage('El banco es obligatorio'),
], crearPerfil);

router.patch('/disponibilidad', [
  body('disponible').isBoolean(),
  body('latitud').isFloat(),
  body('longitud').isFloat(),
], actualizarDisponibilidad);

router.get('/mis-entregas',        misEntregas);
router.get('/pedidos-disponibles', pedidosDisponibles);
router.post('/aceptar-pedido', [
  body('pedido_id').isUUID(),
], aceptarPedido);

module.exports = router;
