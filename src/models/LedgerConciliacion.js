const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const LedgerConciliacion = sequelize.define('LedgerConciliacion', {
  id:                  { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  pedido_id:           { type: DataTypes.UUID, allowNull: false, unique: true },
  fee_envio_cobrado:   { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  subtotal_productos:  { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  pago_repartidor:     { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  comision_plataforma: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  metodo_pago:         { type: DataTypes.STRING(50), allowNull: false },
  tipo_envio:          { type: DataTypes.STRING(20), allowNull: false },
  liquidacion_comida:  { type: DataTypes.STRING(50), allowNull: true },
  distancia_km:        { type: DataTypes.DECIMAL(6, 2), allowNull: true },
}, {
  tableName:  'ledger_conciliacion',
  timestamps: true,
  createdAt:  'registrado_en',
  updatedAt:  false,
});

module.exports = LedgerConciliacion;
