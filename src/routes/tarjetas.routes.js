const express = require('express');
const router = express.Router();
const { proteger, restringirA } = require('../middleware/auth');
const ctrl = require('../controllers/tarjetasController');

router.use(proteger, restringirA('cliente'));

router.get('/', ctrl.listar);
router.post('/', ctrl.agregar);
router.delete('/:id', ctrl.eliminar);

module.exports = router;
