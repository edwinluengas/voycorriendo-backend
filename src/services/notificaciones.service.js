/**
 * Servicio de notificaciones push via Expo Push API
 * No requiere Firebase ni APNs directamente — Expo lo gestiona.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Envía push notification(s).
 * @param {string|string[]} tokens  ExponentPushToken(s)
 * @param {string} titulo
 * @param {string} cuerpo
 * @param {object} data             Payload para la app (navegación, etc.)
 */
async function enviarPush(tokens, titulo, cuerpo, data = {}) {
  const lista = (Array.isArray(tokens) ? tokens : [tokens])
    .filter((t) => t && typeof t === 'string' && t.startsWith('ExponentPushToken'));

  if (lista.length === 0) return;

  const mensajes = lista.map((to) => ({
    to,
    title: titulo,
    body: cuerpo,
    data,
    sound: 'default',
    priority: 'high',
  }));

  try {
    const resp = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(mensajes),
    });
    if (!resp.ok) {
      console.warn('[Push] Error HTTP:', resp.status);
    }
  } catch (e) {
    console.warn('[Push] No se pudo enviar notificación:', e.message);
  }
}

// ─── Helpers de alto nivel ────────────────────────────────

async function notificarNuevoPedido(tokenNegocio, pedido) {
  const items = Array.isArray(pedido.items) ? pedido.items : [];
  const totalItems = items.reduce((s, it) => s + (it.cantidad || 0), 0);
  await enviarPush(
    tokenNegocio,
    `🛵 Nuevo pedido #${pedido.numero}`,
    `$${parseFloat(pedido.total).toFixed(0)} · ${totalItems} artículo${totalItems !== 1 ? 's' : ''}`,
    { tipo: 'nuevo_pedido', pedidoId: pedido.id },
  );
}

async function notificarEstadoPedido(tokenCliente, pedido, estado) {
  const mensajes = {
    confirmado:  { titulo: '✅ Pedido confirmado',     cuerpo: `Tu pedido #${pedido.numero} fue aceptado. ¡Ya lo están preparando!` },
    preparando:  { titulo: '🍳 Preparando tu pedido',  cuerpo: `#${pedido.numero} está en preparación. Pronto saldrá.` },
    listo:       { titulo: '📦 Pedido listo',           cuerpo: `#${pedido.numero} está listo. El repartidor lo recogerá en breve.` },
    en_camino:   { titulo: '🛵 ¡Va en camino!',         cuerpo: `Tu repartidor ya recogió #${pedido.numero} y va hacia ti.` },
    entregado:   { titulo: '🎉 ¡Pedido entregado!',     cuerpo: `#${pedido.numero} fue entregado. ¡Buen provecho!` },
    cancelado:   { titulo: '❌ Pedido cancelado',       cuerpo: `Tu pedido #${pedido.numero} fue cancelado.` },
    rechazado:   { titulo: '🚫 Pedido rechazado',       cuerpo: `El negocio no pudo aceptar tu pedido #${pedido.numero}.` },
  };
  const msg = mensajes[estado];
  if (!msg) return;
  await enviarPush(tokenCliente, msg.titulo, msg.cuerpo, { tipo: 'estado_pedido', pedidoId: pedido.id, estado });
}

async function notificarRepartidoresDisponibles(tokens, pedido) {
  if (!tokens || tokens.length === 0) return;
  await enviarPush(
    tokens,
    '🛵 Nuevo pedido disponible',
    `#${pedido.numero} · $${parseFloat(pedido.total).toFixed(0)} · ${pedido.ciudad || 'Puerto Escondido'}`,
    { tipo: 'pedido_disponible', pedidoId: pedido.id },
  );
}

module.exports = { enviarPush, notificarNuevoPedido, notificarEstadoPedido, notificarRepartidoresDisponibles };
