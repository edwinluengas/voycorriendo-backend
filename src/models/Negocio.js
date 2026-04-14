const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Negocio = sequelize.define('Negocio', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  usuario_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'usuarios', key: 'id' },
  },
  nombre: { type: DataTypes.STRING(150), allowNull: false },
  descripcion: { type: DataTypes.TEXT, allowNull: true },
  categoria: {
    type: DataTypes.ENUM('restaurante', 'farmacia', 'abarrotes', 'distribuidora', 'otro'),
    allowNull: false,
  },
  logo: { type: DataTypes.STRING, allowNull: true },
  foto_portada: { type: DataTypes.STRING, allowNull: true },
  // Ubicación
  direccion: { type: DataTypes.STRING(250), allowNull: false },
  colonia: { type: DataTypes.STRING(100), allowNull: true },
  latitud: { type: DataTypes.DECIMAL(10, 8), allowNull: true },
  longitud: { type: DataTypes.DECIMAL(11, 8), allowNull: true },
  // Contacto
  telefono: { type: DataTypes.STRING(15), allowNull: true },
  // Horarios (JSON): {"lun":{"abre":"09:00","cierra":"21:00"}, ...}
  horarios: { type: DataTypes.JSONB, allowNull: true },
  // Estado
  activo: { type: DataTypes.BOOLEAN, defaultValue: false },
  abierto_ahora: { type: DataTypes.BOOLEAN, defaultValue: false },
  tiempo_entrega_min: { type: DataTypes.INTEGER, defaultValue: 20 },  // minutos
  tiempo_entrega_max: { type: DataTypes.INTEGER, defaultValue: 40 },
  // Cuenta bancaria para recibir pagos
  clabe_bancaria: { type: DataTypes.STRING(18), allowNull: true },
  banco: { type: DataTypes.STRING(50), allowNull: true },
  // Comisión (% que se lleva Mandaditos)
  comision_porcentaje: { type: DataTypes.DECIMAL(5, 2), defaultValue: 15.00 },
  // Estadísticas
  calificacion_promedio: { type: DataTypes.DECIMAL(3, 2), defaultValue: 0.00 },
  total_pedidos: { type: DataTypes.INTEGER, defaultValue: 0 },
}, {
  tableName: 'negocios',
  timestamps: true,
  createdAt: 'creado_en',
  updatedAt: 'actualizado_en',
});

module.exports = Negocio;
