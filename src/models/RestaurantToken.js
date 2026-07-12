const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const RestaurantToken = sequelize.define('RestaurantToken', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  restaurant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'negocios', key: 'id' },
  },
  tokens_remaining:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  pack_type:         { type: DataTypes.STRING(20), allowNull: false },
  expires_at:        { type: DataTypes.DATE, allowNull: false },
  precio_pagado:     { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  tokens_comprados:  { type: DataTypes.INTEGER, allowNull: true },
}, {
  tableName:  'restaurant_tokens',
  timestamps: true,
  createdAt:  'created_at',
  updatedAt:  'updated_at',
});

module.exports = RestaurantToken;
