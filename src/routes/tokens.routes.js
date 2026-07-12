const express = require('express');
const { body } = require('express-validator');
const { obtenerSaldo, comprarPack, listarPacks } = require('../controllers/tokensController');
const { proteger, restringirA } = require('../middleware/auth');

const router = express.Router();

router.get('/packs', listarPacks);

router.use(proteger, restringirA('negocio', 'admin'));

router.get('/saldo', obtenerSaldo);

router.post('/comprar', [
  body('pack_type').isString().notEmpty().withMessage('Pack inválido'),
], comprarPack);

module.exports = router;
