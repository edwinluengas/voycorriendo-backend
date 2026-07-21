/**
 * Controlador de Pagos
 *   POST   /api/pagos/preferencia         → crea link de Mercado Pago
 *   POST   /api/pagos/efectivo            → registra cobro en efectivo
 *   POST   /api/pagos/transferencia       → registra comprobante de transferencia
 *   POST   /api/pagos/webhook/mercado-pago (público) → recibe confirmación MP
 */

const { Pedido, Usuario, Negocio, Repartidor } = require('../models');
const pagosService = require('../services/pagos.service');
const push = require('../services/notificaciones.service');
const tg   = require('../services/telegram.service');

// ─── Notifica al cliente y al negocio cuando un pago digital se captura ──
// Compartido entre el webhook de MP y el pago directo con tarjeta, para que
// ambos caminos disparen exactamente el mismo aviso.
const notificarPagoCapturado = async (app, pedido) => {
  const io = app.get('io');
  io.to(`pedido:${pedido.id}`).emit('pago_actualizado', {
    pedido_id: pedido.id,
    estado:    pedido.pago_estado,
  });

  try {
    const cliente = await Usuario.findByPk(pedido.cliente_id, { attributes: ['token_push'] });
    if (cliente?.token_push) push.notificarPagoConfirmado(cliente.token_push, pedido).catch(() => {});
  } catch (_) {}

  try {
    const negocio = await Negocio.findByPk(pedido.negocio_id);
    if (negocio) {
      io.to(`negocio:${negocio.id}`).emit('nuevo_pedido', {
        pedido_id:    pedido.id,
        numero:       pedido.numero,
        total:        pedido.total,
        items:        pedido.items,
        pago_estado:  'capturado',
      });
      const dueno = await Usuario.findByPk(negocio.usuario_id, { attributes: ['telegram_chat_id', 'token_push'] });
      if (dueno?.telegram_chat_id) tg.alertaNuevoPedido(dueno.telegram_chat_id, pedido).catch(() => {});
      if (dueno?.token_push) push.notificarNuevoPedido(dueno.token_push, pedido).catch(() => {});
    }
  } catch (e) {
    console.warn('[pago] Error notificando negocio tras pago capturado:', e.message);
  }
};

const mensajePorEstadoPago = (status) => {
  if (status === 'approved') return '¡Pago aprobado! Tu pedido está confirmado.';
  if (status === 'in_process' || status === 'pending') return 'Tu pago está siendo procesado. Te avisaremos cuando se confirme.';
  return 'El pago fue rechazado. Intenta con otra tarjeta.';
};

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
    const mpError = error.response?.data;
    console.error('[MP] Error crearPreferencia:', JSON.stringify(mpError || error.message));
    const mensajeAmigable = mpError?.message || mpError?.error || 'No se pudo crear la preferencia de pago.';
    res.status(500).json({ ok: false, mensaje: mensajeAmigable, _debug: mpError });
  }
};

// ─── POST /api/pagos/webhook/mercado-pago (público) ──────
const webhookMercadoPago = async (req, res) => {
  res.sendStatus(200); // MP necesita 200 inmediato o reintenta

  const result = await pagosService.procesarWebhookMercadoPago({
    query:         req.query,
    body:          req.body,
    headers:       req.headers,
    Pedido,
  });

  if (!result.ok) return;

  if (result.tipo === 'pedido' && result.pedido) {
    if (result.pedido.pago_estado === 'capturado') {
      await notificarPagoCapturado(req.app, result.pedido);
    } else {
      req.app.get('io').to(`pedido:${result.pedido.id}`).emit('pago_actualizado', {
        pedido_id: result.pedido.id,
        estado:    result.pedido.pago_estado,
      });
    }
  }
};

// ─── POST /api/pagos/tarjeta ──────────────────────────────
// Pago nativo con tarjeta dentro de la app (Checkout API), sin salir a
// Mercado Pago. `token` viene de POST /v1/card_tokens tokenizado en el
// cliente con la public key — el número/CVV nunca tocan este backend.
// NOTA: `token` debe ser de UN SOLO USO válido para pago (MP invalida el
// token tras usarlo). Si el cliente quiere guardar una tarjeta NUEVA, la app
// debe guardarla primero (POST /api/tarjetas, que consume ese token) y luego
// generar un token fresco desde la tarjeta ya guardada (card_id + cvv) para
// pagar con ESTE endpoint — ver tokenizarTarjetaGuardada en la app. Por eso
// aquí ya no existe un flag "guardar": guardar y pagar son dos pasos
// separados en el cliente, nunca el mismo token para ambos.
const pagarConTarjeta = async (req, res) => {
  try {
    const { pedido_id, token, installments, payment_method_id, issuer_id, idempotency_key } = req.body;
    if (!token || !payment_method_id) {
      return res.status(400).json({ ok: false, mensaje: 'Faltan datos de la tarjeta.' });
    }
    const pedido = await Pedido.findByPk(pedido_id);
    if (!pedido) return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado.' });
    if (pedido.cliente_id !== req.usuario.id) {
      return res.status(403).json({ ok: false, mensaje: 'No autorizado.' });
    }
    if (pedido.pago_estado === 'capturado') {
      return res.status(400).json({ ok: false, mensaje: 'Este pedido ya fue pagado.' });
    }

    const cliente = await Usuario.findByPk(pedido.cliente_id);
    const result = await pagosService.crearPagoConTarjeta({
      pedido, cliente, token, installments, payment_method_id, issuer_id, idempotencyKey: idempotency_key,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, mensaje: result.mensaje, data: { pedido: result.pedido } });
    }

    if (result.pedido.pago_estado === 'capturado') {
      await notificarPagoCapturado(req.app, result.pedido);
    }

    res.json({
      ok: true,
      mensaje: mensajePorEstadoPago(result.statusMP),
      data: { pedido: result.pedido, status: result.statusMP, status_detail: result.statusDetail },
    });
  } catch (error) {
    const mpError = error.response?.data;
    console.error('[MP] Error pagarConTarjeta:', JSON.stringify(mpError || error.message));
    const mensajeAmigable = mpError?.cause?.[0]?.description || mpError?.message || 'No se pudo procesar el pago. Verifica los datos de tu tarjeta.';
    res.status(400).json({ ok: false, mensaje: mensajeAmigable, _debug: mpError });
  }
};

// ─── POST /api/pagos/efectivo ────────────────────────────
const registrarEfectivo = async (req, res) => {
  try {
    const { pedido_id, monto_recibido } = req.body;
    const pedido = await Pedido.findByPk(pedido_id);
    if (!pedido) return res.status(404).json({ ok: false, mensaje: 'Pedido no encontrado.' });

    // Solo el repartidor asignado puede registrar el cobro en efectivo
    const rep = await Repartidor.findOne({ where: { usuario_id: req.usuario.id }, attributes: ['id'] });
    if (!rep || String(pedido.repartidor_id) !== String(rep.id)) {
      return res.status(403).json({ ok: false, mensaje: 'No autorizado para este pedido.' });
    }

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
    if (pedido.cliente_id !== req.usuario.id) {
      return res.status(403).json({ ok: false, mensaje: 'No autorizado.' });
    }

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
  pagarConTarjeta,
  registrarEfectivo,
  registrarTransferencia,
};
