const { ejecutarPagosSemanales, previsualizarPagosSemanales } = require('../services/spei.service');

// GET /api/admin/pagos/spei/pendientes
const pendientes = async (req, res) => {
  try {
    const lista = await previsualizarPagosSemanales();
    const total_a_pagar = lista.reduce((s, r) => s + r.total, 0);
    res.json({
      ok: true,
      data: { repartidores: lista, total_a_pagar },
    });
  } catch (error) {
    console.error('Error spei pendientes:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener pendientes.' });
  }
};

// POST /api/admin/pagos/spei/ejecutar
const ejecutar = async (req, res) => {
  try {
    const resultado = await ejecutarPagosSemanales();
    res.json({ ok: true, data: resultado });
  } catch (error) {
    console.error('Error spei ejecutar:', error);
    res.status(500).json({ ok: false, mensaje: 'Error al ejecutar pagos SPEI.' });
  }
};

module.exports = { pendientes, ejecutar };
