/**
 * Crédito de plataforma para clientes (2026-07-24).
 *
 * Uso: (1) un admin le otorga crédito libre a un cliente por cualquier
 * motivo, o (2) como compensación por un pedido no entregado — usable
 * después en CUALQUIER tienda al pagar. Nunca tocar `usuario.credito_disponible`
 * directo desde un controller: siempre por aquí, para que quede el
 * journal en `creditos_cliente` (por qué tiene este cliente ese saldo).
 */
const CreditoCliente = require('../models/CreditoCliente');
const Usuario = require('../models/Usuario');
const { sequelize } = require('../config/database');

const round2 = (n) => Math.round(n * 100) / 100;

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

module.exports = { otorgarCredito, consumirCredito, devolverCredito };
