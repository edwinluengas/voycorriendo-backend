const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// ─── Registro de liquidación (depósito) de pedidos con tarjeta ────────────
// Un pago real, a un negocio O a un repartidor (entidad_tipo/entidad_id).
// Guarda cuánto se DEBÍA (monto_calculado, calculado del ledger al momento
// de solicitar/ejecutar el corte) y cuánto se DEPOSITÓ realmente
// (monto_depositado, confirmado por un admin con la referencia SPEI real) —
// así queda registro tanto de la cuenta por pagar como del pago que la
// canceló, y cualquier diferencia entre ambos montos queda visible en vez
// de perderse. Los pedidos que cubre (ledger_ids) quedan "reservados" en
// LedgerConciliacion (liquidacion_negocio_id / liquidacion_repartidor_id)
// desde que se crea en estado 'pendiente', para que no se puedan reclamar
// dos veces en una segunda solicitud simultánea — pero solo se marcan
// conciliado_negocio/conciliado_repartidor = true cuando un admin CONFIRMA
// el depósito real, nunca al solo solicitarlo.
const Liquidacion = sequelize.define('Liquidacion', {
  id:                 { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  entidad_tipo:       { type: DataTypes.ENUM('negocio', 'repartidor'), allowNull: false },
  entidad_id:         { type: DataTypes.UUID, allowNull: false },
  tipo:               { type: DataTypes.ENUM('retiro_diario', 'corte_semanal'), allowNull: false },
  estado:             { type: DataTypes.ENUM('pendiente', 'confirmado'), allowNull: false, defaultValue: 'pendiente' },
  monto_calculado:    { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  monto_depositado:   { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  diferencia:         { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  referencia_spei:    { type: DataTypes.STRING(100), allowNull: true },
  pedidos_liquidados: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  ledger_ids:         { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  admin_id:           { type: DataTypes.UUID, allowNull: true },
  confirmado_en:      { type: DataTypes.DATE, allowNull: true },
}, {
  tableName:  'liquidaciones',
  timestamps: true,
  createdAt:  'creado_en',
  updatedAt:  false,
});

module.exports = Liquidacion;
