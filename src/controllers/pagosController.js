/**
 * Controlador de Pagos
 *   POST   /api/pagos/preferencia         → crea link de Mercado Pago
 *   POST   /api/pagos/efectivo            → registra cobro en efectivo
 *   POST   /api/pagos/transferencia       → registra comprobante de transferencia
 *   POST   /api/pagos/webhook/mercado-pago (público) → recibe confirmación MP
 */

const { Op } = require('sequelize');
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
    res.status(500).json({
      ok: false,
      mensaje: mensajeAmigable,
      ...(process.env.NODE_ENV !== 'production' ? { _debug: mpError } : {}),
    });
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
// Mercado Pago. Dos formas de mandar la tarjeta:
//   a) `token` — tarjeta NUEVA, tokenizada en el cliente con la public key
//      (el número/CVV nunca tocan este backend en este camino).
//   b) `tarjeta_id` + `cvv` — tarjeta YA GUARDADA. El CVV viaja hasta aquí
//      SOLO para este caso puntual (nunca se guarda ni se loguea) porque
//      generar un token fresco desde un card_id guardado requiere el
//      access token (secreto) — probado en vivo que la public key del
//      lado del cliente responde "Customer not found" al intentarlo
//      (2026-07-22). Ver generarTokenDesdeTarjetaGuardada.
// NOTA: cualquier `token` es de UN SOLO USO (MP lo invalida tras usarlo).
const pagarConTarjeta = async (req, res) => {
  let pedidoClaimed = null;
  try {
    const { pedido_id, token: tokenNueva, tarjeta_id, cvv, installments, payment_method_id: pmIdNueva, issuer_id: issuerIdNueva, idempotency_key } = req.body;
    if (!tokenNueva && !(tarjeta_id && cvv)) {
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

    // Resuelve token + payment_method_id + issuer_id según el camino.
    let token = tokenNueva;
    let payment_method_id = pmIdNueva;
    let issuer_id = issuerIdNueva;
    let mpCustomerId = null; // solo se llena en el camino de tarjeta guardada
    if (!token) {
      const { TarjetaGuardada } = require('../models');
      const tarjeta = await TarjetaGuardada.findByPk(tarjeta_id);
      if (!tarjeta || tarjeta.usuario_id !== req.usuario.id) {
        return res.status(404).json({ ok: false, mensaje: 'Tarjeta no encontrada.' });
      }
      token = await pagosService.generarTokenDesdeTarjetaGuardada({ mp_card_id: tarjeta.mp_card_id, security_code: cvv });
      payment_method_id = tarjeta.payment_method_id;
      issuer_id = tarjeta.issuer_id;
      // El dueño de la tarjeta es req.usuario (ownership ya verificado
      // arriba) — su customer de MP es obligatorio como payer del cobro.
      mpCustomerId = req.usuario.mp_customer_id;
    }
    if (!payment_method_id) {
      return res.status(400).json({ ok: false, mensaje: 'Faltan datos de la tarjeta.' });
    }

    // Claim atómico: evita que un doble-tap o reintento de red dispare dos
    // cobros reales en MP para el mismo pedido mientras el primero sigue en
    // vuelo. Se libera SIEMPRE en el finally, gane o pierda el pago.
    const [claimed] = await Pedido.update(
      { pago_en_proceso: true },
      { where: { id: pedido.id, pago_en_proceso: false, pago_estado: { [Op.ne]: 'capturado' } } }
    );
    if (!claimed) {
      return res.status(409).json({ ok: false, mensaje: 'Ya hay un cobro en proceso para este pedido. Espera unos segundos antes de reintentar.' });
    }
    pedidoClaimed = pedido;

    const cliente = await Usuario.findByPk(pedido.cliente_id);
    const result = await pagosService.crearPagoConTarjeta({
      pedido, cliente, token, installments, payment_method_id, issuer_id, idempotencyKey: idempotency_key, mpCustomerId,
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
    res.status(400).json({
      ok: false,
      mensaje: mensajeAmigable,
      ...(process.env.NODE_ENV !== 'production' ? { _debug: mpError } : {}),
    });
  } finally {
    if (pedidoClaimed) {
      await Pedido.update({ pago_en_proceso: false }, { where: { id: pedidoClaimed.id } }).catch(() => {});
    }
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
