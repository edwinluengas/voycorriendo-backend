// Punto central de modelos — define todas las relaciones aquí
const Usuario    = require('./Usuario');
const Repartidor = require('./Repartidor');
const Negocio    = require('./Negocio');
const Producto   = require('./Producto');
const Pedido     = require('./Pedido');

// ─── Relaciones ───────────────────────────────────────────

// Un Usuario puede ser Repartidor
Usuario.hasOne(Repartidor, { foreignKey: 'usuario_id', as: 'perfil_repartidor' });
Repartidor.belongsTo(Usuario, { foreignKey: 'usuario_id', as: 'usuario' });

// Un Usuario puede ser dueño de un Negocio
Usuario.hasOne(Negocio, { foreignKey: 'usuario_id', as: 'negocio' });
Negocio.belongsTo(Usuario, { foreignKey: 'usuario_id', as: 'dueno' });

// Un Negocio tiene muchos Productos
Negocio.hasMany(Producto, { foreignKey: 'negocio_id', as: 'productos' });
Producto.belongsTo(Negocio, { foreignKey: 'negocio_id', as: 'negocio' });

// Pedido → Cliente (Usuario)
Pedido.belongsTo(Usuario, { foreignKey: 'cliente_id', as: 'cliente' });
Usuario.hasMany(Pedido, { foreignKey: 'cliente_id', as: 'pedidos_como_cliente' });

// Pedido → Negocio
Pedido.belongsTo(Negocio, { foreignKey: 'negocio_id', as: 'negocio' });
Negocio.hasMany(Pedido, { foreignKey: 'negocio_id', as: 'pedidos' });

// Pedido → Repartidor
Pedido.belongsTo(Repartidor, { foreignKey: 'repartidor_id', as: 'repartidor' });
Repartidor.hasMany(Pedido, { foreignKey: 'repartidor_id', as: 'entregas' });

module.exports = { Usuario, Repartidor, Negocio, Producto, Pedido };
