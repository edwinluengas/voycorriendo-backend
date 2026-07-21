const cron = require('node-cron');
const { Op } = require('sequelize');
const { Pedido } = require('../models');
const { borrarImagen } = require('../services/storage.service');

// Minimización de datos (LFPDPPP): la foto de INE del cliente solo se
// captura para verificar edad en productos restringidos (alcohol/tabaco).
// Se conserva un tiempo por si hay que resolver una disputa/contracargo
// (Mercado Pago puede tardar 30-45 días) o una queja tardía sobre ese
// pedido — pero no más de lo necesario. Ver legal/inventario-tecnico-datos.md.
const RETENCION_INE_DIAS = parseInt(process.env.RETENCION_INE_DIAS || '30');

const BUCKET_INE_CLIENTE = 'documentos-clientes';

const rutaDesdeUrl = (url) => {
  const marcador = `/object/public/${BUCKET_INE_CLIENTE}/`;
  if (!url || !url.includes(marcador)) return null;
  return url.split(marcador)[1];
};

async function borrarFotosIneVencidas() {
  const limite = new Date(Date.now() - RETENCION_INE_DIAS * 24 * 60 * 60 * 1000);

  const pedidos = await Pedido.findAll({
    where: {
      ine_foto_url: { [Op.not]: null },
      creado_en: { [Op.lt]: limite },
    },
    attributes: ['id', 'numero', 'ine_foto_url', 'creado_en'],
  });

  for (const pedido of pedidos) {
    const ruta = rutaDesdeUrl(pedido.ine_foto_url);
    if (ruta) {
      await borrarImagen(BUCKET_INE_CLIENTE, ruta);
    }
    await pedido.update({ ine_foto_url: null });
    console.log(`[LimpiezaIneCliente] Foto de INE eliminada — pedido ${pedido.numero} (${RETENCION_INE_DIAS}+ días).`);
  }

  if (pedidos.length > 0) {
    console.log(`[LimpiezaIneCliente] ${pedidos.length} foto(s) de INE eliminada(s) por retención.`);
  }
}

function iniciarJobLimpiezaIneCliente() {
  // Una vez al día a las 4am — no es urgente, evita competir con tráfico real.
  cron.schedule('0 4 * * *', async () => {
    try {
      await borrarFotosIneVencidas();
    } catch (e) {
      console.error('[LimpiezaIneCliente] Error:', e.message);
    }
  });
  console.log(`[LimpiezaIneCliente] Job iniciado — borra fotos de INE de clientes con más de ${RETENCION_INE_DIAS} días, diario a las 4am.`);
}

module.exports = { iniciarJobLimpiezaIneCliente, borrarFotosIneVencidas, RETENCION_INE_DIAS };
