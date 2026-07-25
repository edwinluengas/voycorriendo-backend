const cron = require('node-cron');
const { Op } = require('sequelize');
const { Pedido, Usuario } = require('../models');
const push = require('../services/notificaciones.service');
const tg = require('../services/telegram.service');
const pagosService = require('../services/pagos.service');
const creditosService = require('../services/creditos.service');

// Reembolso automático al cliente cuando un pedido con cobro digital YA
// capturado se cancela por timeout. Sin repartidor involucrado en estos dos
// caminos (pendiente/listo sin asignar) — no genera saldo por cobrar.
async function reembolsarSiAplica(pedido, motivo) {
  const pagadoConCreditoTotal = String(pedido.pago_referencia || '').startsWith('CREDITO-');
  if (['tarjeta', 'mercado_pago'].includes(pedido.metodo_pago) && pedido.pago_estado === 'capturado') {
    try {
      if (!pagadoConCreditoTotal) {
        const r = await pagosService.reembolsarPagoMP(pedido);
        if (r.ok) {
          const montoMP = parseFloat(pedido.total) - parseFloat(pedido.credito_aplicado || 0);
          console.log(`[PedidoTimeout] ${pedido.numero} — $${montoMP} reembolsados automáticamente (${motivo}).`);
          tg.enviarAdmin(`↩️ Pedido <b>${pedido.numero}</b> cancelado (${motivo}) — se reembolsaron $${montoMP.toFixed(2)} al cliente automáticamente.`).catch(() => {});
        }
      } else {
        pedido.pago_estado = 'reembolsado';
        await pedido.save();
      }
    } catch (e) {
      console.error(`[PedidoTimeout] FALLO reembolso de ${pedido.numero}:`, e.response?.data || e.message);
      tg.enviarAdmin(`⚠️ Pedido <b>${pedido.numero}</b> cancelado (${motivo}) con pago capturado pero el reembolso automático FALLÓ — hacerlo manual en el panel de MP (payment ${pedido.pago_referencia}).`).catch(() => {});
    }
  }
  // Crédito aplicado (cualquier método de pago) — siempre se devuelve.
  if (parseFloat(pedido.credito_aplicado || 0) > 0) {
    try {
      await creditosService.devolverCredito({
        usuarioId: pedido.cliente_id,
        monto: pedido.credito_aplicado,
        motivo: `Devolución de crédito — pedido ${pedido.numero} cancelado (${motivo}).`,
        pedidoId: pedido.id,
      });
    } catch (e) {
      console.error(`[PedidoTimeout] FALLO devolviendo crédito de ${pedido.numero}:`, e.message);
      tg.enviarAdmin(`⚠️ Pedido <b>${pedido.numero}</b> cancelado (${motivo}) tenía crédito aplicado — la devolución automática FALLÓ, hacerla manual.`).catch(() => {});
    }
  }
}

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
    await reembolsarSiAplica(pedido, 'sin repartidor');
    // La comida ya estaba lista — es un pedido PERDIDO (50% restaurante /
    // 50% plataforma, sin repartidor involucrado).
    try {
      const { registrarPerdida } = require('../services/perdidas.service');
      await registrarPerdida({ pedido, nota: 'Cancelado en "listo" sin repartidor disponible.' });
    } catch (e) {
      console.error(`[PedidoTimeout] FALLO registrando pérdida de ${pedido.numero}:`, e.message);
    }

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
    await pedido.update({
      estado: 'cancelado',
      nota_cancelacion: `El negocio no respondió en ${PENDIENTE_TIMEOUT_MIN} minutos.`,
    });
    await reembolsarSiAplica(pedido, 'negocio sin responder');

    try {
      const cliente = await Usuario.findByPk(pedido.cliente_id, { attributes: ['token_push'] });
      if (cliente?.token_push) {
        push.notificarEstadoPedido(cliente.token_push, pedido, 'cancelado').catch(() => {});
      }
    } catch (_) {}

    console.log(`[PedidoTimeout] ${pedido.numero} cancelado — negocio sin responder tras ${PENDIENTE_TIMEOUT_MIN} min.`);
  }
}

// Red de seguridad INDEPENDIENTE del intento síncrono en pagarConTarjeta:
// cualquier pedido con tarjeta ya definitivamente rechazada (pago_estado
// 'fallido') que sigue en 'pendiente' con crédito de plataforma aplicado se
// cancela y se devuelve el crédito de inmediato, sin esperar el timeout
// general de 20 min. Existe porque un rechazo real (2026-07-25, cuenta
// 5545074460, dos veces seguidas) puede caer justo en la ventana de un
// despliegue en curso y perderse el intento síncrono — este barrido corre
// cada 5 min pase lo que pase, no depende de en qué instante se rechazó.
async function liberarCreditoAtrapado() {
  const pedidos = await Pedido.findAll({
    where: {
      estado: 'pendiente',
      metodo_pago: 'tarjeta',
      pago_estado: 'fallido',
      credito_aplicado: { [Op.gt]: 0 },
    },
  });

  for (const pedido of pedidos) {
    const [cancelado] = await Pedido.update(
      { estado: 'cancelado', cancelado_en: new Date(), nota_cancelacion: 'Pago con tarjeta rechazado por el banco.' },
      { where: { id: pedido.id, estado: 'pendiente' } }
    );
    if (!cancelado) continue;
    try {
      await creditosService.devolverCredito({
        usuarioId: pedido.cliente_id,
        monto: pedido.credito_aplicado,
        motivo: `Devolución de crédito — pago con tarjeta rechazado (pedido ${pedido.numero}), detectado por el barrido de seguridad.`,
        pedidoId: pedido.id,
      });
      console.log(`[PedidoTimeout] ${pedido.numero} — crédito de $${pedido.credito_aplicado} liberado (barrido de seguridad, pago ya fallido).`);
    } catch (e) {
      console.error(`[PedidoTimeout] FALLO liberando crédito atrapado de ${pedido.numero}:`, e.message);
      tg.enviarAdmin(`⚠️ Pedido <b>${pedido.numero}</b>: crédito de $${parseFloat(pedido.credito_aplicado).toFixed(2)} atrapado tras rechazo de tarjeta — la devolución automática (barrido) FALLÓ, hacerla manual.`).catch(() => {});
    }
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
    try {
      await liberarCreditoAtrapado();
    } catch (e) {
      console.error('[PedidoTimeout] Error en liberarCreditoAtrapado:', e.message);
    }
  });
  console.log(`[PedidoTimeout] Job iniciado — revisa cada 5 min, cancela 'listo' tras ${TIMEOUT_MIN} min, cancela 'pendiente' tras ${PENDIENTE_TIMEOUT_MIN} min, alerta atascados tras ${ATASCADO_MIN} min, libera crédito atrapado por tarjeta rechazada en cada corrida.`);
}

module.exports = { iniciarJobPedidoTimeout };
