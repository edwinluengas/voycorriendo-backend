const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Producto = sequelize.define('Producto', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  negocio_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'negocios', key: 'id' },
  },
  nombre: {
    type: DataTypes.STRING(150),
    allowNull: false,
  },
  descripcion: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  precio: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    validate: { min: 0 },
  },
  categoria: {
    type: DataTypes.STRING(80),
    allowNull: true,   // "Tacos", "Bebidas", "Medicamentos", etc.
  },
  imagen: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  disponible: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  destacado: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  tiempo_preparacion: {
    type: DataTypes.INTEGER,
    defaultValue: 10,   // minutos
  },
  // Opciones / modificadores (JSON)
  // [{ nombre: "Sin cebolla", extra_precio: 0 }, { nombre: "Con queso", extra_precio: 10 }]
  opciones: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
}, {
  tableName: 'productos',
  timestamps: true,
  createdAt: 'creado_en',
  updatedAt: 'actualizado_en',
});

module.exports = Producto;
