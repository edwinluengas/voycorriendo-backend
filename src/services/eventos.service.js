/**
 * Bitácora en vivo del negocio por Telegram.
 *
 * Hasta ahora el bot solo avisaba de PROBLEMAS: pagos rechazados, pedidos
 * atascados, pérdidas. La operación normal —un pedido nuevo, alguien que se
 * registra, dinero que sale en un retiro— pasaba invisible, así que el dueño
 * no tenía forma de saber cómo va el día sin entrar a la base.
 *
 * Todo evento pasa por aquí para que el formato sea uno solo y para poder
 * apagarlo desde una variable el día que el volumen crezca y el chat se
 * vuelva ruido (BOT_AVISA_TODO=false deja solo las alertas críticas, que
 * viven en sus propios servicios y no dependen de esto).
 *
 * NUNCA lanza: un aviso que falla no puede tumbar un pedido.
 */
const tg = require('./telegram.service');

// Se lee en CADA consulta, no al cargar el módulo. Como constante, cambiar
// la variable en Railway no surtía efecto hasta reiniciar el proceso — y
// eso ya nos mordió: el puente de correo siguió redirigiendo a un buzón
// personal después de darlo por apagado. Un interruptor que promete
// 'se cambia sin desplegar' tiene que cumplirlo.
const avisaTodo = () => String(process.env.BOT_AVISA_TODO || 'true').toLowerCase() === 'true';

const money = (n) => '$' + Number(n || 0).toFixed(2);

const enviar = async (texto) => {
  if (!avisaTodo()) return false;
  try {
    await tg.enviarAdmin(texto);
    return true;
  } catch (e) {
    console.warn('[eventos] No se pudo avisar al admin:', e.message);
    return false;
  }
};

// ─── Pedidos ──────────────────────────────────────────────
const pedidoCreado = (pedido, negocio) => enviar(
  `🆕 <b>Pedido nuevo ${pedido.numero}</b>\n`
  + `🏪 ${negocio?.nombre || '—'}\n`
  + `💵 ${money(pedido.total)} · ${pedido.metodo_pago}\n`
  + `🚚 ${pedido.tipo_envio}${pedido.distancia_km ? ` · ${pedido.distancia_km} km` : ''}`,
);

// Una línea por transición para poder seguir el pedido de principio a fin.
const ESTADO_EMOJI = {
  confirmado: '✅', preparando: '👨‍🍳', listo: '📦', en_camino: '🛵',
  en_envio: '🚚', entregado: '🎉', cancelado: '❌', rechazado: '🚫',
};

const pedidoCambioEstado = (pedido, estadoAnterior, quien) => enviar(
  `${ESTADO_EMOJI[pedido.estado] || '🔄'} <b>${pedido.numero}</b>: `
  + `${estadoAnterior} → <b>${pedido.estado}</b>`
  + (quien ? `\nPor: ${quien}` : ''),
);

// ─── Altas y perfiles ─────────────────────────────────────
const perfilEnRevision = (tipo, usuario, detalle) => enviar(
  `📝 <b>Perfil esperando revisión</b>\n`
  + `${tipo === 'repartidor' ? '🛵 Repartidor' : '🏪 Negocio'}: `
  + `${detalle || ''} ${usuario?.nombre || ''} ${usuario?.apellido || ''}\n`
  + `Tel: <code>${usuario?.telefono || '—'}</code>\n\n`
  + `Revísalo con <code>/pendientes</code> y apruébalo con `
  + `<code>/aprobar ${usuario?.telefono || ''}</code>`,
);

const usuarioRegistrado = (usuario) => enviar(
  `👤 <b>Cuenta nueva</b>: ${usuario?.nombre || ''} ${usuario?.apellido || ''}\n`
  + `Tel: +${usuario?.lada || '52'} ${usuario?.telefono || '—'} · Rol: ${usuario?.rol || 'cliente'}`,
);

// ─── Dinero ───────────────────────────────────────────────
// Todo lo que saque dinero de la plataforma se avisa siempre: es la parte
// donde un error cuesta caro y donde conviene enterarse en el momento.
const retiroSolicitado = ({ tipo, nombre, telefono, monto, comision, esInmediato }) => enviar(
  `💸 <b>Retiro solicitado</b>\n`
  + `${tipo === 'repartidor' ? '🛵' : '🏪'} ${nombre || '—'} (${telefono || '—'})\n`
  + `Monto: <b>${money(monto)}</b>`
  + (comision ? ` · comisión ${money(comision)}` : '')
  + `\nTipo: ${esInmediato ? 'inmediato (con descuento)' : 'corte semanal (gratis)'}`,
);

const pagoRecibido = ({ pedido, metodo, monto }) => enviar(
  `💰 <b>Pago recibido</b> — ${pedido?.numero || '—'}\n`
  + `${money(monto)} · ${metodo}`,
);

module.exports = {
  pedidoCreado, pedidoCambioEstado, perfilEnRevision,
  usuarioRegistrado, retiroSolicitado, pagoRecibido, avisaTodo,
};
