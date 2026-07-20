const cron = require('node-cron');
const { Op } = require('sequelize');
const { Pedido, Usuario } = require('../models');
const push = require('../services/notificaciones.service');
const tg = require('../services/telegram.service');

const TIMEOUT_MIN = parseInt(process.env.PEDIDO_TIMEOUT_MIN || '15');
// Si el negocio nunca confirma/rechaza (no vio la notificación, está
// bloqueado por deuda y no puede ni rechazar limpio, etc.) el pedido no debe
// quedarse esperando para siempre — se cancela solo.
const PENDIENTE_TIMEOUT_MIN = parseInt(process.env.PEDIDO_PENDIENTE_TIMEOUT_MIN || '20');
// Una entrega real puede tardar; solo alertamos (no cancelamos automático)
// cuando lleva demasiado tiempo "en_camino" sin cerrarse — probable que el
// repartidor haya perdido el pedido de vista sin confirmar la entrega.
const ATASCADO_MIN = parseInt(process.env.PEDIDO_ATASCADO_MIN || '90');

async function cancelarPedidosExpirados() {
  const limite = new Date(Date.now() - TIMEOUT_MIN * 60 * 1000);

  const pedidos = await Pedido.findAll({
    where: {
      estado: 'listo',
      repartidor_id: null,
      creado_en: { [Op.lt]: limite },
    },
  });

  for (const pedido of pedidos) {
    await pedido.update({
      estado: 'cancelado',
      nota_cancelacion: `Sin repartidor disponible tras ${TIMEOUT_MIN} minutos.`,
    });

    try {
      const cliente = await Usuario.findByPk(pedido.cliente_id, { attributes: ['token_push'] });
      if (cliente?.token_push) {
        push.notificarEstadoPedido(cliente.token_push, pedido, 'cancelado').catch(() => {});
      }
    } catch (_) {}

    console.log(`[PedidoTimeout] ${pedido.numero} cancelado — sin repartidor tras ${TIMEOUT_MIN} min.`);
  }
}

async function cancelarPedidosPendientesSinRespuesta() {
  const limite = new Date(Date.now() - PENDIENTE_TIMEOUT_MIN * 60 * 1000);

  const pedidos = await Pedido.findAll({
    where: { estado: 'pendiente', creado_en: { [Op.lt]: limite } },
  });

  for (const pedido of pedidos) {
    const notaPago = pedido.metodo_pago !== 'efectivo' && pedido.pago_estado === 'capturado'
      ? ' — pago ya capturado, requiere reembolso manual.'
      : '';
    await pedido.update({
      estado: 'cancelado',
      nota_cancelacion: `El negocio no respondió en ${PENDIENTE_TIMEOUT_MIN} minutos.${notaPago}`,
    });

    if (notaPago) {
      console.warn(`[PedidoTimeout] ${pedido.numero} cancelado con pago ya capturado — revisar reembolso manual.`);
      tg.enviarAdmin(`⚠️ Pedido <b>${pedido.numero}</b> cancelado por timeout con pago ya capturado — requiere reembolso manual.`).catch(() => {});
    }

    try {
      const cliente = await Usuario.findByPk(pedido.cliente_id, { attributes: ['token_push'] });
      if (cliente?.token_push) {
        push.notificarEstadoPedido(cliente.token_push, pedido, 'cancelado').catch(() => {});
      }
    } catch (_) {}

    console.log(`[PedidoTimeout] ${pedido.numero} cancelado — negocio sin responder tras ${PENDIENTE_TIMEOUT_MIN} min.`);
  }
}

// Alerta (no cancela) pedidos "en_camino" atascados. Se avisa UNA vez por
// pedido: solo si el cruce del umbral cae dentro de la ventana de este tick
// del cron (evita reenviar la misma alerta cada 5 min indefinidamente).
async function alertarPedidosAtascados() {
  const limite = new Date(Date.now() - ATASCADO_MIN * 60 * 1000);
  const ventana = new Date(Date.now() - (ATASCADO_MIN + 5) * 60 * 1000);

  const pedidos = await Pedido.findAll({
    where: {
      estado: 'en_camino',
      repartidor_id: { [Op.ne]: null },
      asignado_en: { [Op.lt]: limite, [Op.gte]: ventana },
    },
  });

  for (const pedido of pedidos) {
    const minutos = Math.round((Date.now() - new Date(pedido.asignado_en).getTime()) / 60000);
    tg.alertaAdminPedidoAtascado(pedido.numero, minutos).catch(() => {});
    console.warn(`[PedidoTimeout] ${pedido.numero} atascado en_camino hace ${minutos} min — admin alertado.`);
  }
}

function iniciarJobPedidoTimeout() {
  cron.schedule('*/5 * * * *', async () => {
    try {
      await cancelarPedidosExpirados();
    } catch (e) {
      console.error('[PedidoTimeout] Error:', e.message);
    }
    try {
      await cancelarPedidosPendientesSinRespuesta();
    } catch (e) {
      console.error('[PedidoTimeout] Error en cancelarPedidosPendientesSinRespuesta:', e.message);
    }
    try {
      await alertarPedidosAtascados();
    } catch (e) {
      console.error('[PedidoTimeout] Error en alertarPedidosAtascados:', e.message);
    }
  });
  console.log(`[PedidoTimeout] Job iniciado — revisa cada 5 min, cancela 'listo' tras ${TIMEOUT_MIN} min, cancela 'pendiente' tras ${PENDIENTE_TIMEOUT_MIN} min, alerta atascados tras ${ATASCADO_MIN} min.`);
}

module.exports = { iniciarJobPedidoTimeout };
