const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const PromoConfig = sequelize.define('PromoConfig', {
  clave:        { type: DataTypes.STRING(100), primaryKey: true },
  activo:       { type: DataTypes.BOOLEAN, defaultValue: false },
  fecha_inicio: { type: DataTypes.DATE, allowNull: true },
  fecha_fin:    { type: DataTypes.DATE, allowNull: true },
  descripcion:  { type: DataTypes.TEXT, allowNull: true },
}, {
  tableName:  'promo_config',
  timestamps: true,
  createdAt:  false,
  updatedAt:  'updated_at',
});

module.exports = PromoConfig;
