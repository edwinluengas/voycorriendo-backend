const cron = require('node-cron');
const { Op } = require('sequelize');
const { Pedido, Usuario } = require('../models');
const push = require('../services/notificaciones.service');

const TIMEOUT_MIN = parseInt(process.env.PEDIDO_TIMEOUT_MIN || '15');

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

function iniciarJobPedidoTimeout() {
  cron.schedule('*/5 * * * *', async () => {
    try {
      await cancelarPedidosExpirados();
    } catch (e) {
      console.error('[PedidoTimeout] Error:', e.message);
    }
  });
  console.log(`[PedidoTimeout] Job iniciado — revisa cada 5 min, cancela tras ${TIMEOUT_MIN} min.`);
}

module.exports = { iniciarJobPedidoTimeout };
