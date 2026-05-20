const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const DeliveryBatch = sequelize.define('DeliveryBatch', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  driver_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'repartidores', key: 'id' },
  },
  route_data:   { type: DataTypes.JSONB, allowNull: true },
  waypoints:    { type: DataTypes.JSONB, allowNull: true },
  status: {
    type: DataTypes.ENUM('active', 'completed', 'cancelled'),
    defaultValue: 'active',
  },
  max_orders:   { type: DataTypes.INTEGER, defaultValue: 3 },
  completed_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'delivery_batches',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = DeliveryBatch;
