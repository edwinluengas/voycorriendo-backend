const { RestaurantToken, Negocio, TokenTier, TokenConsumo } = require('../models');
const { Op } = require('sequelize');
const { sequelize } = require('../config/database');
const pagosService = require('../services/pagos.service');

// Cache local de tiers (se refresca cada 5 min)
let _tiersCache = null;
let _tiersCacheTs = 0;
const TIERS_TTL_MS = 5 * 60 * 1000;

const getTiers = async () => {
  if (!_tiersCache || Date.now() - _tiersCacheTs > TIERS_TTL_MS) {
    _tiersCache = await TokenTier.findAll({
      where: { activo: true },
      order: [['orden', 'ASC']],
    });
    _tiersCacheTs = Date.now();
  }
  return _tiersCache;
};

// ─── FIFO token consumption (dentro de una transacción DB) ─
// Consume `cantidad` tokens del restaurante, FIFO por expires_at.
// Respeta overdraft hasta negocios.tokens_negativos_permitidos.
// Devuelve el nuevo saldo total.
const consumirTokensFIFO = async (restaurant_id, pedido_id, cantidad, t) => {
  const negocio = await Negocio.findByPk(restaurant_id, {
    attributes: ['tokens_negativos_permitidos'],
    transaction: t,
  });
  const overdraftLimit = negocio?.tokens_negativos_permitidos ?? -10;

  const lotes = await RestaurantToken.findAll({
    where: {
      restaurant_id,
      expires_at: { [Op.gt]: new Date() },
    },
    order: [['expires_at', 'ASC']],
    lock: true,
    transaction: t,
  });

  const totalBalance = lotes.reduce((s, l) => s + l.tokens_remaining, 0);

  if (totalBalance - cantidad < overdraftLimit) {
    throw Object.assign(
      new Error(`Tokens insuficientes: saldo ${totalBalance}, necesario ${cantidad}, límite sobregiro ${overdraftLimit}. Recarga tu saldo.`),
      { httpStatus: 402 },
    );
  }

  let aConsumir = cantidad;
  const registros = [];

  for (const lote of lotes) {
    if (aConsumir <= 0) break;
    const delEste = Math.min(Math.max(lote.tokens_remaining, 0), aConsumir);
    if (delEste > 0) {
      lote.tokens_remaining -= delEste;
      await lote.save({ transaction: t });
      registros.push({ restaurant_token_id: lote.id, restaurant_id, pedido_id, tokens_consumidos: delEste });
      aConsumir -= delEste;
    }
  }

  // Sobregiro: aplicar al último lote activo
  if (aConsumir > 0 && lotes.length > 0) {
    const ultimo = lotes[lotes.length - 1];
    ultimo.tokens_remaining -= aConsumir;
    await ultimo.save({ transaction: t });
    registros.push({ restaurant_token_id: ultimo.id, restaurant_id, pedido_id, tokens_consumidos: aConsumir });
  }

  if (registros.length > 0) {
    await TokenConsumo.bulkCreate(registros, { transaction: t });
  }

  return totalBalance - cantidad;
};

// ─── GET /api/tokens/saldo ────────────────────────────────
const obtenerSaldo = async (req, res) => {
  try {
    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });

    const ahora = new Date();
    const lotes = await RestaurantToken.findAll({
      where: {
        restaurant_id: negocio.id,
        expires_at: { [Op.gt]: ahora },
      },
      order: [['expires_at', 'ASC']],
    });

    const total_tokens = lotes.reduce((s, t) => s + t.tokens_remaining, 0);
    const overdraftLimit = negocio.tokens_negativos_permitidos ?? -10;

    res.json({
      ok: true,
      data: {
        total_tokens,
        overdraft_disponible: Math.max(0, total_tokens - overdraftLimit),
        packs: lotes.map((t) => ({
          id:               t.id,
          pack_type:        t.pack_type,
          tokens_remaining: t.tokens_remaining,
          expires_at:       t.expires_at,
        })),
      },
    });
  } catch (error) {
    console.error('Error en obtenerSaldo:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener saldo.' });
  }
};

// ─── POST /api/tokens/comprar ─────────────────────────────
// Body: { pack_type: 'silver'|'golden'|'diamond' }
const comprarPack = async (req, res) => {
  try {
    const { pack_type } = req.body;
    const tiers = await getTiers();
    const tier = tiers.find((t) => t.nombre === pack_type);

    if (!tier) {
      const nombres = tiers.map((t) => t.nombre).join(', ');
      return res.status(400).json({ ok: false, mensaje: `Pack inválido. Opciones: ${nombres}.` });
    }

    const negocio = await Negocio.findOne({ where: { usuario_id: req.usuario.id } });
    if (!negocio) return res.status(404).json({ ok: false, mensaje: 'Negocio no encontrado.' });
    if (negocio.verificacion_estado !== 'aprobado') {
      return res.status(403).json({ ok: false, mensaje: 'Tu negocio debe estar aprobado para comprar tokens.' });
    }

    const tokens    = Number(tier.tokens);
    const precio    = Number(tier.precio);
    const diasExp   = Number(tier.vigencia_dias);
    const expires_at = new Date();
    expires_at.setDate(expires_at.getDate() + diasExp);

    // ── Sandbox (sin clave MP): acreditar directo ───────────
    if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
      const lote = await RestaurantToken.create({
        restaurant_id:    negocio.id,
        tokens_remaining: tokens,
        tokens_comprados: tokens,
        pack_type,
        precio_pagado:    precio,
        expires_at,
      });
      return res.status(201).json({
        ok: true,
        sandbox: true,
        mensaje: `[Sandbox] Pack ${tier.label} acreditado: ${tokens} tokens.`,
        data: { token_id: lote.id, pack_type, tokens_acreditados: tokens, expires_at },
      });
    }

    // ── Producción: crear preferencia MP ───────────────────
    const pref = await pagosService.crearPreferenciaTokens({
      pack_type,
      negocio,
      tokens,
      precio,
    });

    return res.json({
      ok: true,
      mensaje: 'Redirige al link de pago para completar la compra.',
      data: {
        pack_type,
        tokens,
        precio,
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
const listarPacks = async (req, res) => {
  try {
    const tiers = await getTiers();
    res.json({
      ok: true,
      data: {
        packs: tiers.map((t) => ({
          id:             t.nombre,
          label:          t.label,
          tokens:         Number(t.tokens),
          precio:         Number(t.precio),
          vigencia_dias:  Number(t.vigencia_dias),
          costo_token:    Number(t.costo_por_token),
        })),
      },
    });
  } catch (error) {
    console.error('Error en listarPacks:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al cargar packs.' });
  }
};

module.exports = { obtenerSaldo, comprarPack, listarPacks, consumirTokensFIFO };
