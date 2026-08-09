const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { proteger, restringirA } = require('../middleware/auth');
const ctrl = require('../controllers/pagosController');
const { metodoPagoActivo } = require('../config/precios');

// Techo de intentos de cobro por usuario. Un cobro con tarjeta llama a
// Mercado Pago y toca dinero real: sin límite, un bug del cliente en bucle,
// o alguien tanteando tarjetas robadas, podría lanzar cientos de cargos por
// minuto. 20 en 15 min es holgado para un humano que reintenta un pago
// rechazado, y corta cualquier automatización. El candado atómico
// `pago_en_proceso` ya evita el doble-cobro del MISMO pedido; esto acota el
// volumen a través de pedidos distintos. La clave es el id de usuario, no la
// IP: detrás de la misma red móvil hay muchos clientes.
const limiteCobros = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.usuario?.id || req.ip,
  message: { ok: false, mensaje: 'Demasiados intentos de pago. Espera unos minutos e intenta de nuevo.' },
  standardHeaders: true,
  legacyHeaders: false,
});

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
router.post('/preferencia', limiteCobros, restringirA('cliente'), soloSiMetodoActivo('mercado_pago'), ctrl.crearPreferencia);

// Cliente paga con tarjeta nativo dentro de la app (Checkout API, sin salir a MP)
router.post('/tarjeta', limiteCobros, restringirA('cliente'), soloSiMetodoActivo('tarjeta'), ctrl.pagarConTarjeta);

// Repartidor registra pago en efectivo al entregar — el controller ya valida
// dueño real del pedido (Repartidor.usuario_id === req.usuario.id), así que no
// gateamos por rol/modo_activo aquí (evita bloquear cuentas multi-rol cuyo
// modo_activo no está en 'repartidor' aunque sí sean el repartidor asignado).
router.post('/efectivo', ctrl.registrarEfectivo);

// Cliente adjunta comprobante de transferencia
router.post('/transferencia', restringirA('cliente'), ctrl.registrarTransferencia);

module.exports = router;
