const express = require('express');
const router = express.Router();
const { proteger, restringirA } = require('../middleware/auth');
const ctrl = require('../controllers/pagosController');

// Webhook público de Mercado Pago - NO requiere auth (lo llama MP)
router.post('/webhook/mercado-pago', ctrl.webhookMercadoPago);

// Todas las demás rutas requieren login
router.use(proteger);

// Cliente pide link de pago de MP para su pedido (legado, se mantiene por compatibilidad)
router.post('/preferencia', restringirA('cliente'), ctrl.crearPreferencia);

// Cliente paga con tarjeta nativo dentro de la app (Checkout API, sin salir a MP)
router.post('/tarjeta', restringirA('cliente'), ctrl.pagarConTarjeta);

// Repartidor registra pago en efectivo al entregar — el controller ya valida
// dueño real del pedido (Repartidor.usuario_id === req.usuario.id), así que no
// gateamos por rol/modo_activo aquí (evita bloquear cuentas multi-rol cuyo
// modo_activo no está en 'repartidor' aunque sí sean el repartidor asignado).
router.post('/efectivo', ctrl.registrarEfectivo);

// Cliente adjunta comprobante de transferencia
router.post('/transferencia', restringirA('cliente'), ctrl.registrarTransferencia);

module.exports = router;
