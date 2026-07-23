/**
 * Pedidos perdidos — modelo de liquidación cuenta concentradora (2026-07-23).
 *
 * Reglas (confirmadas por el dueño):
 *   - Pérdida NORMAL:       50% restaurante (deuda_plataforma) / 50% plataforma.
 *   - Pérdida INTENCIONAL:  60% repartidor (saldo_por_cobrar) / 40% plataforma / 0% restaurante.
 *     La intencionalidad la determina UN ADMIN manualmente (endpoint o bot de
 *     Telegram) — nunca una regla automática.
 *   - Repartidor con MÁS de LIMITE_PEDIDOS_PERDIDOS (2) pérdidas ACTIVAS →
 *     bloqueo PERMANENTE (cuenta + vehículo, vía bloqueos_permanentes).
 *   - Aclaración válida → eliminarPerdida(): revierte los cargos con exactitud
 *     y los balances quedan recalculados al instante (los cargos solo viven a
 *     través de la fila de perdidas_pedido).
 *
 * Todo cargo/reverso pasa por aplicarCargos/revertirCargos — no duplicar esa
 * lógica en controllers.
 */
const { Op } = require('sequelize');
const PerdidaPedido = require('../models/PerdidaPedido');
const {
  PCT_PERDIDA_RESTAURANTE,
  PCT_PERDIDA_REP_INTENCIONAL,
  LIMITE_PEDIDOS_PERDIDOS,
} = require('../config/precios');
const tg = require('./telegram.service');

const round2 = (n) => Math.round(n * 100) / 100;

const calcularCargos = (monto, tipo) => {
  const m = parseFloat(monto);
  if (tipo === 'intencional') {
    const rep = round2(m * PCT_PERDIDA_REP_INTENCIONAL);
    return { cargo_restaurante: 0, cargo_repartidor: rep, cargo_plataforma: round2(m - rep) };
  }
  const rest = round2(m * PCT_PERDIDA_RESTAURANTE);
  return { cargo_restaurante: rest, cargo_repartidor: 0, cargo_plataforma: round2(m - rest) };
};

// Aplica (signo +1) o revierte (signo -1) los cargos de una pérdida sobre
// los balances reales. El reverso del repartidor devuelve al fondo
// disponible lo que ya se hubiera recuperado vía neteo de retiros.
const aplicarCargos = async (perdida, signo = 1) => {
  const { Negocio, FondoRepartidor } = require('../models');
  const rest = parseFloat(perdida.cargo_restaurante || 0);
  const rep  = parseFloat(perdida.cargo_repartidor || 0);

  if (rest > 0 && perdida.negocio_id) {
    const negocio = await Negocio.findByPk(perdida.negocio_id);
    if (negocio) {
      if (signo > 0) {
        await negocio.increment({ deuda_plataforma: rest });
      } else {
        // Reverso con piso en 0 — si ya se liquidó por SPEI entre medio, el
        // faltante se reporta a admin en vez de dejar deuda negativa.
        const actual = parseFloat(negocio.deuda_plataforma || 0);
        const reduccion = Math.min(actual, rest);
        if (reduccion > 0) await negocio.increment({ deuda_plataforma: -reduccion });
        if (reduccion < rest) {
          tg.enviarAdmin(`⚠️ Aclaración de pérdida: al negocio ${negocio.nombre} se le habían cobrado $${rest.toFixed(2)} pero su deuda actual solo permitió revertir $${reduccion.toFixed(2)} (probablemente ya liquidó por SPEI). Compensar $${round2(rest - reduccion).toFixed(2)} manualmente.`).catch(() => {});
        }
      }
    }
  }

  if (rep > 0 && perdida.repartidor_id) {
    const [fondo] = await FondoRepartidor.findOrCreate({
      where: { repartidor_id: perdida.repartidor_id },
      defaults: {},
    });
    if (signo > 0) {
      await fondo.increment('saldo_por_cobrar', { by: rep });
    } else {
      await fondo.reload();
      const saldo = parseFloat(fondo.saldo_por_cobrar || 0);
      const reduccion = Math.min(saldo, rep);
      const yaRecuperado = round2(rep - reduccion);
      // Lo aún no recuperado se quita de la deuda; lo que ya se le había
      // descontado en retiros se le devuelve como saldo disponible.
      await fondo.increment({
        saldo_por_cobrar: -reduccion,
        ...(yaRecuperado > 0 ? { monto_disponible: yaRecuperado } : {}),
      });
    }
  }
};

const contarPerdidasActivas = (repartidorId) =>
  PerdidaPedido.count({ where: { repartidor_id: repartidorId, estado: 'activa' } });

// Bloqueo permanente al superar el límite (>2 = al tercero).
const verificarBloqueoPorPerdidas = async (repartidorId) => {
  if (!repartidorId) return;
  const total = await contarPerdidasActivas(repartidorId);
  if (total <= LIMITE_PEDIDOS_PERDIDOS) return;
  const { Repartidor } = require('../models');
  const { bloquearRepartidorPermanente } = require('./seguridadCuentas.service');
  const r = await Repartidor.findByPk(repartidorId);
  if (!r || r.estado_cuenta === 'bloqueado') return;
  r.conectado = false;
  r.disponible = false;
  await bloquearRepartidorPermanente(r, `Acumuló ${total} pedidos perdidos (límite: ${LIMITE_PEDIDOS_PERDIDOS}).`);
  tg.enviarAdmin(`🚫 Repartidor ${repartidorId} bloqueado PERMANENTEMENTE (cuenta + vehículo) por acumular ${total} pedidos perdidos.`).catch(() => {});
};

// Registra la pérdida de un pedido (idempotente por pedido_id) y aplica los
// cargos del tipo 'normal'. La reclasificación a 'intencional' es decisión
// posterior de un admin.
const registrarPerdida = async ({ pedido, nota }) => {
  const monto = pedido.metodo_pago === 'efectivo'
    ? parseFloat(pedido.subtotal || 0)   // efectivo: se pierde la comida (nunca se cobró)
    : parseFloat(pedido.total || 0);     // digital: se reembolsó el total al cliente
  if (monto <= 0) return null;

  const cargos = calcularCargos(monto, 'normal');
  const [perdida, creada] = await PerdidaPedido.findOrCreate({
    where: { pedido_id: pedido.id },
    defaults: {
      negocio_id: pedido.negocio_id || null,
      repartidor_id: pedido.repartidor_id || null,
      monto, tipo: 'normal', estado: 'activa', nota: nota || null,
      ...cargos,
    },
  });
  if (!creada) return perdida; // ya registrada (reintento/carrera) — no duplicar cargos

  await aplicarCargos(perdida, +1);
  await verificarBloqueoPorPerdidas(perdida.repartidor_id);
  tg.enviarAdmin(
    `📉 <b>Pedido perdido</b> ${pedido.numero} — $${monto.toFixed(2)}\n` +
    `Reparto (normal): restaurante $${cargos.cargo_restaurante.toFixed(2)} | plataforma $${cargos.cargo_plataforma.toFixed(2)}\n` +
    (perdida.repartidor_id ? `Repartidor asignado: si un admin determina pérdida INTENCIONAL, reclasificar (60% a su cargo).\n` : '') +
    `Aclaraciones: eliminar la pérdida revierte los cargos automáticamente.`
  ).catch(() => {});
  return perdida;
};

// Cambia normal ↔ intencional: revierte los cargos anteriores y aplica los
// nuevos. Solo sobre pérdidas activas.
const reclasificarPerdida = async (perdida, tipoNuevo) => {
  if (perdida.estado !== 'activa') throw new Error('La pérdida ya fue eliminada.');
  if (perdida.tipo === tipoNuevo) return perdida;
  if (tipoNuevo === 'intencional' && !perdida.repartidor_id) {
    throw new Error('No se puede marcar intencional: el pedido no tenía repartidor asignado.');
  }
  await aplicarCargos(perdida, -1);
  const cargos = calcularCargos(perdida.monto, tipoNuevo);
  await perdida.update({ tipo: tipoNuevo, ...cargos });
  await aplicarCargos(perdida, +1);
  await verificarBloqueoPorPerdidas(perdida.repartidor_id);
  return perdida;
};

// Aclaración válida: revierte los cargos y marca la fila eliminada. Los
// balances quedan recalculados al instante porque los cargos solo existen a
// través de esta fila.
const eliminarPerdida = async (perdida, nota) => {
  if (perdida.estado !== 'activa') return perdida;
  await aplicarCargos(perdida, -1);
  await perdida.update({ estado: 'eliminada', nota: nota || perdida.nota });
  return perdida;
};

module.exports = {
  registrarPerdida,
  reclasificarPerdida,
  eliminarPerdida,
  contarPerdidasActivas,
  calcularCargos,
};
