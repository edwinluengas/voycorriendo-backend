const express = require('express');
const { body } = require('express-validator');
const {
  crearPedido, misPedidos, obtenerPedido, actualizarEstado, calificarPedido, pedidosDelNegocio, cotizarEnvio, disponibilidadEnvio, subirFotoINE,
  rutaDelPedido,
} = require('../controllers/pedidosController');
const { proteger, restringirA } = require('../middleware/auth');

const router = express.Router();

router.use(proteger);  // Todos los endpoints de pedidos requieren login

router.post('/', [
  body('negocio_id').isUUID().withMessage('negocio_id inválido'),
  body('items').isArray({ min: 1 }).withMessage('Debes incluir al menos un producto'),
  // En PICKUP el cliente pasa por su pedido al negocio: no hay dirección de
  // entrega que pedirle. El controlador la rellena con la del negocio para
  // que el ticket y el historial sigan siendo legibles.
  body('direccion_entrega')
    .if(body('tipo_envio').not().equals('pickup'))
    .notEmpty().withMessage('La dirección de entrega es obligatoria'),
  body('tipo_envio').optional({ values: 'falsy' })
    .isIn(['standard', 'express', 'pickup']).withMessage('Tipo de envío no válido'),
  body('metodo_pago')
    .isIn(['efectivo', 'tarjeta', 'transferencia', 'mercado_pago'])
    .withMessage('Método de pago no válido'),
], crearPedido);

router.get('/',       misPedidos);
// IMPORTANTE: las rutas estáticas van ANTES de /:id para que no las absorba
router.get('/cotizar',             cotizarEnvio);
// Qué tipos de envío ofrecer AHORA (si no hay repartidor en línea: solo pickup)
router.get('/disponibilidad',      disponibilidadEnvio);
router.get('/negocio/mis-pedidos', pedidosDelNegocio); // proteger ya aplicado, el controller valida propiedad
router.post('/ine-foto',           subirFotoINE);
// Ruta por calles para el mapa en vivo. Va ANTES de '/:id' no por orden
// (es más específica), sino para que se lea junto al detalle del pedido.
router.get('/:id/ruta', rutaDelPedido);
router.get('/:id',    obtenerPedido);
router.patch('/:id/estado', [
  body('estado').notEmpty().withMessage('El estado es obligatorio'),
], actualizarEstado);
router.post('/:id/calificar', [
  body('calificacion_repartidor').optional().isInt({ min: 1, max: 5 }).withMessage('Calificación entre 1 y 5'),
  body('calificacion_negocio').isInt({ min: 1, max: 5 }).withMessage('Calificación entre 1 y 5'),
], calificarPedido);

module.exports = router;
