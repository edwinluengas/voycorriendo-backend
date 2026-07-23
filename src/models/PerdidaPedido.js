const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// Registro de un pedido perdido/no entregado y cómo se distribuyó la
// pérdida. Es el JOURNAL del modelo de liquidación: los cargos aplicados a
// negocio (deuda_plataforma) y repartidor (saldo_por_cobrar) siempre nacen
// y mueren a través de una fila de esta tabla, para que una aclaración
// válida (estado='eliminada') pueda revertirlos con exactitud.
const PerdidaPedido = sequelize.define('PerdidaPedido', {
  id:            { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  pedido_id:     { type: DataTypes.UUID, allowNull: false, unique: true },
  negocio_id:    { type: DataTypes.UUID, allowNull: true },
  repartidor_id: { type: DataTypes.UUID, allowNull: true }, // null si nunca hubo asignado
  monto:         { type: DataTypes.DECIMAL(10, 2), allowNull: false }, // valor perdido
  tipo: {
    type: DataTypes.ENUM('normal', 'intencional'),
    allowNull: false, defaultValue: 'normal',
  },
  estado: {
    type: DataTypes.ENUM('activa', 'eliminada'),
    allowNull: false, defaultValue: 'activa',
  },
  cargo_restaurante: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  cargo_repartidor:  { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  cargo_plataforma:  { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  nota:              { type: DataTypes.TEXT, allowNull: true },
}, {
  tableName:  'perdidas_pedido',
  timestamps: true,
  createdAt:  'creado_en',
  updatedAt:  'actualizado_en',
});

module.exports = PerdidaPedido;
