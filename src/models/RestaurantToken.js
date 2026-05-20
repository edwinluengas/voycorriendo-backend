const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const PACK_TOKENS  = { starter: 50,  pro: 200, elite: 500 };
const PACK_PRICES  = { starter: 1050, pro: 4000, elite: 9500 };
const PACK_EXPIRY  = { starter: 60,  pro: 90,  elite: 120 }; // días

const RestaurantToken = sequelize.define('RestaurantToken', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  restaurant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'negocios', key: 'id' },
  },
  tokens_remaining: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  pack_type: {
    type: DataTypes.ENUM('starter', 'pro', 'elite'),
    allowNull: false,
  },
  expires_at: { type: DataTypes.DATE, allowNull: false },
}, {
  tableName: 'restaurant_tokens',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

RestaurantToken.PACK_TOKENS = PACK_TOKENS;
RestaurantToken.PACK_PRICES = PACK_PRICES;
RestaurantToken.PACK_EXPIRY = PACK_EXPIRY;

module.exports = RestaurantToken;
