const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const FondoRepartidor = sequelize.define('FondoRepartidor', {
  id:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  repartidor_id:    { type: DataTypes.UUID, allowNull: false, unique: true },
  monto_disponible: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  monto_reservado:  { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
}, {
  tableName:  'fondo_repartidor',
  timestamps: true,
  createdAt:  'created_at',
  updatedAt:  'updated_at',
});

module.exports = FondoRepartidor;
