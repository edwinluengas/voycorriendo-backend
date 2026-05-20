const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const PlatformRevenue = sequelize.define('PlatformRevenue', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  order_id: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true,
    references: { model: 'pedidos', key: 'id' },
  },
  token_value:      { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  client_fee:       { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  driver_payout:    { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  transaction_cost: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  gateway_fee:      { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  net_revenue:      { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  tier:             { type: DataTypes.STRING(10), allowNull: true },
}, {
  tableName: 'platform_revenue',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = PlatformRevenue;
