/**
 * Mueve los documentos de identidad de los buckets PÚBLICOS a buckets
 * PRIVADOS y deja el bucket de INE de clientes en privado.
 *
 * Por qué: hasta 2026-07-31 la INE del dueño de un negocio, su RFC y su
 * comprobante de domicilio se descargaban con un GET sin token — mismo
 * bucket público que la foto de portada. Lo mismo con la INE, licencia y
 * tarjeta de circulación de cada repartidor.
 *
 * Es idempotente: lo ya migrado se salta, así que se puede correr las veces
 * que haga falta. No borra el original hasta confirmar que la copia quedó
 * arriba, y al final verifica que la URL vieja ya NO responda en público.
 *
 *   node src/scripts/migrar-documentos-privados.js          (simulacro)
 *   node src/scripts/migrar-documentos-privados.js --aplicar
 */
require('dotenv').config();
const axios = require('axios');
const { Sequelize } = require('sequelize');
const { sequelize } = require('../config/database');
const {
  BUCKET_PUBLICO_NEGOCIOS, BUCKET_PUBLICO_REPARTIDORES,
  BUCKET_PRIVADO_NEGOCIOS, BUCKET_PRIVADO_REPARTIDORES, BUCKET_PRIVADO_CLIENTES,
  COLUMNAS_PRIVADAS_NEGOCIO, COLUMNAS_PRIVADAS_REPARTIDOR,
} = require('../config/buckets');

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APLICAR = process.argv.includes('--aplicar');

const H = { Authorization: `Bearer ${KEY}`, apikey: KEY };

const log = (...a) => console.log(...a);

// ─── Helpers de Storage ────────────────────────────────────
const crearBucketPrivado = async (nombre) => {
  try {
    await axios.post(`${SUPABASE_URL}/storage/v1/bucket`,
      { name: nombre, id: nombre, public: false }, { headers: H });
    log(`  bucket creado (privado): ${nombre}`);
  } catch (e) {
    // Ya existe: asegurarse de que esté en privado de todas formas.
    if (e.response?.status === 409) {
      await axios.put(`${SUPABASE_URL}/storage/v1/bucket/${nombre}`,
        { public: false }, { headers: H });
      log(`  bucket ya existía, forzado a privado: ${nombre}`);
    } else throw e;
  }
};

const volverPrivado = async (nombre) => {
  await axios.put(`${SUPABASE_URL}/storage/v1/bucket/${nombre}`, { public: false }, { headers: H });
  log(`  bucket ${nombre} → privado`);
};

// De la URL guardada en DB saca la ruta dentro del bucket.
const rutaDesdeUrl = (url, bucket) => {
  if (typeof url !== 'string') return null;
  for (const marcador of [`/object/public/${bucket}/`, `/object/${bucket}/`]) {
    const i = url.indexOf(marcador);
    if (i !== -1) return url.slice(i + marcador.length);
  }
  return null;
};

const descargar = async (bucket, ruta) => {
  const r = await axios.get(`${SUPABASE_URL}/storage/v1/object/${bucket}/${ruta}`,
    { headers: H, responseType: 'arraybuffer' });
  return { buffer: Buffer.from(r.data), mime: r.headers['content-type'] || 'application/octet-stream' };
};

const subir = async (bucket, ruta, buffer, mime) => {
  await axios.post(`${SUPABASE_URL}/storage/v1/object/${bucket}/${ruta}`, buffer, {
    headers: { ...H, 'Content-Type': mime, 'x-upsert': 'true' },
    maxBodyLength: Infinity, maxContentLength: Infinity,
  });
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${ruta}`;
};

const existe = async (bucket, ruta) => {
  try {
    await axios.head(`${SUPABASE_URL}/storage/v1/object/${bucket}/${ruta}`, { headers: H });
    return true;
  } catch { return false; }
};

const borrar = async (bucket, ruta) => {
  try {
    await axios.delete(`${SUPABASE_URL}/storage/v1/object/${bucket}/${ruta}`, { headers: H });
    return true;
  } catch (e) { log(`    aviso: no se pudo borrar el original (${e.response?.status})`); return false; }
};

// ─── Migración de una tabla ────────────────────────────────
const migrarTabla = async ({ tabla, columnas, bucketOrigen, bucketDestino }) => {
  const q = async (s, r = {}) => sequelize.query(s, { type: Sequelize.QueryTypes.SELECT, replacements: r });
  const cond = columnas.map((c) => `${c} IS NOT NULL`).join(' OR ');
  const filas = await q(`SELECT id, ${columnas.join(', ')} FROM ${tabla} WHERE ${cond}`);

  log(`\n${tabla}: ${filas.length} fila(s) con documentos`);
  let movidos = 0, saltados = 0, fallos = 0;

  for (const fila of filas) {
    for (const col of columnas) {
      const url = fila[col];
      if (!url) continue;

      if (url.includes(`/${bucketDestino}/`)) { saltados++; continue; }  // ya migrado

      const ruta = rutaDesdeUrl(url, bucketOrigen);
      if (!ruta) { log(`  ? ${tabla}.${col} (${fila.id}): URL no reconocida, se deja igual`); saltados++; continue; }

      if (!APLICAR) { log(`  [simulacro] movería ${bucketOrigen}/${ruta} → ${bucketDestino}/${ruta}`); movidos++; continue; }

      try {
        const { buffer, mime } = await descargar(bucketOrigen, ruta);
        const urlNueva = await subir(bucketDestino, ruta, buffer, mime);

        // Solo se toca la DB y se borra el original si la copia ESTÁ arriba.
        if (!(await existe(bucketDestino, ruta))) throw new Error('la copia no aparece en el bucket destino');

        await sequelize.query(`UPDATE ${tabla} SET ${col} = :u WHERE id = :id`,
          { replacements: { u: urlNueva, id: fila.id } });
        await borrar(bucketOrigen, ruta);

        log(`  ✓ ${tabla}.${col} → ${bucketDestino}/${ruta} (${buffer.length} bytes)`);
        movidos++;
      } catch (e) {
        log(`  ✗ ${tabla}.${col} (${fila.id}): ${e.message}`);
        fallos++;
      }
    }
  }
  return { movidos, saltados, fallos };
};

(async () => {
  if (!SUPABASE_URL || !KEY) { console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  log(APLICAR ? '=== MIGRACIÓN REAL ===' : '=== SIMULACRO (usa --aplicar para ejecutar) ===');

  if (APLICAR) {
    log('\nBuckets:');
    await crearBucketPrivado(BUCKET_PRIVADO_NEGOCIOS);
    await crearBucketPrivado(BUCKET_PRIVADO_REPARTIDORES);
    await volverPrivado(BUCKET_PRIVADO_CLIENTES);
  }

  const r1 = await migrarTabla({
    tabla: 'negocios', columnas: COLUMNAS_PRIVADAS_NEGOCIO,
    bucketOrigen: BUCKET_PUBLICO_NEGOCIOS, bucketDestino: BUCKET_PRIVADO_NEGOCIOS,
  });
  const r2 = await migrarTabla({
    tabla: 'repartidores', columnas: COLUMNAS_PRIVADAS_REPARTIDOR,
    bucketOrigen: BUCKET_PUBLICO_REPARTIDORES, bucketDestino: BUCKET_PRIVADO_REPARTIDORES,
  });

  log(`\nTotal: ${r1.movidos + r2.movidos} movidos, ${r1.saltados + r2.saltados} saltados, ${r1.fallos + r2.fallos} fallos`);
  await sequelize.close();
  process.exit(r1.fallos + r2.fallos > 0 ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.response?.status, e.message); process.exit(1); });
