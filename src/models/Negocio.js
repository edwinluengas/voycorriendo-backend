const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const { encrypt, decrypt } = require('../utils/crypto');

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
  // ─── Datos basicos (allowNull: true porque el wizard los llena por etapas) ─
  nombre: { type: DataTypes.STRING(150), allowNull: true },
  descripcion: { type: DataTypes.TEXT, allowNull: true },
  categoria: {
    type: DataTypes.STRING(30),
    allowNull: true,
    validate: {
      isIn: {
        args: [[
          'restaurante',
          'tienda_conveniencia',
          'farmacia',
          'papeleria',
          'panaderia',
          'ahivoy store',
          'abarrotes',
          'distribuidora',
          'otro',
        ]],
        msg: 'Categoria invalida',
      },
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
  // ─── Documentos para verificacion ────────────────────────
  foto_local: { type: DataTypes.STRING, allowNull: true },
  comprobante_domicilio: { type: DataTypes.STRING, allowNull: true },
  documento_rfc: { type: DataTypes.STRING, allowNull: true },
  documento_ine_dueno: { type: DataTypes.STRING, allowNull: true },
  // Ubicación
  direccion: { type: DataTypes.STRING(250), allowNull: true },
  colonia: { type: DataTypes.STRING(100), allowNull: true },
  // Ciudad/zona donde opera el negocio.
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
  // ─── Estado de verificacion (nuevo, espejo del repartidor) ─────
  // pendiente   → wizard sin terminar
  // en_revision → ya envio, esperando aprobacion del admin
  // aprobado    → activo y operando
  // rechazado   → admin pidio correcciones
  verificacion_estado: {
    type: DataTypes.ENUM('pendiente', 'en_revision', 'aprobado', 'rechazado'),
    defaultValue: 'pendiente',
  },
  verificacion_nota:    { type: DataTypes.TEXT, allowNull: true },
  enviado_revision_en:  { type: DataTypes.DATE, allowNull: true },
  resolucion_en:        { type: DataTypes.DATE, allowNull: true },
  // ─── Estado operativo (admin lo activa cuando aprueba) ─────
  // 'activo: true' = aprobado y publicado en el feed.
  activo: { type: DataTypes.BOOLEAN, defaultValue: false },
  // El propio dueño puede abrir/cerrar (estilo Go Online del repartidor).
  abierto_ahora: { type: DataTypes.BOOLEAN, defaultValue: false },
  tiempo_entrega_min: { type: DataTypes.INTEGER, defaultValue: 20 },
  tiempo_entrega_max: { type: DataTypes.INTEGER, defaultValue: 40 },
  // Cuenta bancaria — cifrada con AES-256-GCM
  clabe_bancaria: {
    type: DataTypes.TEXT,
    allowNull: true,
    get() { return decrypt(this.getDataValue('clabe_bancaria')); },
    set(val) { this.setDataValue('clabe_bancaria', encrypt(val)); },
  },
  banco: { type: DataTypes.STRING(50), allowNull: true },
  // Comisión (% que se lleva VoyCorriendo)
  comision_porcentaje: { type: DataTypes.DECIMAL(5, 2), defaultValue: 15.00 },
  // Estadísticas
  calificacion_promedio: { type: DataTypes.DECIMAL(3, 2), defaultValue: 0.00 },
  total_pedidos: { type: DataTypes.INTEGER, defaultValue: 0 },
  // ─── Estado operativo de la cuenta (estilo DoorDash/Rappi) ───
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
  // ─── Deuda acumulada con la plataforma (fees en efectivo no liquidados) ─
  deuda_plataforma:  { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  // true cuando deuda_plataforma >= TOPE_DEUDA ($1,000) — bloqueo automático
  bloqueado_por_deuda: { type: DataTypes.BOOLEAN, defaultValue: false },
}, {
  tableName: 'negocios',
  timestamps: true,
  createdAt: 'creado_en',
  updatedAt: 'actualizado_en',
});

module.exports = Negocio;
