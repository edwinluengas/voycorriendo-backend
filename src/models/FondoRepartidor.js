const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const FondoRepartidor = sequelize.define('FondoRepartidor', {
  id:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  repartidor_id:    { type: DataTypes.UUID, allowNull: false, unique: true },
  monto_disponible: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  monto_reservado:  { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  total_pagado_historico: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  monto_pendiente_confirmar: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  // Existía como columna en la DB (migración en server.js) pero NUNCA se
  // declaró aquí en el modelo — Sequelize ignora en silencio cualquier
  // atributo que no esté definido al hacer .update(), así que
  // retiro_pendiente jamás se persistía de verdad: el candado anti
  // doble-retiro (solicitarDeposito/retiroDiario) nunca funcionó.
  retiro_pendiente: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  // Deuda del repartidor con la plataforma: se carga cuando un pedido que él
  // tenía asignado se cancela sin entregarse y hubo que reembolsar al cliente.
  // Se netea contra sus ganancias en solicitarDeposito/retiroDiario.
  saldo_por_cobrar: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
}, {
  tableName:  'fondo_repartidor',
  timestamps: true,
  createdAt:  'created_at',
  updatedAt:  'updated_at',
});

module.exports = FondoRepartidor;
