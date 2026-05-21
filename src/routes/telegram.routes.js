const express = require('express');
const { proteger } = require('../middleware/auth');
const ctrl = require('../controllers/telegramController');

const router = express.Router();

// Webhook público — lo llama Telegram (no requiere auth)
router.post('/webhook', ctrl.manejarUpdate);

// Genera deep link para vincular cuenta (requiere login en la app)
router.get('/vincular-link', proteger, ctrl.generarLinkVinculacion);

module.exports = router;
