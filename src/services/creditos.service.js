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

const round2 = (n) => Math.round(n * 100) / 100;

// ─── Otorga crédito a un cliente (manual o por pedido no entregado) ───
const otorgarCredito = async ({ usuarioId, monto, motivo, pedidoId = null, adminId = null }) => {
  const montoNum = round2(parseFloat(monto));
  if (!Number.isFinite(montoNum) || montoNum <= 0) {
    throw new Error('El monto de crédito debe ser mayor a 0.');
  }
  if (!motivo || !motivo.trim()) {
    throw new Error('El motivo es obligatorio (queda en el historial del cliente).');
  }
  const usuario = await Usuario.findByPk(usuarioId);
  if (!usuario) throw new Error('Cliente no encontrado.');

  await CreditoCliente.create({
    usuario_id: usuarioId, monto: montoNum, motivo: motivo.trim(), pedido_id: pedidoId, otorgado_por: adminId,
  });
  await usuario.increment('credito_disponible', { by: montoNum });
  await usuario.reload();
  return { ok: true, credito_disponible: parseFloat(usuario.credito_disponible) };
};

// ─── Consume crédito al pagar un pedido — SIEMPRE con piso en el saldo
// real, nunca deja el balance negativo aunque haya una carrera entre dos
// pedidos casi simultáneos del mismo cliente. ───────────────────────────
const consumirCredito = async ({ usuarioId, montoSolicitado }) => {
  const solicitado = round2(parseFloat(montoSolicitado) || 0);
  if (solicitado <= 0) return 0;
  const usuario = await Usuario.findByPk(usuarioId);
  if (!usuario) return 0;
  const disponible = parseFloat(usuario.credito_disponible || 0);
  const aUsar = Math.min(solicitado, disponible);
  if (aUsar <= 0) return 0;
  // UPDATE condicional: solo descuenta si el saldo en ESE momento sigue
  // alcanzando — evita que dos pedidos concurrentes del mismo cliente
  // consuman más crédito del que realmente tiene.
  const { sequelize } = require('../config/database');
  const [affected] = await sequelize.query(
    `UPDATE usuarios SET credito_disponible = credito_disponible - :aUsar
     WHERE id = :usuarioId AND credito_disponible >= :aUsar`,
    { replacements: { aUsar, usuarioId } }
  );
  return affected > 0 ? aUsar : 0;
};

// ─── Devuelve crédito consumido (reembolso/aclaración de un pedido) ───
const devolverCredito = async ({ usuarioId, monto, motivo, pedidoId = null }) => {
  const montoNum = round2(parseFloat(monto) || 0);
  if (montoNum <= 0) return;
  await otorgarCredito({ usuarioId, monto: montoNum, motivo: motivo || 'Devolución de crédito por cancelación.', pedidoId });
};

module.exports = { otorgarCredito, consumirCredito, devolverCredito };
