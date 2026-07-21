const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const TarjetaGuardada = sequelize.define('TarjetaGuardada', {
  id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  usuario_id:     { type: DataTypes.UUID, allowNull: false },
  mp_card_id:     { type: DataTypes.STRING(50), allowNull: false },
  ultimos_4:      { type: DataTypes.STRING(4), allowNull: false },
  marca:          { type: DataTypes.STRING(30), allowNull: true },
  payment_method_id: { type: DataTypes.STRING(30), allowNull: true },
  issuer_id:      { type: DataTypes.STRING(30), allowNull: true },
  exp_mes:        { type: DataTypes.SMALLINT, allowNull: true },
  exp_anio:       { type: DataTypes.SMALLINT, allowNull: true },
  titular:        { type: DataTypes.STRING(100), allowNull: true },
  predeterminada: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
  tableName:  'tarjetas_guardadas',
  timestamps: true,
  createdAt:  'creado_en',
  updatedAt:  'actualizado_en',
});

module.exports = TarjetaGuardada;
