const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// Lista negra permanente — cubre tanto placas de repartidor como
// direcciones de negocio. Un repartidor/negocio dado de baja por
// incumplir reglas (fraude de cuentas duplicadas, calificación
// reprobatoria, etc.) no puede volver a registrar la misma placa o
// dirección en NINGUNA cuenta, nueva o existente. Solo un admin puede
// reactivar manualmente (elimina la fila).
const BloqueoPermanente = sequelize.define('BloqueoPermanente', {
  id:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tipo:            { type: DataTypes.ENUM('placa_repartidor', 'direccion_negocio'), allowNull: false },
  valor:           { type: DataTypes.STRING(255), allowNull: false }, // normalizado (trim + mayúsculas)
  motivo:          { type: DataTypes.STRING(255), allowNull: false },
  entidad_id_origen: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName:  'bloqueos_permanentes',
  timestamps: true,
  createdAt:  'bloqueado_en',
  updatedAt:  false,
  indexes: [{ unique: true, fields: ['tipo', 'valor'] }],
});

module.exports = BloqueoPermanente;
