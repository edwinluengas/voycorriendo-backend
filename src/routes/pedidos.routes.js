const express = require('express');
const { body } = require('express-validator');
const {
  crearPedido, misPedidos, obtenerPedido, actualizarEstado, calificarPedido, pedidosDelNegocio, cotizarEnvio,
} = require('../controllers/pedidosController');
const { proteger, restringirA } = require('../middleware/auth');

const router = express.Router();

router.use(proteger);  // Todos los endpoints de pedidos requieren login

router.post('/', [
  body('negocio_id').isUUID().withMessage('negocio_id inválido'),
  body('items').isArray({ min: 1 }).withMessage('Debes incluir al menos un producto'),
  body('direccion_entrega').notEmpty().withMessage('La dirección de entrega es obligatoria'),
  body('metodo_pago')
    .isIn(['efectivo', 'tarjeta', 'transferencia', 'mercado_pago'])
    .withMessage('Método de pago no válido'),
], crearPedido);

router.get('/',       misPedidos);
// IMPORTANTE: las rutas estáticas van ANTES de /:id para que no las absorba
router.get('/cotizar',             cotizarEnvio);
router.get('/negocio/mis-pedidos', restringirA('negocio'), pedidosDelNegocio);
router.get('/:id',    obtenerPedido);
router.patch('/:id/estado', [
  body('estado').notEmpty().withMessage('El estado es obligatorio'),
], actualizarEstado);
router.post('/:id/calificar', [
  body('calificacion_repartidor').optional().isInt({ min: 1, max: 5 }).withMessage('Calificación entre 1 y 5'),
  body('calificacion_negocio').isInt({ min: 1, max: 5 }).withMessage('Calificación entre 1 y 5'),
], calificarPedido);

module.exports = router;
