const { RestaurantToken, Negocio } = require('../models');
const { Op } = require('sequelize');
const pagosService = require('../services/pagos.service');

const PACKS = RestaurantToken.PACK_TOKENS;   // { starter:50, pro:200, elite:500 }
const DIAS  = RestaurantToken.PACK_EXPIRY;   // { starter:60, pro:90, elite:120 }
const PRECIOS = RestaurantToken.PACK_PRICES; // { starter:1050, pro:4000, elite:9500 }

// ─── GET /api/tokens/saldo ────────────────────────────────
const obtenerSaldo = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });

    const ahora = new Date();
    const tokens = await RestaurantToken.findAll({
      where: {
        restaurant_id: negocio.id,
        tokens_remaining: { [Op.gt]: 0 },
        expires_at: { [Op.gt]: ahora },
      },
      order: [['expires_at', 'ASC']],
    });

    const total_tokens = tokens.reduce((s, t) => s + t.tokens_remaining, 0);

    res.json({
      ok: true,
      data: {
        total_tokens,
        packs: tokens.map(t => ({
          id:               t.id,
          pack_type:        t.pack_type,
          tokens_remaining: t.tokens_remaining,
          expires_at:       t.expires_at,
        })),
        tarifa_excedente: 30,
      },
    });
  } catch (error) {
    console.error('Error en obtenerSaldo:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener saldo.' });
  }
};

// ─── POST /api/tokens/comprar ─────────────────────────────
// Body: { pack_type: 'starter'|'pro'|'elite' }
// Producción: crea preferencia MP y devuelve link de pago.
//   Los tokens se acreditan en el webhook cuando MP confirma.
// Sandbox (sin MP_ACCESS_TOKEN): acredita directo para pruebas.
const comprarPack = async (req, res) => {
  try {
    const { pack_type } = req.body;
    if (!PACKS[pack_type]) {
      return res.status(400).json({ ok: false, mensaje: 'Pack inválido. Usa: starter, pro, elite.' });
    }

    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });
    if (negocio.verificacion_estado !== 'aprobado') {
      return res.status(403).json({ ok: false, mensaje: 'Tu negocio debe estar aprobado para comprar tokens.' });
    }

    // ── Sandbox: acreditar directo ──────────────────────────
    if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
      const expires_at = new Date();
      expires_at.setDate(expires_at.getDate() + DIAS[pack_type]);
      const token = await RestaurantToken.create({
        restaurant_id:    negocio.id,
        tokens_remaining: PACKS[pack_type],
        pack_type,
        expires_at,
      });
      return res.status(201).json({
        ok: true,
        sandbox: true,
        mensaje: `[Sandbox] Pack ${pack_type} acreditado: ${PACKS[pack_type]} tokens.`,
        data: { token_id: token.id, pack_type, tokens_acreditados: PACKS[pack_type], expires_at },
      });
    }

    // ── Producción: crear preferencia MP ───────────────────
    const pref = await pagosService.crearPreferenciaTokens({
      pack_type,
      negocio,
      tokens: PACKS[pack_type],
      precio: PRECIOS[pack_type],
    });

    return res.json({
      ok: true,
      mensaje: 'Redirige al link de pago para completar la compra.',
      data: {
        pack_type,
        tokens: PACKS[pack_type],
        precio: PRECIOS[pack_type],
        preference_id:      pref.preference_id,
        init_point:         pref.init_point,
        sandbox_init_point: pref.sandbox_init_point,
      },
    });
  } catch (error) {
    console.error('Error en comprarPack:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al procesar la compra.' });
  }
};

// ─── GET /api/tokens/packs ────────────────────────────────
// Catálogo público de packs disponibles
const listarPacks = async (req, res) => {
  res.json({
    ok: true,
    data: {
      packs: [
        { id: 'starter', tokens: PACKS.starter, precio: PRECIOS.starter, vigencia_dias: DIAS.starter, costo_token: 21 },
        { id: 'pro',     tokens: PACKS.pro,     precio: PRECIOS.pro,     vigencia_dias: DIAS.pro,     costo_token: 20 },
        { id: 'elite',   tokens: PACKS.elite,   precio: PRECIOS.elite,   vigencia_dias: DIAS.elite,   costo_token: 19 },
      ],
      tarifa_excedente: 30,
    },
  });
};

module.exports = { obtenerSaldo, comprarPack, listarPacks };
