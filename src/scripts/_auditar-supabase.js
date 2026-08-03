/**
 * Solo lectura: auditoría de Supabase (Storage + base) enfocada en fugas.
 * `node src/scripts/_auditar-supabase.js`
 */
require('dotenv').config();
const axios = require('axios');
const https = require('https');
const { sequelize } = require('../config/database');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const agente = new https.Agent({ rejectUnauthorized: false });
const q = async (sql) => sequelize.query(sql, { type: sequelize.QueryTypes.SELECT });

(async () => {
  try {
    // ── 1. Buckets: cuáles son públicos ───────────────────────────────
    const { data: buckets } = await axios.get(`${URL}/storage/v1/bucket`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, httpsAgent: agente,
    });
    console.log('\n── BUCKETS ──');
    console.table(buckets.map((b) => ({ nombre: b.name, publico: b.public })));

    // ── 2. ¿Un documento de identidad se baja sin token? ──────────────
    console.log('\n── ¿DOCUMENTOS DE IDENTIDAD ACCESIBLES SIN TOKEN? ──');
    const docs = await q(`
      SELECT 'negocio' AS tipo, documento_ine_dueno AS url FROM negocios WHERE documento_ine_dueno IS NOT NULL
      UNION ALL SELECT 'negocio', documento_rfc FROM negocios WHERE documento_rfc IS NOT NULL
      UNION ALL SELECT 'negocio', comprobante_domicilio FROM negocios WHERE comprobante_domicilio IS NOT NULL
      UNION ALL SELECT 'repartidor', foto_ine_frente FROM repartidores WHERE foto_ine_frente IS NOT NULL
      UNION ALL SELECT 'repartidor', foto_licencia FROM repartidores WHERE foto_licencia IS NOT NULL
      UNION ALL SELECT 'cliente', ine_foto_url FROM pedidos WHERE ine_foto_url IS NOT NULL
      LIMIT 40`);
    if (!docs.length) console.log('   (no hay documentos cargados)');
    for (const d of docs) {
      let estado;
      try {
        const r = await axios.get(d.url, { httpsAgent: agente, validateStatus: () => true, responseType: 'arraybuffer', timeout: 15000 });
        estado = r.status === 200 ? `🚨 FUGA — 200 (${r.data.length} bytes) SIN token` : `✅ bloqueado (${r.status})`;
      } catch (e) { estado = `✅ bloqueado (${e.code || e.message})`; }
      console.log(`   ${d.tipo.padEnd(11)} ${estado}  ${String(d.url).slice(0, 70)}`);
    }

    // ── 3. Fuga entre plazas por el endpoint público ──────────────────
    console.log('\n── COLUMNAS QUE SALEN EN EL CATÁLOGO PÚBLICO ──');
    const publicas = require('../controllers/negociosController');
    console.log('   (lista blanca en negociosController.CAMPOS_PUBLICOS_NEGOCIO)');

    // ── 4. Coherencia: ¿cada negocio/repartidor está en la plaza que le
    //       corresponde por sus coordenadas? ──────────────────────────
    const { plazaDe } = require('../config/ciudades');
    console.log('\n── COHERENCIA GPS ↔ PLAZA ──');
    const filas = [
      ...(await q(`SELECT 'negocio' AS t, nombre AS quien, ciudad, latitud::float, longitud::float FROM negocios`)),
      ...(await q(`SELECT 'repartidor' AS t, id::text AS quien, ciudad, latitud::float, longitud::float FROM repartidores`)),
    ];
    let malos = 0;
    for (const f of filas) {
      const p = plazaDe(f.latitud, f.longitud);
      const ok = p.slug === f.ciudad && p.dentro;
      if (!ok) malos++;
      console.log(`   ${ok ? '✅' : '⚠️ '} ${f.t.padEnd(11)} ${String(f.quien).slice(0, 26).padEnd(27)} guardado=${String(f.ciudad).padEnd(17)} gps→${String(p.slug).padEnd(17)} ${p.km == null ? 'sin coords' : p.km.toFixed(1) + ' km'}`);
    }
    console.log(`   ${malos === 0 ? 'Todos coherentes.' : malos + ' fila(s) en la plaza equivocada.'}`);

    // ── 5. Pedidos cruzados de plaza ──────────────────────────────────
    console.log('\n── PEDIDOS CON PLAZA DISTINTA A LA DE SU NEGOCIO O REPARTIDOR ──');
    console.table(await q(`
      SELECT p.numero, p.ciudad AS pedido, n.ciudad AS negocio, r.ciudad AS repartidor, p.estado
        FROM pedidos p
        JOIN negocios n ON n.id = p.negocio_id
        LEFT JOIN repartidores r ON r.id = p.repartidor_id
       WHERE p.ciudad IS DISTINCT FROM n.ciudad
          OR (r.id IS NOT NULL AND r.ciudad IS DISTINCT FROM p.ciudad)`));

    // ── 6. Filas sin plaza (invisibles o fugadas) ─────────────────────
    console.log('\n── FILAS SIN PLAZA ──');
    console.table(await q(`
      SELECT 'negocios' AS tabla, COUNT(*)::int AS sin_ciudad FROM negocios WHERE ciudad IS NULL
      UNION ALL SELECT 'repartidores', COUNT(*)::int FROM repartidores WHERE ciudad IS NULL
      UNION ALL SELECT 'pedidos', COUNT(*)::int FROM pedidos WHERE ciudad IS NULL`));
  } catch (e) {
    console.error('ERROR:', e.response?.status || '', e.message);
  } finally {
    await sequelize.close();
  }
})();
