const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const TokenTier = sequelize.define('TokenTier', {
  id:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  nombre:          { type: DataTypes.STRING(50), allowNull: false, unique: true },
  label:           { type: DataTypes.STRING(50), allowNull: false },
  tokens:          { type: DataTypes.INTEGER, allowNull: false },
  precio:          { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  vigencia_dias:   { type: DataTypes.INTEGER, allowNull: false },
  costo_por_token: { type: DataTypes.DECIMAL(10, 4), allowNull: false },
  activo:          { type: DataTypes.BOOLEAN, defaultValue: true },
  orden:           { type: DataTypes.INTEGER, defaultValue: 0 },
}, {
  tableName:  'token_tiers',
  timestamps: true,
  createdAt:  'created_at',
  updatedAt:  'updated_at',
});

module.exports = TokenTier;
