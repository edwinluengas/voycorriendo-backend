/**
 * ──────────────────────────────────────────────────────────────
 *  Servicio de Pagos - VoyCorriendo
 *  Métodos soportados: efectivo, tarjeta, transferencia, mercado_pago
 *  Cuáles están HABILITADOS hoy y el tope de efectivo viven en
 *  config/precios.js (METODOS_PAGO_ACTIVOS / LIMITE_EFECTIVO).
 * ──────────────────────────────────────────────────────────────
 */

const axios  = require('axios');
const crypto = require('crypto');
const tg = require('./telegram.service');
const { LIMITE_EFECTIVO, metodosPagoActivos, metodoPagoActivo } = require('../config/precios');

const MP_ACCESS_TOKEN   = process.env.MERCADOPAGO_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MERCADOPAGO_WEBHOOK_SECRET;
const MP_BASE_URL       = 'https://api.mercadopago.com';
const API_PUBLIC_URL    = process.env.API_PUBLIC_URL || 'https://voycorriendo-backend-production.up.railway.app';
const APP_DEEP_LINK     = process.env.APP_DEEP_LINK  || null;

// ─── Validación de método y límite de efectivo ────────────────
// El límite aplica al SUBTOTAL de productos. El fee de envío se cobra encima.
// Total pagado en efectivo = subtotal (≤ LIMITE_EFECTIVO) + costo_envio
const validarMetodoPago = ({ metodo_pago, subtotal, costo_envio = 0 }) => {
  const metodosValidos = ['efectivo', 'tarjeta', 'transferencia', 'mercado_pago'];
  if (!metodosValidos.includes(metodo_pago)) {
    return { ok: false, mensaje: 'Método de pago no válido.' };
  }
  if (!metodoPagoActivo(metodo_pago)) {
    return {
      ok: false,
      mensaje: 'Por ahora solo aceptamos pago en EFECTIVO al recibir tu pedido.',
      codigo: 'METODO_PAGO_DESACTIVADO',
    };
  }
  if (metodo_pago === 'efectivo' && subtotal > LIMITE_EFECTIVO) {
    const totalConEnvio = (subtotal + parseFloat(costo_envio || 0)).toFixed(2);
    const alternativas = metodosPagoActivos().filter((m) => m !== 'efectivo');
    return {
      ok: false,
      mensaje: `Efectivo solo disponible cuando los productos no superen $${LIMITE_EFECTIVO.toLocaleString('es-MX')} MXN. Tu subtotal es $${subtotal.toFixed(2)} (total con envío: $${totalConEnvio}).`
        + (alternativas.length ? ' Elige otro método de pago.' : ' Quita algo del carrito para continuar.'),
      codigo: 'LIMITE_EFECTIVO',
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
    // Si se aplicó crédito de plataforma, lo esperado a MP es el neto, no
    // el total del pedido — si no, esta validación (correcta en su
    // propósito: detectar manipulación del monto) rechazaría por error
    // cualquier pago legítimo parcialmente cubierto con crédito.
    const montoEsperado = parseFloat(pedido.total || 0) - parseFloat(pedido.credito_aplicado || 0);
    if (Math.abs(montoPagado - montoEsperado) > 0.5) {
      console.error(
        `[pago] MONTO NO COINCIDE pedido ${pedido.numero}: pagado=$${montoPagado} esperado=$${montoEsperado}`
      );
      // Posible manipulación del monto o un bug real en el cálculo de
      // fee/crédito — de cualquier forma, un admin debe verlo de inmediato,
      // no solo quedar en el log del servidor.
      tg.enviarAdmin(`🚨 <b>Monto de pago no coincide</b> — pedido <b>${pedido.numero}</b>\nMP cobró: $${montoPagado.toFixed(2)} | Esperado: $${montoEsperado.toFixed(2)}\nRevisar manual (posible manipulación o bug de cálculo).`).catch(() => {});
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
    // Un webhook que falla puede dejar un pago YA capturado en MP sin
    // reflejarse en nuestro pedido (pago_estado se queda 'pendiente' para
    // siempre si nadie más lo toca) — vale la pena que un admin lo revise.
    tg.enviarAdmin(`🚨 <b>Error procesando webhook de Mercado Pago</b>\n${JSON.stringify(error.response?.data || error.message).slice(0, 300)}`).catch(() => {});
    return { ok: false, mensaje: 'Error procesando webhook.' };
  }
};

// ─── Customers & Cards API: obtiene o crea el customer de MP ──
//
// OJO CON LA DESINCRONIZACIÓN: Mercado Pago guarda sus customers PARA
// SIEMPRE, del lado de ellos, y nosotros solo anotamos el id en
// `usuarios.mp_customer_id`. Cualquier cosa que borre esa columna de nuestro
// lado —una limpieza de datos, recrear una cuenta, eliminar y volver a
// registrarse— deja a MP con un customer que nosotros creemos que no existe.
// Entonces se intentaba crear otro con el mismo correo y MP respondía
// `bad_request` con la causa 101 "the customer already exist", que el código
// no atrapaba: el cliente veía "verifica los datos o intenta con otra
// tarjeta" y NINGUNA tarjeta le iba a funcionar nunca.
//
// La operación tiene que ser idempotente: si ya existe, se busca y se
// reutiliza. Es lo que MP espera que haga quien integra.
const obtenerOCrearCustomerMP = async (usuario) => {
  if (usuario.mp_customer_id) return usuario.mp_customer_id;

  const email = usuario.email || `usuario-${usuario.id}@voycorriendo.mx`;
  const cabeceras = { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } };

  const anotar = async (id) => {
    usuario.mp_customer_id = id;
    await usuario.save();
    return id;
  };

  try {
    const { data } = await axios.post(
      `${MP_BASE_URL}/v1/customers`,
      { email, first_name: usuario.nombre, last_name: usuario.apellido },
      cabeceras,
    );
    return anotar(data.id);
  } catch (e) {
    const causas = e.response?.data?.cause || [];
    const yaExiste = causas.some((c) => String(c.code) === '101')
      || /already exist/i.test(e.response?.data?.message || '');
    if (!yaExiste) throw e;

    // Existe del lado de MP pero no lo teníamos anotado: se busca por correo
    // y se recupera el vínculo.
    const { data } = await axios.get(
      `${MP_BASE_URL}/v1/customers/search?email=${encodeURIComponent(email)}`,
      cabeceras,
    );
    const encontrado = (data?.results || [])[0];
    if (!encontrado?.id) {
      // MP dice que existe pero no lo devuelve: no hay nada sensato que
      // hacer, y hay que verlo en los registros en vez de tragárselo.
      throw new Error(`Mercado Pago reporta un cliente existente para ${email} pero no lo encuentra al buscarlo.`);
    }
    console.warn(`[MP] Cliente ya existía en Mercado Pago y no estaba vinculado (${encontrado.id}) — vínculo restaurado.`);
    return anotar(encontrado.id);
  }
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
const crearPagoConTarjeta = async ({ pedido, cliente, token, installments, payment_method_id, issuer_id, idempotencyKey, mpCustomerId }) => {
  if (!MP_ACCESS_TOKEN) throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado en .env');

  const cuotas = Number.isInteger(Number(installments)) && installments >= 1 && installments <= 24
    ? Number(installments) : 1;

  // Cuando el token proviene de una tarjeta GUARDADA (Customers & Cards),
  // MP exige que el pagador sea ese customer: payer {type:'customer', id}.
  // Mandar payer {email} (formato de pago de invitado) con un token de
  // tarjeta de customer hace que MP rechace con 2002 "Customer not found"
  // — verificado en producción 2026-07-22: la tokenización desde card_id
  // funcionaba y el cobro reventaba justo después.
  // Si se aplicó crédito de plataforma al pedido (parcial — si cubría el
  // 100% el pedido ya se creó 'capturado' y ni siquiera se llama aquí), el
  // cobro real a la tarjeta es solo el remanente.
  const montoACobrar = Math.round((parseFloat(pedido.total) - parseFloat(pedido.credito_aplicado || 0)) * 100) / 100;
  const payload = {
    transaction_amount: montoACobrar,
    token,
    description: `Pedido VoyCorriendo #${pedido.numero}`,
    installments: cuotas,
    payment_method_id,
    ...(issuer_id ? { issuer_id } : {}),
    payer: mpCustomerId
      ? { type: 'customer', id: mpCustomerId }
      : { email: cliente?.email || `usuario-${cliente.id}@voycorriendo.mx` },
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

// ─── Reembolso TOTAL de un cobro con tarjeta capturado ─────────
// Para pedidos cobrados que se cancelan/rechazan SIN entregarse: regresa el
// dinero al cliente vía la Refunds API de MP. Solo aplica a pagos de MP
// (tarjeta / mercado_pago) con pago_estado='capturado' y pago_referencia
// (el payment id real de MP). La transferencia SPEI se reembolsa manual —
// no pasa por MP. Idempotente: clave estable por pedido, y MP rechaza un
// segundo reembolso total del mismo pago de todos modos.
const reembolsarPagoMP = async (pedido) => {
  if (!MP_ACCESS_TOKEN) throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado en .env');
  const esPagoMP = ['tarjeta', 'mercado_pago'].includes(pedido.metodo_pago);
  if (!esPagoMP || pedido.pago_estado !== 'capturado' || !pedido.pago_referencia) {
    return { ok: false, mensaje: 'Este pedido no tiene un cobro de Mercado Pago reembolsable.' };
  }
  const { data } = await axios.post(
    `${MP_BASE_URL}/v1/payments/${pedido.pago_referencia}/refunds`,
    {},
    { headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'X-Idempotency-Key': `reembolso-${pedido.id}`,
      } }
  );
  pedido.pago_estado = 'reembolsado';
  await pedido.save();
  return { ok: true, refund_id: data?.id || null };
};

// ─── Registrar pago en efectivo (al entregar) ─────────────────
// Lo que el repartidor debe cobrar en mano es el NETO (total - crédito de
// plataforma ya aplicado en crearPedido) — sin esto, un pedido con crédito
// parcial le cobraría al cliente el total completo OTRA VEZ en la entrega,
// duplicando lo que el crédito ya cubrió (bug real detectado 2026-07-24).
const registrarPagoEfectivo = async ({ pedido, monto_recibido }) => {
  if (pedido.metodo_pago !== 'efectivo') {
    return { ok: false, mensaje: 'Este pedido no es pago en efectivo.' };
  }
  const netoAdeudo = parseFloat(pedido.total) - parseFloat(pedido.credito_aplicado || 0);
  if (pedido.pago_estado === 'capturado') {
    const cambio = netoAdeudo <= parseFloat(monto_recibido)
      ? parseFloat(monto_recibido) - netoAdeudo : 0;
    return { ok: true, pedido, cambio, yaRegistrado: true };
  }
  if (parseFloat(monto_recibido) < netoAdeudo) {
    return { ok: false, mensaje: 'El monto recibido es menor al total.' };
  }
  pedido.pago_estado = 'capturado';
  pedido.pago_referencia = `EFVO-${Date.now()}`;
  await pedido.save();
  const cambio = parseFloat(monto_recibido) - netoAdeudo;
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
  reembolsarPagoMP,
  LIMITE_EFECTIVO,
};
