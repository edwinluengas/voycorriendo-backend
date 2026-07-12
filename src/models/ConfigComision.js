const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const ConfigComision = sequelize.define('ConfigComision', {
  id:                   { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  metodo_pago:          { type: DataTypes.STRING(50), allowNull: false },
  tipo_envio:           { type: DataTypes.STRING(20), allowNull: false },
  comision_plataforma:  { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  pago_repartidor:      { type: DataTypes.DECIMAL(10, 2), allowNull: false },
}, {
  tableName:  'config_comisiones',
  timestamps: false,
  indexes: [{ unique: true, fields: ['metodo_pago', 'tipo_envio'] }],
});

module.exports = ConfigComision;
