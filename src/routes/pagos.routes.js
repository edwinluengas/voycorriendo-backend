const express = require('express');
const router = express.Router();
const { proteger, restringirA } = require('../middleware/auth');
const ctrl = require('../controllers/pagosController');
const { metodoPagoActivo } = require('../config/precios');

// Candado temporal de método de pago. NO borra nada: si el método está
// apagado (fase de prueba real: solo efectivo), la ruta responde 503 y ya.
// Al reactivar METODOS_PAGO_ACTIVOS vuelve a funcionar tal cual estaba.
const soloSiMetodoActivo = (metodo) => (req, res, next) => {
  if (metodoPagoActivo(metodo)) return next();
  return res.status(503).json({
    ok: false,
    mensaje: 'El pago con tarjeta está desactivado por el momento. Solo aceptamos efectivo al recibir tu pedido.',
    codigo: 'METODO_PAGO_DESACTIVADO',
  });
};

// Webhook público de Mercado Pago - NO requiere auth (lo llama MP)
router.post('/webhook/mercado-pago', ctrl.webhookMercadoPago);

// Todas las demás rutas requieren login
router.use(proteger);

// Cliente pide link de pago de MP para su pedido (legado, se mantiene por compatibilidad)
router.post('/preferencia', restringirA('cliente'), soloSiMetodoActivo('mercado_pago'), ctrl.crearPreferencia);

// Cliente paga con tarjeta nativo dentro de la app (Checkout API, sin salir a MP)
router.post('/tarjeta', restringirA('cliente'), soloSiMetodoActivo('tarjeta'), ctrl.pagarConTarjeta);

// Repartidor registra pago en efectivo al entregar — el controller ya valida
// dueño real del pedido (Repartidor.usuario_id === req.usuario.id), así que no
// gateamos por rol/modo_activo aquí (evita bloquear cuentas multi-rol cuyo
// modo_activo no está en 'repartidor' aunque sí sean el repartidor asignado).
router.post('/efectivo', ctrl.registrarEfectivo);

// Cliente adjunta comprobante de transferencia
router.post('/transferencia', restringirA('cliente'), ctrl.registrarTransferencia);

module.exports = router;
