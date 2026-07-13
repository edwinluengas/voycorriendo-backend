const PlatformRevenue    = require('../models/PlatformRevenue');
const LedgerConciliacion = require('../models/LedgerConciliacion');
const { getComision }    = require('./config.service');
const { COMISION_FLAT, TOPE_DEUDA, AVISO_DEUDA } = require('../config/precios');
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

  // Ledger de conciliación
  await LedgerConciliacion.upsert({
    pedido_id:           pedido.id,
    fee_envio_cobrado:   feeCliente,
    subtotal_productos:  subtotal,
    pago_repartidor:     pagoRepa,
    comision_plataforma: netPlat,
    metodo_pago:         metodoPago,
    tipo_envio:          tipoEnvio,
    liquidacion_comida:  liquidacion,
    distancia_km:        pedido.distancia_km || null,
  });

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
        const nuevaDeuda = parseFloat(negocio.deuda_plataforma || 0) + COMISION_FLAT;
        negocio.deuda_plataforma = parseFloat(nuevaDeuda.toFixed(2));

        if (nuevaDeuda >= TOPE_DEUDA && !negocio.bloqueado_por_deuda) {
          negocio.bloqueado_por_deuda = true;
          negocio.estado_cuenta = 'bloqueado';
          negocio.estado_motivo = `Deuda acumulada de $${nuevaDeuda.toFixed(2)} MXN con la plataforma. Transfiere por SPEI para reactivar.`;
          // Notificar al dueño
          const dueno = await Usuario.findByPk(negocio.usuario_id, { attributes: ['telegram_chat_id', 'nombre'] });
          if (dueno?.telegram_chat_id) {
            tg.enviar(dueno.telegram_chat_id,
              `🚫 <b>Tu cuenta ha sido bloqueada</b>\n\n` +
              `Tu deuda acumulada con VoyCorriendo es de <b>$${nuevaDeuda.toFixed(2)} MXN</b>.\n\n` +
              `Para reactivar tu negocio, transfiere por SPEI y notifícanos.\n` +
              `Contacto: WhatsApp o Telegram de soporte.`
            ).catch(() => {});
          }
        } else if (nuevaDeuda >= AVISO_DEUDA && nuevaDeuda < TOPE_DEUDA) {
          const dueno = await Usuario.findByPk(negocio.usuario_id, { attributes: ['telegram_chat_id'] });
          if (dueno?.telegram_chat_id) {
            tg.enviar(dueno.telegram_chat_id,
              `⚠️ <b>Aviso de deuda</b>\n\n` +
              `Tu deuda con VoyCorriendo es <b>$${nuevaDeuda.toFixed(2)} MXN</b>.\n` +
              `Límite antes del bloqueo: <b>$${TOPE_DEUDA} MXN</b>.\n\n` +
              `Liquida tu deuda por SPEI para evitar interrupciones.`
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
