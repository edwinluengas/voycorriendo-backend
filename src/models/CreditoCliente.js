const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// Journal de créditos otorgados a clientes — de dónde salió cada peso de
// `usuarios.credito_disponible`. Nunca se borra (auditoría); un ajuste
// posterior se registra como una fila nueva, no editando esta.
const CreditoCliente = sequelize.define('CreditoCliente', {
  id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  usuario_id:  { type: DataTypes.UUID, allowNull: false },
  monto:       { type: DataTypes.DECIMAL(10, 2), allowNull: false }, // siempre positivo (un otorgamiento)
  motivo:      { type: DataTypes.TEXT, allowNull: false },
  // Pedido que originó el crédito (no entregado, se le compensa con
  // crédito en vez de/además del reembolso a tarjeta) — null si fue un
  // otorgamiento manual sin relación a un pedido puntual.
  pedido_id:   { type: DataTypes.UUID, allowNull: true },
  // Admin que lo otorgó — null si en el futuro se automatiza algún camino.
  otorgado_por: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName:  'creditos_cliente',
  timestamps: true,
  createdAt:  'creado_en',
  updatedAt:  false,
});

module.exports = CreditoCliente;
