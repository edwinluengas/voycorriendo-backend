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
    type: DataTypes.STRING(30),
    allowNull: false,
    validate: {
      isIn: [[
        'restaurante',
        'tienda_conveniencia',
        'farmacia',
        'papeleria',
        'panaderia',
        'ahivoy store',
        'distribuidora',
        'otro',
      ]],
    },
  },
  // Negocio destacado en el carrusel principal
  destacado: { type: DataTypes.BOOLEAN, defaultValue: false },
  // 'local' = entrega en moto; 'paqueteria' = envío desde CDMX
  tipo_entrega: {
    type: DataTypes.STRING(20),
    defaultValue: 'local',
    validate: { isIn: [['local', 'paqueteria']] },
  },
  logo: { type: DataTypes.STRING, allowNull: true },
  foto_portada: { type: DataTypes.STRING, allowNull: true },
  // Ubicación
  direccion: { type: DataTypes.STRING(250), allowNull: false },
  colonia: { type: DataTypes.STRING(100), allowNull: true },
  // Ciudad/zona donde opera el negocio. Slug en minusculas y guion bajo.
  // Ejemplos: 'puerto_escondido', 'huatulco', 'oaxaca_centro', 'salina_cruz'.
  // Permite que la app filtre lo que ve cada cliente segun su ubicacion.
  ciudad: {
    type: DataTypes.STRING(50),
    allowNull: false,
    defaultValue: 'puerto_escondido',
  },
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
  // Comisión (% que se lleva VoyCorriendo)
  comision_porcentaje: { type: DataTypes.DECIMAL(5, 2), defaultValue: 15.00 },
  // Estadísticas
  calificacion_promedio: { type: DataTypes.DECIMAL(3, 2), defaultValue: 0.00 },
  total_pedidos: { type: DataTypes.INTEGER, defaultValue: 0 },
  // ─── Estado operativo de la cuenta (estilo DoorDash/Rappi) ───
  // 'normal'      → aparece en el feed normalmente
  // 'observacion' → aparece pero el panel del negocio le muestra mensajes de coaching
  // 'probation'   → aparece al final del feed, ranking degradado
  // 'suspendido'  → no aparece en el feed, no recibe pedidos
  // 'bloqueado'   → cuenta cerrada permanentemente
  estado_cuenta: {
    type: DataTypes.ENUM('normal', 'observacion', 'probation', 'suspendido', 'bloqueado'),
    defaultValue: 'normal',
  },
  estado_motivo: { type: DataTypes.TEXT, allowNull: true },
  // ─── Metricas para el sistema de reputacion ─────────────────
  tasa_cancelacion: { type: DataTypes.DECIMAL(5, 2), defaultValue: 0.00 },
  tiempo_prep_promedio_min: { type: DataTypes.INTEGER, defaultValue: 0 },
  quejas_30d: { type: DataTypes.INTEGER, defaultValue: 0 },
  // Badge "Top" / "Mas pedido" que se muestra en el feed (estilo DoorDash)
  destacado_calidad: { type: DataTypes.BOOLEAN, defaultValue: false },
}, {
  tableName: 'negocios',
  timestamps: true,
  createdAt: 'creado_en',
  updatedAt: 'actualizado_en',
});

module.exports = Negocio;
