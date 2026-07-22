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
const API_PUBLIC_URL    = process.env.API_PUBLIC_URL || 'https://voycorriendo-backend-production.up.railway.app';
const APP_DEEP_LINK     = process.env.APP_DEEP_LINK  || null;

// ─── Validación de límite de efectivo ─────────────────────────
// El límite aplica al SUBTOTAL de productos. El fee de envío se cobra encima.
// Total pagado en efectivo = subtotal (≤$500) + costo_envio
const validarMetodoPago = ({ metodo_pago, subtotal, costo_envio = 0 }) => {
  const metodosValidos = ['efectivo', 'tarjeta', 'transferencia', 'mercado_pago'];
  if (!metodosValidos.includes(metodo_pago)) {
    return { ok: false, mensaje: 'Método de pago no válido.' };
  }
  if (metodo_pago === 'efectivo' && subtotal > LIMITE_EFECTIVO) {
    const totalConEnvio = (subtotal + parseFloat(costo_envio || 0)).toFixed(2);
    return {
      ok: false,
      mensaje: `Efectivo solo disponible cuando los productos no superen $${LIMITE_EFECTIVO.toLocaleString('es-MX')} MXN. Tu subtotal es $${subtotal.toFixed(2)} (total con envío: $${totalConEnvio}). Elige tarjeta o Mercado Pago.`,
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
    title: String(it.nombre).substring(0, 256),
    quantity: Number(it.cantidad) || 1,
    unit_price: Math.max(0.01, parseFloat(it.precio_unitario) || 0),
    currency_id: 'MXN',
  }));

  // Costo de envío como ítem extra — MP rechaza unit_price = 0
  const costoEnvio = parseFloat(pedido.costo_envio) || 0;
  if (costoEnvio > 0) {
    items.push({
      title: 'Costo de envío',
      quantity: 1,
      unit_price: costoEnvio,
      currency_id: 'MXN',
    });
  }

  // Mercado Pago exige que back_urls sean URLs http(s) válidas — un deep
  // link de app (ej. "voycorriendo://") lo rechaza con "back_urls invalid.
  // Wrong format" y tumba la creación de TODA la preferencia. Sin back_urls
  // válidas simplemente no se ofrece el botón de "volver a la app": el pago
  // se sigue confirmando por webhook y el cliente ve el estado actualizado
  // en Seguimiento al reintentar o por socket.
  const deepLinkValido = APP_DEEP_LINK && /^https?:\/\//i.test(APP_DEEP_LINK);

  const payload = {
    items,
    payer: {
      name: cliente?.nombre || 'Cliente',
      email: cliente?.email || undefined,
      phone: cliente?.telefono ? { number: cliente.telefono } : undefined,
    },
    external_reference: pedido.numero,
    notification_url: `${API_PUBLIC_URL}/api/pagos/webhook/mercado-pago`,
    ...(deepLinkValido ? {
      back_urls: {
        success: `${APP_DEEP_LINK}/pago-exitoso?pedido=${pedido.numero}`,
        failure: `${APP_DEEP_LINK}/pago-fallido?pedido=${pedido.numero}`,
        pending: `${APP_DEEP_LINK}/pago-pendiente?pedido=${pedido.numero}`,
      },
      auto_return: 'approved',
    } : {}),
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

// ─── Mapa de estados de pago de MP → estados internos ─────────
const MAPA_ESTADO_MP = {
  approved:   'capturado',
  authorized: 'autorizado',
  in_process: 'pendiente',
  pending:    'pendiente',
  rejected:   'fallido',
  cancelled:  'fallido',
  refunded:   'reembolsado',
};

// ─── Aplica el resultado de un pago de MP al pedido ────────────
// Compartido entre el webhook y el pago directo con tarjeta (Checkout API),
// para que ambos caminos verifiquen el monto y mapeen el estado igual.
const aplicarResultadoPago = async (pedido, pago) => {
  if (pago.status === 'approved') {
    const montoPagado   = parseFloat(pago.transaction_amount || 0);
    const montoEsperado = parseFloat(pedido.total || 0);
    if (Math.abs(montoPagado - montoEsperado) > 0.5) {
      console.error(
        `[pago] MONTO NO COINCIDE pedido ${pedido.numero}: pagado=$${montoPagado} esperado=$${montoEsperado}`
      );
      pedido.pago_estado     = 'pendiente';
      pedido.pago_referencia = String(pago.id);
      await pedido.save();
      return { ok: false, mensaje: 'El monto del pago no coincide con el pedido.', tipo: 'monto_invalido', pedido, statusMP: pago.status };
    }
  }

  pedido.pago_estado     = MAPA_ESTADO_MP[pago.status] || 'pendiente';
  pedido.pago_referencia = String(pago.id);
  await pedido.save();

  return { ok: true, tipo: 'pedido', pedido, statusMP: pago.status, statusDetail: pago.status_detail };
};

// ─── Webhook: confirmar pago Mercado Pago ─────────────────────
// external_reference = pedido.numero
const procesarWebhookMercadoPago = async ({ query, body, headers, Pedido }) => {
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

    // ── Pago de pedido ────────────────────────────────────────
    const pedido = await Pedido.findOne({ where: { numero: ref } });
    if (!pedido) return { ok: false, mensaje: 'Pedido no encontrado.' };

    return await aplicarResultadoPago(pedido, pago);
  } catch (error) {
    console.error('Error webhook MP:', error.response?.data || error.message);
    return { ok: false, mensaje: 'Error procesando webhook.' };
  }
};

// ─── Customers & Cards API: obtiene o crea el customer de MP ──
const obtenerOCrearCustomerMP = async (usuario) => {
  if (usuario.mp_customer_id) return usuario.mp_customer_id;
  const { data } = await axios.post(
    `${MP_BASE_URL}/v1/customers`,
    {
      email: usuario.email || `usuario-${usuario.id}@voycorriendo.mx`,
      first_name: usuario.nombre,
      last_name: usuario.apellido,
    },
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );
  usuario.mp_customer_id = data.id;
  await usuario.save();
  return data.id;
};

// ─── Guarda una tarjeta ya tokenizada del lado del cliente ─────
// El "token" viene de POST /v1/card_tokens hecho en la app con la public
// key — el número de tarjeta y el CVV nunca tocan este backend.
const guardarTarjetaMP = async ({ usuario, token }) => {
  if (!MP_ACCESS_TOKEN) throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado en .env');
  const customerId = await obtenerOCrearCustomerMP(usuario);
  const { data } = await axios.post(
    `${MP_BASE_URL}/v1/customers/${customerId}/cards`,
    { token },
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );
  return {
    mp_card_id:        data.id,
    ultimos_4:         data.last_four_digits,
    marca:             data.payment_method?.name || data.payment_method?.id || null,
    payment_method_id: data.payment_method?.id || null,
    issuer_id:         data.issuer?.id ? String(data.issuer.id) : null,
    exp_mes:           data.expiration_month || null,
    exp_anio:          data.expiration_year || null,
    titular:            data.cardholder?.name || null,
  };
};

// ─── Elimina una tarjeta guardada en MP ────────────────────────
const eliminarTarjetaMP = async ({ usuario, mp_card_id }) => {
  if (!usuario.mp_customer_id) return;
  await axios.delete(
    `${MP_BASE_URL}/v1/customers/${usuario.mp_customer_id}/cards/${mp_card_id}`,
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );
};

// ─── Genera un token de un solo uso desde una tarjeta YA GUARDADA ──
// IMPORTANTE: esto se hace del lado del BACKEND con el access token
// (secreto), NO del lado de la app con la public key. Se probó en vivo
// (2026-07-22) que MP responde "Customer not found" (código 2002) cuando
// se intenta resolver un card_id de un customer desde la public key — esa
// llamada necesita el contexto completo de la cuenta, que solo tiene el
// access token. El CVV viaja de la app a este backend SOLO para esta
// llamada puntual y nunca se guarda ni se loguea — se reenvía a MP y se
// descarta, mismo estándar que cualquier procesador que soporte "pagar con
// tarjeta guardada, solo pide el CVV".
const generarTokenDesdeTarjetaGuardada = async ({ mp_card_id, security_code }) => {
  if (!MP_ACCESS_TOKEN) throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado en .env');
  const { data } = await axios.post(
    `${MP_BASE_URL}/v1/card_tokens`,
    { card_id: mp_card_id, security_code },
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );
  return data.id;
};

// ─── Pago directo con tarjeta (Checkout API) ───────────────────
// token: generado en la app con la public key (tarjeta NUEVA, capturada en
// el formulario) o generado aquí mismo en el backend vía
// generarTokenDesdeTarjetaGuardada (tarjeta guardada — ver nota arriba).
const crearPagoConTarjeta = async ({ pedido, cliente, token, installments, payment_method_id, issuer_id, idempotencyKey }) => {
  if (!MP_ACCESS_TOKEN) throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado en .env');

  const cuotas = Number.isInteger(Number(installments)) && installments >= 1 && installments <= 24
    ? Number(installments) : 1;

  const payload = {
    transaction_amount: parseFloat(pedido.total),
    token,
    description: `Pedido VoyCorriendo #${pedido.numero}`,
    installments: cuotas,
    payment_method_id,
    ...(issuer_id ? { issuer_id } : {}),
    payer: {
      email: cliente?.email || `usuario-${cliente.id}@voycorriendo.mx`,
    },
    external_reference: pedido.numero,
    notification_url: `${API_PUBLIC_URL}/api/pagos/webhook/mercado-pago`,
    statement_descriptor: 'VOYCORRIENDO',
    metadata: { pedido_id: pedido.id, cliente_id: pedido.cliente_id },
  };

  // Clave estable por (pedido, token): si esta MISMA llamada se reintenta por
  // un timeout de red entre nuestro backend y MP, MP la reconoce como el
  // mismo intento y no cobra dos veces. Un token distinto (otra tarjeta, u
  // otro intento) genera naturalmente una clave distinta — nunca colapsa
  // intentos de pago legítimamente distintos en la misma clave.
  const claveIdempotencia = idempotencyKey ||
    `pedido-${pedido.id}-${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}`;

  const { data: pago } = await axios.post(
    `${MP_BASE_URL}/v1/payments`,
    payload,
    { headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'X-Idempotency-Key': claveIdempotencia,
      } }
  );

  return aplicarResultadoPago(pedido, pago);
};

// ─── Registrar pago en efectivo (al entregar) ─────────────────
const registrarPagoEfectivo = async ({ pedido, monto_recibido }) => {
  if (pedido.metodo_pago !== 'efectivo') {
    return { ok: false, mensaje: 'Este pedido no es pago en efectivo.' };
  }
  if (pedido.pago_estado === 'capturado') {
    const cambio = parseFloat(pedido.total) <= parseFloat(monto_recibido)
      ? parseFloat(monto_recibido) - parseFloat(pedido.total) : 0;
    return { ok: true, pedido, cambio, yaRegistrado: true };
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
  guardarTarjetaMP,
  eliminarTarjetaMP,
  generarTokenDesdeTarjetaGuardada,
  crearPagoConTarjeta,
  LIMITE_EFECTIVO,
};
