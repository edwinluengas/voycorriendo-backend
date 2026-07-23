const PlatformRevenue    = require('../models/PlatformRevenue');
const LedgerConciliacion = require('../models/LedgerConciliacion');
const { getComision }    = require('./config.service');
const { COMISION_FLAT, LIMITE_PEDIDOS_DEUDA, AVISO_PEDIDOS_DEUDA, MP_FEE_PCT, MP_FEE_FIJO, IVA_PCT } = require('../config/precios');
const tg = require('./telegram.service');

// ─── Procesar entrega ─────────────────────────────────────
// Llamado cuando un pedido pasa a estado 'entregado'.
// 1. Determina comisiones desde DB (con cache).
// 2. Escribe registro de conciliación.
// 3. Actualiza platform_revenue (compatibilidad hacia atrás).
const procesarEntrega = async ({ pedido, repartidor }) => {
  const tipoEnvio   = pedido.tipo_envio || 'standard';
  const metodoPago  = pedido.metodo_pago || 'efectivo';
  const feeCliente  = parseFloat(pedido.fee_cliente || pedido.costo_envio || 0);
  const subtotal    = parseFloat(pedido.subtotal || 0);

  // Obtener comisión desde DB
  const comision = await getComision(metodoPago, tipoEnvio);
  const pagoRepa = comision.pago_repartidor;
  const netPlat  = comision.comision_plataforma;

  // Modo de liquidación de comida
  const liquidacion = metodoPago === 'efectivo' ? 'efectivo_repartidor' : 'mp_directo';

  // ── Prorrateo de la comisión de MP + IVA (solo pagos digitales) ──
  // feeMP = (3.49% × total + $4.00) × 1.16 — verificada contra un pago real
  // en producción ($185 → $12.13 exacto). Cada parte absorbe la porción
  // proporcional a su ingreso bruto dentro del cobro: negocio → subtotal,
  // repartidor → envío. (La propina se cobra en un cargo aparte y se
  // prorratea al acreditarse en calificarPedido.)
  let feeMpNegocio = 0, feeMpRepartidor = 0;
  if (metodoPago !== 'efectivo') {
    const montoCobrado = subtotal + feeCliente;
    if (montoCobrado > 0) {
      const feeMP = (MP_FEE_PCT * montoCobrado + MP_FEE_FIJO) * (1 + IVA_PCT);
      feeMpNegocio    = Math.round(feeMP * (subtotal / montoCobrado) * 100) / 100;
      feeMpRepartidor = Math.round((feeMP - feeMpNegocio) * 100) / 100;
    }
  }

  // Ledger de conciliación
  await LedgerConciliacion.upsert({
    pedido_id:           pedido.id,
    fee_envio_cobrado:   feeCliente,
    subtotal_productos:  subtotal,
    pago_repartidor:     pagoRepa,
    comision_plataforma: netPlat,
    fee_mp_negocio:      feeMpNegocio,
    fee_mp_repartidor:   feeMpRepartidor,
    metodo_pago:         metodoPago,
    tipo_envio:          tipoEnvio,
    liquidacion_comida:  liquidacion,
    distancia_km:        pedido.distancia_km || null,
  });

  // Actualizar pago_repartidor en el pedido (lo lee ganancias del repartidor)
  try {
    await pedido.update({ pago_repartidor: pagoRepa });
  } catch (e) {
    console.warn('[economia] No se pudo actualizar pago_repartidor en pedido:', e.message);
  }

  // Compatibilidad platform_revenue
  await PlatformRevenue.upsert({
    order_id:         pedido.id,
    client_fee:       feeCliente,
    driver_payout:    pagoRepa,
    net_revenue:      netPlat,
    token_value:      0,
    transaction_cost: 0,
    gateway_fee:      0,
    tier:             tipoEnvio,
  });

  // ── Tracking de deuda para pedidos en efectivo ─────────────
  // En efectivo: el repartidor paga al restaurante y cobra al cliente.
  // El restaurante queda debiendo el FEE ($35) a la plataforma.
  if (metodoPago === 'efectivo' && repartidor) {
    try {
      const { Negocio, Usuario } = require('../models');
      const negocio = await Negocio.findByPk(pedido.negocio_id);
      if (negocio) {
        // Incremento ATÓMICO a nivel DB — dos entregas en efectivo del
        // mismo negocio casi simultáneas ya no se pisan el incremento
        // (read-modify-write en JS perdía actualizaciones bajo carrera).
        await negocio.increment(
          { deuda_plataforma: COMISION_FLAT, pedidos_efectivo_pendientes: 1 }
        );
        await negocio.reload();
        const nuevaDeuda    = parseFloat(negocio.deuda_plataforma || 0);
        const nuevoContador = negocio.pedidos_efectivo_pendientes || 0;

        if (nuevoContador >= LIMITE_PEDIDOS_DEUDA && !negocio.bloqueado_por_deuda) {
          negocio.bloqueado_por_deuda = true;
          negocio.estado_cuenta = 'bloqueado';
          negocio.estado_motivo = `Llegaste a ${nuevoContador} pedidos en efectivo sin liquidar ($${nuevaDeuda.toFixed(2)} MXN). Transfiere por SPEI para reactivar.`;
          // Notificar al dueño
          const dueno = await Usuario.findByPk(negocio.usuario_id, { attributes: ['telegram_chat_id', 'nombre'] });
          if (dueno?.telegram_chat_id) {
            tg.enviar(dueno.telegram_chat_id,
              `🚫 <b>Tu cuenta ha sido bloqueada</b>\n\n` +
              `Llegaste a <b>${nuevoContador} pedidos en efectivo</b> sin liquidar, lo que suma <b>$${nuevaDeuda.toFixed(2)} MXN</b>.\n\n` +
              `Para reactivar tu negocio, transfiere por SPEI y notifícanos.\n` +
              `Contacto: WhatsApp o Telegram de soporte.`
            ).catch(() => {});
          }
        } else if (nuevoContador >= AVISO_PEDIDOS_DEUDA && nuevoContador < LIMITE_PEDIDOS_DEUDA) {
          const dueno = await Usuario.findByPk(negocio.usuario_id, { attributes: ['telegram_chat_id'] });
          if (dueno?.telegram_chat_id) {
            tg.enviar(dueno.telegram_chat_id,
              `⚠️ <b>Aviso de deuda</b>\n\n` +
              `Llevas <b>${nuevoContador} de ${LIMITE_PEDIDOS_DEUDA}</b> pedidos en efectivo sin liquidar (<b>$${nuevaDeuda.toFixed(2)} MXN</b>).\n\n` +
              `Liquida tu deuda por SPEI para evitar que se bloquee tu cuenta.`
            ).catch(() => {});
          }
        }

        await negocio.save();
      }
    } catch (e) {
      console.error('[economia] Error actualizando deuda del negocio:', e.message);
    }
  }

  console.log(
    `[economia] ${pedido.numero} entregado` +
    ` | fee_cliente: $${feeCliente}` +
    ` | pago_rep: $${pagoRepa}` +
    ` | comision_plat: $${netPlat}` +
    ` | metodo: ${metodoPago}`,
  );

  return { pagoRepa, netPlat };
};

// Legacy: zonas premium eliminadas
const esZonaPremium = () => false;

// Exponer getComision para uso en pedidosController
const calcularFeeCliente = ({ tipoEnvio }) => {
  if (tipoEnvio === 'express') return 60;
  if (tipoEnvio === 'pickup')  return 0;
  return 35;
};

module.exports = { calcularFeeCliente, esZonaPremium, procesarEntrega };
