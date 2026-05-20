const Usuario        = require('./Usuario');
const Repartidor     = require('./Repartidor');
const Negocio        = require('./Negocio');
const Producto       = require('./Producto');
const Pedido         = require('./Pedido');
const DeliveryBatch  = require('./DeliveryBatch');
const RestaurantToken = require('./RestaurantToken');
const DriverPayment  = require('./DriverPayment');
const PlatformRevenue = require('./PlatformRevenue');

// ─── Relaciones base ──────────────────────────────────────
Usuario.hasOne(Repartidor, { foreignKey: 'usuario_id', as: 'perfil_repartidor' });
Repartidor.belongsTo(Usuario, { foreignKey: 'usuario_id', as: 'usuario' });

Usuario.hasOne(Negocio, { foreignKey: 'usuario_id', as: 'negocio' });
Negocio.belongsTo(Usuario, { foreignKey: 'usuario_id', as: 'dueno' });

Negocio.hasMany(Producto, { foreignKey: 'negocio_id', as: 'productos' });
Producto.belongsTo(Negocio, { foreignKey: 'negocio_id', as: 'negocio' });

Pedido.belongsTo(Usuario,    { foreignKey: 'cliente_id',    as: 'cliente' });
Usuario.hasMany(Pedido,      { foreignKey: 'cliente_id',    as: 'pedidos_como_cliente' });

Pedido.belongsTo(Negocio,    { foreignKey: 'negocio_id',    as: 'negocio' });
Negocio.hasMany(Pedido,      { foreignKey: 'negocio_id',    as: 'pedidos' });

Pedido.belongsTo(Repartidor, { foreignKey: 'repartidor_id', as: 'repartidor' });
Repartidor.hasMany(Pedido,   { foreignKey: 'repartidor_id', as: 'entregas' });

// ─── Delivery batches ─────────────────────────────────────
Repartidor.hasMany(DeliveryBatch, { foreignKey: 'driver_id', as: 'batches' });
DeliveryBatch.belongsTo(Repartidor, { foreignKey: 'driver_id', as: 'repartidor' });

Pedido.belongsTo(DeliveryBatch, { foreignKey: 'batch_id', as: 'batch' });
DeliveryBatch.hasMany(Pedido,   { foreignKey: 'batch_id', as: 'pedidos' });

// ─── Tokens de restaurante ────────────────────────────────
Negocio.hasMany(RestaurantToken, { foreignKey: 'restaurant_id', as: 'tokens' });
RestaurantToken.belongsTo(Negocio, { foreignKey: 'restaurant_id', as: 'negocio' });

// ─── Pagos a repartidor ───────────────────────────────────
Repartidor.hasMany(DriverPayment, { foreignKey: 'driver_id', as: 'pagos' });
DriverPayment.belongsTo(Repartidor, { foreignKey: 'driver_id', as: 'repartidor' });

Pedido.hasOne(DriverPayment, { foreignKey: 'order_id', as: 'pago_repartidor_detalle' });
DriverPayment.belongsTo(Pedido, { foreignKey: 'order_id', as: 'pedido' });

// ─── Revenue de la plataforma ─────────────────────────────
Pedido.hasOne(PlatformRevenue, { foreignKey: 'order_id', as: 'revenue' });
PlatformRevenue.belongsTo(Pedido, { foreignKey: 'order_id', as: 'pedido' });

module.exports = {
  Usuario, Repartidor, Negocio, Producto, Pedido,
  DeliveryBatch, RestaurantToken, DriverPayment, PlatformRevenue,
};
