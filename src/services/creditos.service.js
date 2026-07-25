/**
 * Crédito de plataforma para clientes (2026-07-24).
 *
 * Uso: (1) un admin le otorga crédito libre a un cliente por cualquier
 * motivo, o (2) como compensación por un pedido no entregado — usable
 * después en CUALQUIER tienda al pagar. Nunca tocar `usuario.credito_disponible`
 * directo desde un controller: siempre por aquí, para que quede el
 * journal en `creditos_cliente` (por qué tiene este cliente ese saldo).
 */
const { Op } = require('sequelize');
const CreditoCliente = require('../models/CreditoCliente');
const Usuario = require('../models/Usuario');
const { sequelize } = require('../config/database');

const round2 = (n) => Math.round(n * 100) / 100;

// Mismo umbral que el barrido de pedidoTimeout.job.js — ver ahí el porqué.
const SIN_INTENTO_MIN = parseInt(process.env.PEDIDO_CREDITO_SIN_INTENTO_MIN || '3');

// ─── Otorga crédito a un cliente (manual o por pedido no entregado) ───
// El journal (creditos_cliente) y el saldo (usuarios.credito_disponible) se
// mueven en la MISMA transacción — si uno falla, el otro no queda huérfano.
const otorgarCredito = async ({ usuarioId, monto, motivo, pedidoId = null, adminId = null }) => {
  const montoNum = round2(parseFloat(monto));
  if (!Number.isFinite(montoNum) || montoNum <= 0) {
    throw new Error('El monto de crédito debe ser mayor a 0.');
  }
  if (!motivo || !motivo.trim()) {
    throw new Error('El motivo es obligatorio (queda en el historial del cliente).');
  }
  return sequelize.transaction(async (t) => {
    const usuario = await Usuario.findByPk(usuarioId, { transaction: t });
    if (!usuario) throw new Error('Cliente no encontrado.');

    await CreditoCliente.create({
      usuario_id: usuarioId, monto: montoNum, motivo: motivo.trim(), pedido_id: pedidoId, otorgado_por: adminId,
    }, { transaction: t });
    await usuario.increment('credito_disponible', { by: montoNum, transaction: t });
    await usuario.reload({ transaction: t });
    return { ok: true, credito_disponible: parseFloat(usuario.credito_disponible) };
  });
};

// ─── Consume crédito al pagar un pedido — SIEMPRE con piso en el saldo
// real, nunca deja el balance negativo aunque haya una carrera entre dos
// pedidos casi simultáneos del mismo cliente.
//
// `transaction` es OBLIGATORIO en la práctica para quien llama desde
// crearPedido: sin ella, si el crédito se descuenta y DESPUÉS falla la
// creación del pedido (numero duplicado, error de DB, lo que sea), el
// cliente pierde ese crédito sin recibir ningún pedido a cambio — bug real
// detectado 2026-07-24. Pasando la misma `transaction` que envuelve el
// Pedido.create(), un rollback deshace ambas cosas juntas. ──────────────
const consumirCredito = async ({ usuarioId, montoSolicitado, transaction = null }) => {
  const solicitado = round2(parseFloat(montoSolicitado) || 0);
  if (solicitado <= 0) return 0;
  const usuario = await Usuario.findByPk(usuarioId, { transaction });
  if (!usuario) return 0;
  const disponible = parseFloat(usuario.credito_disponible || 0);
  const aUsar = Math.min(solicitado, disponible);
  if (aUsar <= 0) return 0;
  // UPDATE condicional: solo descuenta si el saldo en ESE momento sigue
  // alcanzando — evita que dos pedidos concurrentes del mismo cliente
  // consuman más crédito del que realmente tiene.
  const [, meta] = await sequelize.query(
    `UPDATE usuarios SET credito_disponible = credito_disponible - :aUsar
     WHERE id = :usuarioId AND credito_disponible >= :aUsar`,
    { replacements: { aUsar, usuarioId }, transaction }
  );
  const affected = meta?.rowCount ?? meta ?? 0;
  return affected > 0 ? aUsar : 0;
};

// ─── Devuelve crédito consumido (reembolso/aclaración de un pedido) ───
const devolverCredito = async ({ usuarioId, monto, motivo, pedidoId = null }) => {
  const montoNum = round2(parseFloat(monto) || 0);
  if (montoNum <= 0) return;
  await otorgarCredito({ usuarioId, monto: montoNum, motivo: motivo || 'Devolución de crédito por cancelación.', pedidoId });
};

// ─── Libera de inmediato el crédito atrapado de UN cliente en particular ──
// El barrido de pedidoTimeout.job.js corre cada 5 min y ya cubre esto, pero
// eso significa hasta ~8 min de espera (3 min de gracia + hasta 5 min de
// cron) — un cliente que abandonó el cobro con tarjeta y de inmediato
// intenta OTRO pedido lo ve como crédito "desaparecido" durante esa espera
// (bug real 2026-07-25, cuenta 5545074460). Esta función hace lo mismo pero
// de forma SÍNCRONA, scoped a un solo usuario — se llama justo antes de
// calcular cuánto crédito tiene disponible al crear un pedido nuevo, así
// que el crédito atrapado en un pedido abandonado se libera en el acto, sin
// depender de ningún timer.
const liberarCreditoAtrapadoDeUsuario = async (usuarioId) => {
  const Pedido = require('../models/Pedido'); // require tardío: evita ciclo con models/index.js
  const limiteSinIntento = new Date(Date.now() - SIN_INTENTO_MIN * 60 * 1000);

  const pedidos = await Pedido.findAll({
    where: {
      cliente_id: usuarioId,
      estado: 'pendiente',
      metodo_pago: 'tarjeta',
      credito_aplicado: { [Op.gt]: 0 },
      [Op.or]: [
        { pago_estado: 'fallido' },
        { pago_estado: 'pendiente', pago_referencia: null, creado_en: { [Op.lt]: limiteSinIntento } },
      ],
    },
  });

  for (const pedido of pedidos) {
    const motivo = pedido.pago_estado === 'fallido'
      ? 'Pago con tarjeta rechazado por el banco.'
      : `El pago con tarjeta nunca se completó (más de ${SIN_INTENTO_MIN} min).`;
    const [cancelado] = await Pedido.update(
      { estado: 'cancelado', cancelado_en: new Date(), nota_cancelacion: motivo },
      { where: { id: pedido.id, estado: 'pendiente' } }
    );
    if (!cancelado) continue; // ya lo tomó el cron u otra request concurrente
    try {
      await devolverCredito({
        usuarioId: pedido.cliente_id,
        monto: pedido.credito_aplicado,
        motivo: `Devolución de crédito — pedido ${pedido.numero} cancelado (${motivo}), liberado al crear un pedido nuevo.`,
        pedidoId: pedido.id,
      });
    } catch (e) {
      console.error(`[credito] FALLO liberando crédito atrapado de ${pedido.numero} (liberación síncrona):`, e.message);
    }
  }
};

module.exports = { otorgarCredito, consumirCredito, devolverCredito, liberarCreditoAtrapadoDeUsuario };
