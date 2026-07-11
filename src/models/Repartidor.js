const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const { encrypt, decrypt } = require('../utils/crypto');

const Repartidor = sequelize.define('Repartidor', {
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
  // Documentos
  foto_ine_frente: { type: DataTypes.STRING, allowNull: true },
  foto_ine_reverso: { type: DataTypes.STRING, allowNull: true },
  foto_licencia: { type: DataTypes.STRING, allowNull: true },
  foto_tarjeta_circulacion: { type: DataTypes.STRING, allowNull: true },
  // Vehículo
  tipo_vehiculo: {
    type: DataTypes.ENUM('motocicleta', 'bicicleta'),
    defaultValue: 'motocicleta',
  },
  marca_vehiculo: { type: DataTypes.STRING(50), allowNull: true },
  modelo_vehiculo: { type: DataTypes.STRING(50), allowNull: true },
  anio_vehiculo: { type: DataTypes.INTEGER, allowNull: true },
  placa_vehiculo: { type: DataTypes.STRING(10), allowNull: true },
  color_vehiculo: { type: DataTypes.STRING(30), allowNull: true },
  // Cuenta bancaria (para recibir pagos) — cifrada con AES-256-GCM
  clabe_bancaria: {
    type: DataTypes.TEXT,
    allowNull: true,
    get() { return decrypt(this.getDataValue('clabe_bancaria')); },
    set(val) { this.setDataValue('clabe_bancaria', encrypt(val)); },
  },
  banco: { type: DataTypes.STRING(50), allowNull: true },
  // Estado de verificación inicial (al subir documentos)
  verificacion_estado: {
    type: DataTypes.ENUM('pendiente', 'en_revision', 'aprobado', 'rechazado'),
    defaultValue: 'pendiente',
  },
  verificacion_nota:   { type: DataTypes.TEXT, allowNull: true },
  enviado_revision_en: { type: DataTypes.DATE, allowNull: true },
  resolucion_en:       { type: DataTypes.DATE, allowNull: true },
  antecedentes_ok: { type: DataTypes.BOOLEAN, defaultValue: false },
  // ─── Estado operativo de la cuenta (estilo Uber) ────────────
  // 'normal'      → recibe pedidos sin restriccion
  // 'observacion' → recibe pedidos pero ve mensajes de coaching
  // 'probation'   → algoritmo lo prioriza menos (asignacion al final)
  // 'suspendido'  → no recibe pedidos hasta hablar con soporte
  // 'bloqueado'   → cuenta cerrada permanentemente
  estado_cuenta: {
    type: DataTypes.ENUM('normal', 'observacion', 'probation', 'suspendido', 'bloqueado'),
    defaultValue: 'normal',
  },
  estado_motivo: { type: DataTypes.TEXT, allowNull: true },
  // ─── Metricas para el sistema de reputacion ─────────────────
  tasa_cancelacion: { type: DataTypes.DECIMAL(5, 2), defaultValue: 0.00 },
  tasa_aceptacion: { type: DataTypes.DECIMAL(5, 2), defaultValue: 100.00 },
  quejas_30d: { type: DataTypes.INTEGER, defaultValue: 0 },
  // Conectado en este momento (estilo Uber "Go Online" / Rappi "Conectarme")
  // Independiente de 'disponible' (que indica que esta esperando pedido).
  conectado: { type: DataTypes.BOOLEAN, defaultValue: false },
  conectado_desde: { type: DataTypes.DATE, allowNull: true },
  // Ciudad/zona donde opera el repartidor. Mismo slug que en Negocio.
  // Por ahora todos quedan en 'puerto_escondido'; al expandirnos a otra ciudad
  // crearemos repartidores con su slug correspondiente.
  ciudad: {
    type: DataTypes.STRING(50),
    allowNull: false,
    defaultValue: 'puerto_escondido',
  },
  tier: {
    type: DataTypes.ENUM('daily', 'weekly'),
    defaultValue: 'weekly',
  },
  max_pedidos_ruta: { type: DataTypes.INTEGER, defaultValue: 3 },
  // Disponibilidad actual
  disponible: { type: DataTypes.BOOLEAN, defaultValue: false },
  latitud: { type: DataTypes.DECIMAL(10, 8), allowNull: true },
  longitud: { type: DataTypes.DECIMAL(11, 8), allowNull: true },
  // Estadísticas
  calificacion_promedio: {
    type: DataTypes.DECIMAL(3, 2),
    defaultValue: 0.00,
  },
  total_entregas: { type: DataTypes.INTEGER, defaultValue: 0 },
  ganancias_totales: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0.00 },
}, {
  tableName: 'repartidores',
  timestamps: true,
  createdAt: 'creado_en',
  updatedAt: 'actualizado_en',
});

module.exports = Repartidor;
