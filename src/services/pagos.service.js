/**
 * ──────────────────────────────────────────────────────────────
 *  Servicio de Pagos - VoyCorriendo
 *  Métodos soportados: efectivo, tarjeta, transferencia, mercado_pago
 *  Regla de negocio: pagos en efectivo ≤ $500 MXN.
 * ──────────────────────────────────────────────────────────────
 */

const axios  = require('axios');
const crypto = require('crypto');

const MP_ACCESS_TOKEN   = process.env.MERCADOPAGO_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MERCADOPAGO_WEBHOOK_SECRET;
const MP_BASE_URL       = 'https://api.mercadopago.com';
const LIMITE_EFECTIVO   = parseFloat(process.env.LIMITE_EFECTIVO || 500);

// ─── Validación de límite de efectivo ─────────────────────────
const validarMetodoPago = ({ metodo_pago, total }) => {
  const metodosValidos = ['efectivo', 'tarjeta', 'transferencia', 'mercado_pago'];
  if (!metodosValidos.includes(metodo_pago)) {
    return { ok: false, mensaje: 'Método de pago no válido.' };
  }
  if (metodo_pago === 'efectivo' && total > LIMITE_EFECTIVO) {
    return {
      ok: false,
      mensaje: `Los pagos en efectivo tienen un límite de $${LIMITE_EFECTIVO.toLocaleString('es-MX')} MXN. Tu pedido es de $${total.toFixed(2)} MXN. Elige tarjeta, transferencia o Mercado Pago.`,
    };
  }
  return { ok: true };
};

// ─── Verificar firma HMAC del webhook de Mercado Pago ─────────
const verificarFirmaMP = (headers, dataId) => {
  if (!MP_WEBHOOK_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[webhook] MERCADOPAGO_WEBHOOK_SECRET no configurado — rechazando webhook en producción');
      return false;
    }
    return true; // dev: aceptar sin verificar firma
  }
  const xSignature = headers['x-signature'];
  const xRequestId = headers['x-request-id'];
  if (!xSignature || !xRequestId) return false;

  const parts = {};
  xSignature.split(',').forEach(part => {
    const [k, v] = part.trim().split('=');
    if (k && v) parts[k.trim()] = v.trim();
  });

  const { ts, v1 } = parts;
  if (!ts || !v1) return false;

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const computed  = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(v1));
  } catch {
    return false;
  }
};

// ─── Crear preferencia de pago en Mercado Pago ────────────────
const crearPreferenciaMercadoPago = async ({ pedido, cliente }) => {
  if (!MP_ACCESS_TOKEN) {
    throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado en .env');
  }

  const items = pedido.items.map((it) => ({
    title: it.nombre,
    quantity: it.cantidad,
    unit_price: parseFloat(it.precio_unitario),
    currency_id: 'MXN',
  }));

  // costo de envío como un item extra
  items.push({
    title: 'Costo de envío',
    quantity: 1,
    unit_price: parseFloat(pedido.costo_envio),
    currency_id: 'MXN',
  });

  const payload = {
    items,
    payer: {
      name: cliente?.nombre || 'Cliente',
      email: cliente?.email || undefined,
      phone: cliente?.telefono ? { number: cliente.telefono } : undefined,
    },
    external_reference: pedido.numero,
    notification_url: `${process.env.API_PUBLIC_URL}/api/pagos/webhook/mercado-pago`,
    back_urls: {
      success: `${process.env.APP_DEEP_LINK}/pago-exitoso?pedido=${pedido.numero}`,
      failure: `${process.env.APP_DEEP_LINK}/pago-fallido?pedido=${pedido.numero}`,
      pending: `${process.env.APP_DEEP_LINK}/pago-pendiente?pedido=${pedido.numero}`,
    },
    auto_return: 'approved',
    statement_descriptor: 'VOYCORRIENDO',
    metadata: { pedido_id: pedido.id, cliente_id: pedido.cliente_id },
  };

  const { data } = await axios.post(
    `${MP_BASE_URL}/checkout/preferences`,
    payload,
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );

  return {
    preference_id: data.id,
    init_point: data.init_point,           // URL para web
    sandbox_init_point: data.sandbox_init_point, // URL para pruebas
  };
};

// ─── Crear preferencia MP para compra de token pack ───────────
const crearPreferenciaTokens = async ({ pack_type, negocio, tokens, precio }) => {
  if (!MP_ACCESS_TOKEN) throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado.');

  const payload = {
    items: [{
      title: `VoyCorriendo – Pack ${pack_type} (${tokens} tokens)`,
      quantity: 1,
      unit_price: precio,
      currency_id: 'MXN',
    }],
    external_reference: `token:${pack_type}:${negocio.id}`,
    notification_url: `${process.env.API_PUBLIC_URL}/api/pagos/webhook/mercado-pago`,
    statement_descriptor: 'VOYCORRIENDO',
    metadata: { pack_type, negocio_id: negocio.id },
  };

  const { data } = await axios.post(
    `${MP_BASE_URL}/checkout/preferences`,
    payload,
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );

  return {
    preference_id:       data.id,
    init_point:          data.init_point,
    sandbox_init_point:  data.sandbox_init_point,
  };
};

// ─── Webhook: confirmar pago Mercado Pago ─────────────────────
// Maneja dos tipos vía external_reference:
//   "token:{pack}:{negocio_id}" → compra de tokens
//   cualquier otro valor         → pago de pedido (external_reference = pedido.numero)
const procesarWebhookMercadoPago = async ({ query, body, headers, Pedido, RestaurantToken, Negocio }) => {
  try {
    const topic     = query.topic || body.type;
    const paymentId = query.id || body.data?.id;

    if (topic !== 'payment' || !paymentId) return { ok: true, mensaje: 'Evento ignorado.' };

    if (!verificarFirmaMP(headers || {}, paymentId)) {
      console.warn('Webhook MP: firma inválida, rechazado.');
      return { ok: false, mensaje: 'Firma inválida.' };
    }

    const { data: pago } = await axios.get(
      `${MP_BASE_URL}/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    const ref = pago.external_reference || '';

    // ── Compra de token pack ──────────────────────────────────
    if (ref.startsWith('token:')) {
      const [, pack_type, negocio_id] = ref.split(':');
      if (pago.status !== 'approved') return { ok: true, tipo: 'token', mensaje: 'Pago no aprobado aún.' };

      const { RestaurantToken: TokenModel } = RestaurantToken ? { RestaurantToken } : {};
      const PACKS  = TokenModel?.PACK_TOKENS || { starter: 50, pro: 200, elite: 500 };
      const EXPIRY = TokenModel?.PACK_EXPIRY || { starter: 60, pro: 90, elite: 120 };

      const expires_at = new Date();
      expires_at.setDate(expires_at.getDate() + (EXPIRY[pack_type] || 60));

      const token = await RestaurantToken.create({
        restaurant_id:    negocio_id,
        tokens_remaining: PACKS[pack_type] || 50,
        pack_type,
        expires_at,
      });

      return { ok: true, tipo: 'token', token, negocio_id };
    }

    // ── Pago de pedido ────────────────────────────────────────
    const pedido = await Pedido.findOne({ where: { numero: ref } });
    if (!pedido) return { ok: false, mensaje: 'Pedido no encontrado.' };

    const mapa = {
      approved:   'capturado',
      authorized: 'autorizado',
      in_process: 'pendiente',
      rejected:   'fallido',
      cancelled:  'fallido',
      refunded:   'reembolsado',
    };

    pedido.pago_estado     = mapa[pago.status] || 'pendiente';
    pedido.pago_referencia = String(paymentId);
    await pedido.save();

    return { ok: true, tipo: 'pedido', pedido };
  } catch (error) {
    console.error('Error webhook MP:', error.response?.data || error.message);
    return { ok: false, mensaje: 'Error procesando webhook.' };
  }
};

// ─── Registrar pago en efectivo (al entregar) ─────────────────
const registrarPagoEfectivo = async ({ pedido, monto_recibido }) => {
  if (pedido.metodo_pago !== 'efectivo') {
    return { ok: false, mensaje: 'Este pedido no es pago en efectivo.' };
  }
  if (parseFloat(monto_recibido) < parseFloat(pedido.total)) {
    return { ok: false, mensaje: 'El monto recibido es menor al total.' };
  }
  pedido.pago_estado = 'capturado';
  pedido.pago_referencia = `EFVO-${Date.now()}`;
  await pedido.save();
  const cambio = parseFloat(monto_recibido) - parseFloat(pedido.total);
  return { ok: true, pedido, cambio };
};

// ─── Registrar comprobante de transferencia ───────────────────
const registrarTransferencia = async ({ pedido, referencia, comprobante_url }) => {
  if (pedido.metodo_pago !== 'transferencia') {
    return { ok: false, mensaje: 'Este pedido no es por transferencia.' };
  }
  pedido.pago_estado     = 'autorizado'; // admin debe confirmar manual
  pedido.pago_referencia = referencia;
  // comprobante_url se guardaría en un modelo aparte "ComprobantesPago"
  await pedido.save();
  return { ok: true, pedido };
};

module.exports = {
  validarMetodoPago,
  crearPreferenciaMercadoPago,
  crearPreferenciaTokens,
  procesarWebhookMercadoPago,
  registrarPagoEfectivo,
  registrarTransferencia,
  LIMITE_EFECTIVO,
};
