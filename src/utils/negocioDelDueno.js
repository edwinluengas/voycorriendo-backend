/**
 * El negocio (sucursal) sobre el que está operando el dueño en esta petición.
 *
 * Un dueño puede tener varias sucursales —una por plaza— y la app indica con
 * cuál está trabajando en el header `X-Negocio-Id`. Antes todo el backend
 * hacía `Negocio.findOne({ usuario_id })`, que con dos sucursales devolvía una
 * cualquiera: los pedidos, el menú y la apertura de Zacatepec podían caer en
 * los de Putla.
 *
 * Sin header (o con uno que no es suyo) se usa la MATRIZ — la sucursal más
 * antigua. Así las versiones de la app que no mandan el header siguen viendo
 * exactamente lo que veían, y nadie puede operar un negocio ajeno poniendo su
 * id en el header: siempre se filtra por `usuario_id`.
 */
const { Negocio } = require('../models');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const negocioDelDueno = async (req, opciones = {}) => {
  const usuarioId = req.usuario.id;
  const pedido = String(req.get('x-negocio-id') || '').trim();
  if (UUID_RE.test(pedido)) {
    const elegido = await Negocio.findOne({ ...opciones, where: { id: pedido, usuario_id: usuarioId } });
    if (elegido) return elegido;
  }
  return Negocio.findOne({
    ...opciones,
    where: { usuario_id: usuarioId },
    order: [['creado_en', 'ASC']],
  });
};

module.exports = { negocioDelDueno };
