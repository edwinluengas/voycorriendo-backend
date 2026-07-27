const PlatformRevenue    = require('../models/PlatformRevenue');
const LedgerConciliacion = require('../models/LedgerConciliacion');
const { getComision }    = require('./config.service');
const { COMISION_FLAT, LIMITE_PEDIDOS_DEUDA, AVISO_PEDIDOS_DEUDA, MP_FEE_PCT, MP_FEE_FIJO, IVA_PCT, TARIFAS_CLIENTE } = require('../config/precios');
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
  // feeMP = (3.49% × monto REAL cobrado por MP + $4.00) × 1.16 — verificada
  // contra un pago real en producción ($185 → $12.13 exacto). Cada parte
  // absorbe la porción proporcional a su ingreso bruto dentro del cobro:
  // negocio → subtotal, repartidor → envío + propina.
  //
  // CRÍTICO (2026-07-24): el monto real que Mercado Pago procesa es el
  // total del pedido MENOS el crédito de plataforma aplicado
  // (pedido.credito_aplicado) — MP nunca ve ni cobra fee sobre la porción
  // pagada con crédito, porque esa porción NUNCA pasa por MP. Cobrarle a
  // negocio/repartidor una fee calculada sobre el monto bruto (como si
  // TODO se hubiera cobrado por MP) les cobraría una comisión sobre dinero
  // que nunca se movió — y si el crédito cubrió el pedido completo, la fee
  // real es CERO (no hubo transacción de MP en absoluto).
  const propina = metodoPago !== 'efectivo' ? parseFloat(pedido.propina || 0) : 0;
  const creditoAplicado = parseFloat(pedido.credito_aplicado || 0);
  const montoCobradoBruto = subtotal + feeCliente + propina;
  const montoRealMP = Math.max(0, montoCobradoBruto - creditoAplicado);
  let feeMpNegocio = 0, feeMpRepartidor = 0;
  if (metodoPago !== 'efectivo' && montoRealMP > 0 && montoCobradoBruto > 0) {
    const feeMP = (MP_FEE_PCT * montoRealMP + MP_FEE_FIJO) * (1 + IVA_PCT);
    // Proporciones de ingreso NORMAL de cada parte (sin crédito), aplicadas
    // a la fee real (ya reducida por el crédito) — así cada quien absorbe
    // su parte proporcional de lo que MP realmente cobró, ni un peso más.
    feeMpNegocio    = Math.round(feeMP * (subtotal / montoCobradoBruto) * 100) / 100;
    feeMpRepartidor = Math.round((feeMP - feeMpNegocio) * 100) / 100;
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
    credito_aplicado:    creditoAplicado,
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

  // Propina de pago digital: YA se cobró al cliente dentro del cargo — se
  // acredita al fondo retirable del repartidor al entregar (neta de su
  // porción del fee de MP, que ya viene incluida en fee_mp_repartidor vía
  // el prorrateo de arriba... la propina se acredita ÍNTEGRA aquí y su fee
  // se descuenta junto con el del envío al liquidar el ledger).
  if (propina > 0 && repartidor) {
    try {
      const { FondoRepartidor } = require('../models');
      const [fondo] = await FondoRepartidor.findOrCreate({
        where: { repartidor_id: repartidor.id },
        defaults: { monto_disponible: 0, monto_reservado: 0 },
      });
      await fondo.increment('monto_disponible', { by: propina });
    } catch (e) {
      console.error('[economia] Error acreditando propina al fondo:', e.message);
    }
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

// Tarifa plana al cliente — una sola fuente de verdad (config/precios.js)
const calcularFeeCliente = ({ tipoEnvio }) => {
  if (tipoEnvio === 'express') return TARIFAS_CLIENTE.EXPRESS;
  if (tipoEnvio === 'pickup')  return 0;
  return TARIFAS_CLIENTE.STANDARD;
};

module.exports = { calcularFeeCliente, esZonaPremium, procesarEntrega };
