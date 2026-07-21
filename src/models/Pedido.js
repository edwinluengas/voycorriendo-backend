const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Pedido = sequelize.define('Pedido', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  numero: {
    type: DataTypes.STRING(12),
    unique: true,
    allowNull: false,
    // Ej: MND-004823
  },
  cliente_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'usuarios', key: 'id' },
  },
  negocio_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'negocios', key: 'id' },
  },
  repartidor_id: {
    type: DataTypes.UUID,
    allowNull: true,  // null hasta que se asigne
    references: { model: 'repartidores', key: 'id' },
  },
  // Items del pedido (JSON array)
  // [{ producto_id, nombre, precio, cantidad, notas }]
  items: { type: DataTypes.JSONB, allowNull: false },
  // Totales
  subtotal: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  costo_envio: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  descuento: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  // Modelo económico (tipo Rappi)
  distancia_km:     { type: DataTypes.DECIMAL(6, 2), allowNull: true },   // 0-99.99 km
  zona:             { type: DataTypes.STRING(1),    allowNull: true },   // 'A'|'B'|'C'
  pago_repartidor:  { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 }, // MXN que le pagamos al repa
  comision_negocio: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 }, // MXN que retiene la app al negocio
  ganancia_app:     { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 }, // comisión + (envío - pago repa)
  // Pago
  metodo_pago: {
    type: DataTypes.ENUM('efectivo', 'tarjeta', 'transferencia', 'mercado_pago'),
    allowNull: false,
  },
  pago_estado: {
    type: DataTypes.ENUM('pendiente', 'autorizado', 'capturado', 'fallido', 'reembolsado'),
    defaultValue: 'pendiente',
  },
  pago_referencia: { type: DataTypes.STRING, allowNull: true },
  // Lock atómico contra doble-tap / reintento de red al pagar con tarjeta —
  // ver pagosController.pagarConTarjeta. Se libera siempre en el finally.
  pago_en_proceso: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  // Snapshot inmutable de quién entregó (foto + placa + nombre) tomado al
  // aceptar el pedido — se conserva aunque el repartidor luego cambie su
  // foto de perfil o su vehículo. Trazabilidad de seguridad por pedido.
  repartidor_foto_snapshot:   { type: DataTypes.TEXT, allowNull: true },
  repartidor_placa_snapshot:  { type: DataTypes.STRING(10), allowNull: true },
  repartidor_nombre_snapshot: { type: DataTypes.STRING(100), allowNull: true },
  // Cambio para efectivo: cuánto entregó el cliente
  paga_con: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  // Límite efectivo: aplica al subtotal de productos; el fee de envío se suma encima
  excede_limite_efectivo: {
    type: DataTypes.VIRTUAL,
    get() {
      return this.metodo_pago === 'efectivo' && parseFloat(this.subtotal) > 500;
    },
  },
  // Estado del pedido
  estado: {
    type: DataTypes.ENUM(
      'pendiente',        // recién creado, esperando confirmación negocio
      'confirmado',       // negocio confirmó
      'preparando',       // negocio está preparando
      'listo',            // listo para recoger / enviar
      'en_camino',        // repartidor local lo recogió
      'en_envio',         // paquetería: negocio lo mandó por mensajería
      'entregado',        // entregado al cliente
      'cancelado',        // cancelado
      'rechazado'         // rechazado por negocio
    ),
    defaultValue: 'pendiente',
  },
  // Código de 4 dígitos que el cliente muestra al repartidor para confirmar entrega
  codigo_entrega: { type: DataTypes.STRING(6), allowNull: true },
  // Foto de confirmación de entrega (URL Supabase Storage)
  foto_entrega: { type: DataTypes.TEXT, allowNull: true },
  // Número de guía para pedidos de paquetería
  numero_guia: { type: DataTypes.STRING(100), allowNull: true },
  // Dirección de entrega
  direccion_entrega: { type: DataTypes.STRING(250), allowNull: false },
  latitud_entrega: { type: DataTypes.DECIMAL(10, 8), allowNull: true },
  longitud_entrega: { type: DataTypes.DECIMAL(11, 8), allowNull: true },
  notas_entrega: { type: DataTypes.TEXT, allowNull: true },
  // Foto del INE del cliente (si algún producto requiere verificación de edad).
  // TEXT porque guardamos data URI base64 temporalmente; cuando movamos a S3/Cloudinary
  // será una URL corta.
  ine_foto_url: { type: DataTypes.TEXT, allowNull: true },
  // Tiempos
  confirmado_en: { type: DataTypes.DATE, allowNull: true },
  asignado_en:   { type: DataTypes.DATE, allowNull: true },
  recogido_en:   { type: DataTypes.DATE, allowNull: true },
  enviado_en:    { type: DataTypes.DATE, allowNull: true },
  entregado_en:  { type: DataTypes.DATE, allowNull: true },
  cancelado_en:  { type: DataTypes.DATE, allowNull: true },
  nota_cancelacion: { type: DataTypes.STRING(255), allowNull: true },
  // Calificaciones
  calificacion_repartidor: { type: DataTypes.INTEGER, allowNull: true, validate: { min: 1, max: 5 } },
  calificacion_negocio: { type: DataTypes.INTEGER, allowNull: true, validate: { min: 1, max: 5 } },
  comentario:   { type: DataTypes.TEXT, allowNull: true },
  propina:      { type: DataTypes.DECIMAL(10, 2), allowNull: true, defaultValue: 0 },
  ciudad:       { type: DataTypes.STRING(50), allowNull: true },
  tipo_envio: {
    type: DataTypes.ENUM('express', 'standard'),
    defaultValue: 'standard',
  },
  fee_cliente:  { type: DataTypes.DECIMAL(10, 2), defaultValue: 35.00 },
  zona_premium: { type: DataTypes.BOOLEAN, defaultValue: false },
  batch_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'delivery_batches', key: 'id' },
  },
}, {
  tableName: 'pedidos',
  timestamps: true,
  createdAt: 'creado_en',
  updatedAt: 'actualizado_en',
  hooks: {
    beforeCreate: (pedido) => {
      // Límite en subtotal (sin envío), igual que la validación del controller
      if (pedido.metodo_pago === 'efectivo' && parseFloat(pedido.subtotal) > 500) {
        throw new Error('Los pedidos en efectivo no pueden superar $500 MXN en productos. Por favor elige otro método de pago.');
      }
    },
  },
});

module.exports = Pedido;
