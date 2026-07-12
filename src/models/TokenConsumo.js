const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const TokenConsumo = sequelize.define('TokenConsumo', {
  id:                  { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  restaurant_token_id: { type: DataTypes.UUID, allowNull: false },
  restaurant_id:       { type: DataTypes.UUID, allowNull: false },
  pedido_id:           { type: DataTypes.UUID, allowNull: false },
  tokens_consumidos:   { type: DataTypes.INTEGER, allowNull: false },
}, {
  tableName:  'token_consumos',
  timestamps: true,
  createdAt:  'created_at',
  updatedAt:  false,
});

module.exports = TokenConsumo;
