/**
 * Servicio de notificaciones Telegram.
 *
 * Variables de entorno:
 *   TELEGRAM_BOT_TOKEN      — token del bot (BotFather)
 *   TELEGRAM_ADMIN_CHAT_ID  — chat_id del canal/usuario admin
 *   API_PUBLIC_URL          — para registrar el webhook con Telegram
 */

const axios = require('axios');

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const BASE_URL = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

// ─── Primitivo ─────────────────────────────────────────────────
const enviar = async (chatId, texto, extras = {}) => {
  if (!BASE_URL || !chatId) return;
  try {
    await axios.post(`${BASE_URL}/sendMessage`, {
      chat_id:    chatId,
      text:       texto,
      parse_mode: 'HTML',
      ...extras,
    });
  } catch (err) {
    console.error('[Telegram] Error al enviar:', err.response?.data?.description || err.message);
  }
};

const enviarAdmin = (texto) => enviar(ADMIN_ID, texto);

// Secret para validar que el webhook viene de Telegram
const WEBHOOK_SECRET = TOKEN
  ? require('crypto').createHash('sha256').update(TOKEN).digest('hex').substring(0, 32)
  : null;

// ─── Registrar webhook con Telegram ───────────────────────────
const registrarWebhook = async () => {
  if (!BASE_URL) {
    console.warn('[Telegram] Sin TELEGRAM_BOT_TOKEN — bot desactivado.');
    return;
  }
  const url = `${process.env.API_PUBLIC_URL}/api/telegram/webhook`;
  try {
    const { data } = await axios.post(`${BASE_URL}/setWebhook`, {
      url,
      secret_token: WEBHOOK_SECRET,
    });
    console.log(`[Telegram] Webhook registrado: ${data.description}`);
  } catch (err) {
    console.error('[Telegram] Error registrando webhook:', err.response?.data || err.message);
  }
};


// ─── Alertas de negocio ────────────────────────────────────────

const alertaNuevoPedido = async (negocioChatId, pedido) => {
  const txt = `🛒 <b>Nuevo pedido</b> #${pedido.numero}\n💰 Total: $${parseFloat(pedido.total).toFixed(2)} MXN\n📦 ${pedido.tipo_envio === 'express' ? '⚡ Express' : 'Estándar'}\n📍 ${pedido.direccion_entrega}`;
  await enviar(negocioChatId, txt);
};

const alertaPedidoEntregado = async (negocioChatId, pedido) => {
  const txt = `✅ <b>Pedido entregado</b> #${pedido.numero}\n💰 $${parseFloat(pedido.total).toFixed(2)} MXN`;
  await enviar(negocioChatId, txt);
};

const alertaTokensBajos = async (negocioChatId, tokensRestantes) => {
  const txt = `⚠️ <b>Tokens bajos</b>: te quedan <b>${tokensRestantes}</b> tokens.\nSin tokens se cobra $30 por entrega. <a href="voycorriendo://tokens">Comprar tokens</a>`;
  await enviar(negocioChatId, txt);
};

// ─── Alertas de repartidor ─────────────────────────────────────

const alertaPedidoAsignado = async (driverChatId, pedido) => {
  const txt = `🛵 <b>Pedido asignado</b> #${pedido.numero}\n🏪 ${pedido.negocio?.nombre || 'Negocio'}\n📍 → ${pedido.direccion_entrega}\n💵 Ganancia: $${pedido.ganancia_estimada || '35'}`;
  await enviar(driverChatId, txt);
};

const alertaPagoSPEI = async (driverChatId, { total, entregas, tracking_id }) => {
  const txt = `💸 <b>Pago SPEI enviado</b>\n📦 ${entregas} entregas\n💰 $${total.toFixed(2)} MXN\n🔑 Referencia: ${tracking_id}`;
  await enviar(driverChatId, txt);
};

const alertaSPEIFallido = async (driverChatId, nombre, motivo) => {
  await enviar(driverChatId, `❌ No pudimos enviarte el pago SPEI.\nMotivo: ${motivo}\nContacta a soporte.`);
  await enviarAdmin(`❌ <b>SPEI fallido</b> para ${nombre}\nMotivo: ${motivo}`);
};

const alertaAprobado = async (driverChatId, nombre) => {
  await enviar(driverChatId, `🎉 <b>¡Bienvenido, ${nombre}!</b>\nTu cuenta como repartidor fue aprobada. Ya puedes conectarte y tomar pedidos.`);
};

const alertaRechazado = async (driverChatId, nota) => {
  await enviar(driverChatId, `❌ <b>Solicitud rechazada</b>\n${nota || 'Contacta a soporte para más información.'}`);
};

// ─── Alertas de admin ──────────────────────────────────────────

const alertaAdminNuevoRepartidor = (nombre) =>
  enviarAdmin(`👤 <b>Nuevo repartidor</b> en revisión: ${nombre}`);

const alertaAdminNuevoNegocio = (nombre) =>
  enviarAdmin(`🏪 <b>Nuevo negocio</b> en revisión: ${nombre}`);

const alertaAdminPedidoSinDriver = (pedidoNumero, minutos) =>
  enviarAdmin(`⏰ Pedido <b>${pedidoNumero}</b> sin repartidor asignado hace ${minutos} min.`);

const alertaAdminPedidoAtascado = (pedidoNumero, minutos) =>
  enviarAdmin(
    `🚨 Pedido <b>${pedidoNumero}</b> lleva ${minutos} min en camino sin confirmarse como entregado. ` +
    `Puede que el repartidor no haya cerrado la entrega. Revísalo en el panel admin.`
  );

module.exports = {
  enviar,
  enviarAdmin,
  registrarWebhook,
  alertaNuevoPedido,
  alertaPedidoEntregado,
  alertaTokensBajos,
  alertaPedidoAsignado,
  alertaPagoSPEI,
  alertaSPEIFallido,
  alertaAprobado,
  alertaRechazado,
  alertaAdminNuevoRepartidor,
  alertaAdminNuevoNegocio,
  alertaAdminPedidoSinDriver,
  alertaAdminPedidoAtascado,
  WEBHOOK_SECRET,
};
