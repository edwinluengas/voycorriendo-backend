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
  // Dos banderas INDEPENDIENTES: el corte al negocio (subtotal - $35) y el
  // depósito al repartidor (pago_repartidor) se liquidan en momentos
  // distintos y por caminos distintos (negocio: retiro diario o corte
  // semanal admin; repartidor: retiro diario o depósito semanal). Antes
  // compartían una sola columna `conciliado`, así que quien se pagara
  // primero marcaba la fila como liquidada y el otro perdía su parte de
  // ese pedido para siempre (nunca volvía a aparecer como pendiente).
  conciliado_negocio:      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  conciliado_negocio_en:   { type: DataTypes.DATE, allowNull: true },
  conciliado_repartidor:   { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  conciliado_repartidor_en: { type: DataTypes.DATE, allowNull: true },
  // "Reserva" temporal: id de la Liquidacion pendiente que ya reclamó esta
  // fila (evita que dos solicitudes de retiro simultáneas cobren el mismo
  // pedido dos veces). Se limpia solo al confirmar o nunca se reintenta si
  // queda huérfana — un admin puede liberar manualmente si hace falta.
  liquidacion_negocio_id:    { type: DataTypes.UUID, allowNull: true },
  liquidacion_repartidor_id: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName:  'ledger_conciliacion',
  timestamps: true,
  createdAt:  'registrado_en',
  updatedAt:  false,
});

module.exports = LedgerConciliacion;
