const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const DriverPayment = sequelize.define('DriverPayment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  driver_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'repartidores', key: 'id' },
  },
  order_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'pedidos', key: 'id' },
  },
  amount:       { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  tier:         { type: DataTypes.ENUM('daily', 'weekly'), allowNull: false },
  status: {
    type: DataTypes.ENUM('pending', 'paid', 'failed'),
    defaultValue: 'pending',
  },
  scheduled_at: { type: DataTypes.DATE, allowNull: true },
  paid_at:      { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'driver_payments',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = DriverPayment;
