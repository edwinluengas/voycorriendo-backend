/**
 * Controlador de Pagos
 *   POST   /api/pagos/preferencia         → crea link de Mercado Pago
 *   POST   /api/pagos/efectivo            → registra cobro en efectivo
 *   POST   /api/pagos/transferencia       → registra comprobante de transferencia
 *   POST   /api/pagos/webhook/mercado-pago (público) → recibe confirmación MP
 */

const { Pedido, Usuario } = require('../models');
const pagosService = require('../services/pagos.service');

// ─── POST /api/pagos/preferencia ─────────────────────────
const crearPreferencia = async (req, res) => {
  try {
    const { pedido_id } = req.body;
    const pedido = await Pedido.findByPk(pedido_id);
    if (!pedido) {
      return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado.' });
    }
    if (pedido.cliente_id !== req.usuario.id) {
      return res.status(403).json({ ok: false, mensaje: 'No autorizado.' });
    }

    const cliente = await Usuario.findByPk(pedido.cliente_id);
    const pref = await pagosService.crearPreferenciaMercadoPago({ pedido, cliente });

    return res.json({
      ok: true,
      mensaje: 'Preferencia creada. Redirige al cliente al link de pago.',
      data: pref,
    });
  } catch (error) {
    console.error('Error crearPreferencia:', error.response?.data || error.message);
    res.status(500).json({ ok: false, mensaje: 'No se pudo crear la preferencia de pago.' });
  }
};

// ─── POST /api/pagos/webhook/mercado-pago (público) ──────
const webhookMercadoPago = async (req, res) => {
  // MP envía 200 rápido o reintenta
  const result = await pagosService.procesarWebhookMercadoPago({
    query: req.query,
    body: req.body,
    Pedido,
  });

  if (result.ok && result.pedido) {
    // Notificar a cliente y repartidor vía socket.io
    const io = req.app.get('io');
    io.to(`pedido:${result.pedido.id}`).emit('pago_actualizado', {
      pedido_id: result.pedido.id,
      estado: result.pedido.pago_estado,
    });
  }
  res.sendStatus(200);
};

// ─── POST /api/pagos/efectivo ────────────────────────────
const registrarEfectivo = async (req, res) => {
  try {
    const { pedido_id, monto_recibido } = req.body;
    const pedido = await Pedido.findByPk(pedido_id);
    if (!pedido) return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado.' });

    const result = await pagosService.registrarPagoEfectivo({ pedido, monto_recibido });
    if (!result.ok) return res.status(400).json(result);

    return res.json({
      ok: true,
      mensaje: `Pago en efectivo registrado. Cambio: $${result.cambio.toFixed(2)} MXN.`,
      data: { pedido: result.pedido, cambio: result.cambio },
    });
  } catch (error) {
    console.error('Error efectivo:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al registrar pago en efectivo.' });
  }
};

// ─── POST /api/pagos/transferencia ───────────────────────
const registrarTransferencia = async (req, res) => {
  try {
    const { pedido_id, referencia, comprobante_url } = req.body;
    const pedido = await Pedido.findByPk(pedido_id);
    if (!pedido) return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado.' });

    const result = await pagosService.registrarTransferencia({
      pedido,
      referencia,
      comprobante_url,
    });
    if (!result.ok) return res.status(400).json(result);

    return res.json({
      ok: true,
      mensaje: 'Comprobante de transferencia recibido. Un operador validará el pago.',
      data: { pedido: result.pedido },
    });
  } catch (error) {
    console.error('Error transferencia:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al registrar transferencia.' });
  }
};

module.exports = {
  crearPreferencia,
  webhookMercadoPago,
  registrarEfectivo,
  registrarTransferencia,
};
