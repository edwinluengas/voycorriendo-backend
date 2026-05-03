const express = require('express');
const router = express.Router();
const { proteger, restringirA } = require('../middleware/auth');
const ctrl = require('../controllers/pagosController');

// Webhook público de Mercado Pago - NO requiere auth (lo llama MP)
router.post('/webhook/mercado-pago', ctrl.webhookMercadoPago);

// Todas las demás rutas requieren login
router.use(proteger);

// Cliente pide link de pago de MP para su pedido
router.post('/preferencia', restringirA('cliente'), ctrl.crearPreferencia);

// Repartidor registra pago en efectivo al entregar
router.post('/efectivo', restringirA('repartidor', 'admin'), ctrl.registrarEfectivo);

// Cliente adjunta comprobante de transferencia
router.post('/transferencia', restringirA('cliente'), ctrl.registrarTransferencia);

module.exports = router;
