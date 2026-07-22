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

// Solo se borra la foto de pedidos ya CERRADOS — uno atascado en 'listo' o
// 'en_camino' todavía puede necesitar que el repartidor verifique el INE
// al entregar, sin importar cuántos días lleve abierto.
const ESTADOS_TERMINALES = ['entregado', 'cancelado', 'rechazado'];

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
      estado: { [Op.in]: ESTADOS_TERMINALES },
    },
    attributes: ['id', 'numero', 'ine_foto_url', 'creado_en'],
  });

  let eliminadas = 0;
  let fallidas = 0;
  for (const pedido of pedidos) {
    const ruta = rutaDesdeUrl(pedido.ine_foto_url);
    // Si no se puede borrar del storage, NO se limpia la referencia en DB —
    // se reintenta el siguiente día (el pedido sigue cayendo en el filtro
    // de arriba mientras ine_foto_url no sea null). Evita archivos
    // huérfanos en Supabase con la DB ya diciendo que no existen.
    const borrado = ruta ? await borrarImagen(BUCKET_INE_CLIENTE, ruta) : true;
    if (!borrado) {
      fallidas++;
      console.warn(`[LimpiezaIneCliente] No se pudo borrar del storage — pedido ${pedido.numero}, se reintenta mañana.`);
      continue;
    }
    await pedido.update({ ine_foto_url: null });
    eliminadas++;
  }

  if (eliminadas > 0 || fallidas > 0) {
    console.log(`[LimpiezaIneCliente] ${eliminadas} foto(s) eliminada(s), ${fallidas} fallida(s) (se reintentan mañana).`);
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
