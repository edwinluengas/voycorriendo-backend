/**
 * Controlador de Tarjetas Guardadas (Mercado Pago Customers & Cards API)
 *   GET    /api/tarjetas      → lista las tarjetas guardadas del usuario
 *   POST   /api/tarjetas      → guarda una tarjeta ya tokenizada en la app
 *   DELETE /api/tarjetas/:id  → elimina una tarjeta guardada
 */

const { TarjetaGuardada } = require('../models');
const pagosService = require('../services/pagos.service');

// ─── GET /api/tarjetas ────────────────────────────────────
const listar = async (req, res) => {
  try {
    const tarjetas = await TarjetaGuardada.findAll({
      where: { usuario_id: req.usuario.id },
      order: [['predeterminada', 'DESC'], ['creado_en', 'DESC']],
    });
    res.json({ ok: true, data: { tarjetas } });
  } catch (error) {
    console.error('Error listar tarjetas:', error);
    res.status(500).json({ ok: false, mensaje: 'No pudimos cargar tus tarjetas.' });
  }
};

// ─── POST /api/tarjetas ───────────────────────────────────
// body: { token } — token generado en la app con POST /v1/card_tokens
// usando la public key. El número de tarjeta y el CVV nunca llegan aquí.
const agregar = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, mensaje: 'Falta el token de la tarjeta.' });

    const info = await pagosService.guardarTarjetaMP({ usuario: req.usuario, token });

    const yaTieneTarjetas = await TarjetaGuardada.count({ where: { usuario_id: req.usuario.id } });
    const tarjeta = await TarjetaGuardada.create({
      usuario_id: req.usuario.id,
      ...info,
      predeterminada: yaTieneTarjetas === 0,
    });

    res.json({ ok: true, mensaje: 'Tarjeta guardada.', data: { tarjeta } });
  } catch (error) {
    const mpError = error.response?.data;
    console.error('[MP] Error guardar tarjeta:', JSON.stringify(mpError || error.message));
    res.status(400).json({
      ok: false,
      mensaje: mpError?.cause?.[0]?.description || mpError?.message || 'No se pudo guardar la tarjeta. Verifica los datos.',
    });
  }
};

// ─── DELETE /api/tarjetas/:id ─────────────────────────────
const eliminar = async (req, res) => {
  try {
    const { id } = req.params;
    const tarjeta = await TarjetaGuardada.findByPk(id);
    if (!tarjeta || tarjeta.usuario_id !== req.usuario.id) {
      return res.status(404).json({ ok: false, mensaje: 'Tarjeta no encontrada.' });
    }

    await pagosService.eliminarTarjetaMP({ usuario: req.usuario, mp_card_id: tarjeta.mp_card_id }).catch((e) => {
      console.warn('[MP] No se pudo eliminar la tarjeta en MP (se elimina localmente igual):', e.response?.data || e.message);
    });

    const eraPredeterminada = tarjeta.predeterminada;
    await tarjeta.destroy();

    if (eraPredeterminada) {
      const otra = await TarjetaGuardada.findOne({ where: { usuario_id: req.usuario.id } });
      if (otra) { otra.predeterminada = true; await otra.save(); }
    }

    res.json({ ok: true, mensaje: 'Tarjeta eliminada.' });
  } catch (error) {
    console.error('Error eliminar tarjeta:', error);
    res.status(500).json({ ok: false, mensaje: 'No se pudo eliminar la tarjeta.' });
  }
};

module.exports = { listar, agregar, eliminar };
