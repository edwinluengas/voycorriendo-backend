const express = require('express');
const router = express.Router();
const { proteger, restringirA } = require('../middleware/auth');
const ctrl = require('../controllers/tarjetasController');

const { metodoPagoActivo } = require('../config/precios');

router.use(proteger, restringirA('cliente'));

// Listar y ELIMINAR siguen disponibles con el pago con tarjeta apagado: el
// cliente debe poder ver y quitar sus tarjetas guardadas aunque no pueda
// pagar con ellas por ahora. Lo que se bloquea es AGREGAR una nueva, que no
// tendría ningún uso mientras el método esté desactivado.
router.get('/', ctrl.listar);
router.post('/', (req, res, next) => {
  if (metodoPagoActivo('tarjeta')) return next();
  return res.status(503).json({
    ok: false,
    mensaje: 'Guardar tarjetas está desactivado por el momento — solo aceptamos efectivo. Podrás agregarlas cuando reactivemos el pago con tarjeta.',
    codigo: 'METODO_PAGO_DESACTIVADO',
  });
}, ctrl.agregar);
router.delete('/:id', ctrl.eliminar);

module.exports = router;
