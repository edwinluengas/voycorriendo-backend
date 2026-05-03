/**
 * ──────────────────────────────────────────────────────────────
 *  Servicio de Pagos - VoyCorriendo
 *  Métodos soportados: efectivo, tarjeta, transferencia, mercado_pago
 *  Regla de negocio: pagos en efectivo ≤ $1,000 MXN.
 * ──────────────────────────────────────────────────────────────
 */

const axios = require('axios');

const MP_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const MP_BASE_URL     = 'https://api.mercadopago.com';
const LIMITE_EFECTIVO = parseFloat(process.env.LIMITE_EFECTIVO || 1000);

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

// ─── Webhook: confirmar pago Mercado Pago ─────────────────────
const procesarWebhookMercadoPago = async ({ query, body, Pedido }) => {
  try {
    const topic   = query.topic || body.type;
    const paymentId = query.id || body.data?.id;

    if (topic !== 'payment' || !paymentId) {
      return { ok: true, mensaje: 'Evento ignorado.' };
    }

    // Consultar el pago en la API de MP
    const { data: pago } = await axios.get(
      `${MP_BASE_URL}/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    const numero = pago.external_reference;
    const pedido = await Pedido.findOne({ where: { numero } });
    if (!pedido) return { ok: false, mensaje: 'Pedido no encontrado.' };

    // Mapear estado MP → estado interno
    const mapa = {
      approved:    'capturado',
      authorized:  'autorizado',
      in_process:  'pendiente',
      rejected:    'fallido',
      cancelled:   'fallido',
      refunded:    'reembolsado',
    };

    pedido.pago_estado     = mapa[pago.status] || 'pendiente';
    pedido.pago_referencia = String(paymentId);
    await pedido.save();

    return { ok: true, pedido };
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
  procesarWebhookMercadoPago,
  registrarPagoEfectivo,
  registrarTransferencia,
  LIMITE_EFECTIVO,
};
