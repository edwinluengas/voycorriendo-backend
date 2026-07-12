const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const ConfigZona = sequelize.define('ConfigZona', {
  id:                  { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tipo_envio:          { type: DataTypes.STRING(20), allowNull: false, unique: true },
  max_km:              { type: DataTypes.DECIMAL(5, 2), allowNull: false },
  fee_base:            { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  surcharge_inicio_km: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
  surcharge_por_km:    { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  activo:              { type: DataTypes.BOOLEAN, defaultValue: true },
}, {
  tableName:  'config_zonas',
  timestamps: false,
});

module.exports = ConfigZona;
