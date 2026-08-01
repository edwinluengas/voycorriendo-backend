/**
 * Limpieza de usuarios para arrancar la operación en limpio.
 *
 * Conserva SIEMPRE:
 *   - Las cuentas admin reales (rol = 'admin').
 *   - Las cuentas de prueba fijas de la suite (0000000001-4) y la del dueño
 *     (5545074460 con su negocio), porque los 43 tests dependen de ellas.
 *
 * Borra todo lo demás y, con ello, sus documentos de identidad del Storage:
 * conservar la INE de alguien cuya cuenta ya no existe no tiene justificación
 * y la LFPDPPP obliga a no guardar datos personales más de lo necesario.
 *
 * Deja respaldo en backup-limpieza-usuarios-<fecha>.json (ignorado por git:
 * contiene PII). Sin --aplicar solo muestra qué haría.
 *
 *   node src/scripts/limpiar-usuarios.js
 *   node src/scripts/limpiar-usuarios.js --aplicar
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Sequelize } = require('sequelize');
const { sequelize } = require('../config/database');
const { borrarImagen } = require('../services/storage.service');
const {
  BUCKET_PRIVADO_NEGOCIOS, BUCKET_PRIVADO_REPARTIDORES,
  BUCKET_PUBLICO_NEGOCIOS, BUCKET_PUBLICO_REPARTIDORES,
  COLUMNAS_PRIVADAS_NEGOCIO, COLUMNAS_PRIVADAS_REPARTIDOR,
} = require('../config/buckets');

const APLICAR = process.argv.includes('--aplicar');
const TELEFONOS_PROTEGIDOS = ['0000000001', '0000000002', '0000000003', '0000000004', '5545074460'];

const q = (sql, replacements) =>
  sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT, replacements });

// Ruta dentro del bucket a partir de la URL guardada.
const rutaDesde = (url) => {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/object\/(?:public\/)?[^/]+\/(.+)$/);
  return m ? m[1] : null;
};

(async () => {
  console.log(APLICAR ? '=== LIMPIEZA REAL ===' : '=== SIMULACRO (usa --aplicar) ===\n');

  const protegidos = await q(
    `SELECT id, telefono, rol FROM usuarios
      WHERE rol = 'admin' OR telefono IN (:tels)`,
    { tels: TELEFONOS_PROTEGIDOS },
  );
  const idsProtegidos = protegidos.map((u) => u.id);
  console.log(`Se conservan ${protegidos.length} cuentas:`);
  protegidos.forEach((u) => console.log(`   ${u.telefono} (${u.rol})`));

  const aBorrar = await q(
    `SELECT id, nombre, telefono, lada, email, rol, creado_en FROM usuarios
      WHERE id NOT IN (:ids) ORDER BY creado_en`,
    { ids: idsProtegidos },
  );
  console.log(`\nSe borran ${aBorrar.length} usuarios.`);
  if (!aBorrar.length) { await sequelize.close(); return; }

  const ids = aBorrar.map((u) => u.id);

  // Documentos en Storage de los que se van (para borrarlos de verdad).
  const negocios = await q(
    `SELECT id, nombre, usuario_id, ${COLUMNAS_PRIVADAS_NEGOCIO.join(', ')}, logo, foto_portada, foto_local
       FROM negocios WHERE usuario_id IN (:ids)`, { ids });
  const repartidores = await q(
    `SELECT id, usuario_id, ${COLUMNAS_PRIVADAS_REPARTIDOR.join(', ')}
       FROM repartidores WHERE usuario_id IN (:ids)`, { ids });

  console.log(`  · ${negocios.length} negocios y ${repartidores.length} repartidores asociados`);

  // ── Respaldo antes de tocar nada ──────────────────────────
  const archivo = path.join(__dirname, '..', '..',
    `backup-limpieza-usuarios-${new Date().toISOString().slice(0, 10)}.json`);
  const pedidos = await q(`SELECT * FROM pedidos WHERE cliente_id IN (:ids)`, { ids });
  const respaldo = { generado: new Date().toISOString(), usuarios: aBorrar, negocios, repartidores, pedidos };

  if (!APLICAR) {
    console.log(`\n[simulacro] respaldo iría a ${path.basename(archivo)}`);
    console.log('[simulacro] no se borró nada.');
    await sequelize.close();
    return;
  }

  fs.writeFileSync(archivo, JSON.stringify(respaldo, null, 2));
  console.log(`\nRespaldo escrito: ${path.basename(archivo)} (contiene PII, no se commitea)`);

  // ── Storage: documentos de identidad y fotos ──────────────
  let archivosBorrados = 0;
  const borrar = async (bucket, url) => {
    const ruta = rutaDesde(url);
    if (!ruta) return;
    if (await borrarImagen(bucket, ruta)) archivosBorrados++;
  };
  for (const n of negocios) {
    for (const c of COLUMNAS_PRIVADAS_NEGOCIO) await borrar(BUCKET_PRIVADO_NEGOCIOS, n[c]);
    for (const c of ['logo', 'foto_portada', 'foto_local']) await borrar(BUCKET_PUBLICO_NEGOCIOS, n[c]);
  }
  for (const r of repartidores) {
    for (const c of COLUMNAS_PRIVADAS_REPARTIDOR) await borrar(BUCKET_PRIVADO_REPARTIDORES, r[c]);
  }
  console.log(`Archivos borrados del Storage: ${archivosBorrados}`);

  // ── Borrado en DB, de las hojas hacia la raíz ─────────────
  // El orden importa: primero lo que apunta a pedidos/negocios/repartidores,
  // al final los usuarios. Así ninguna FK queda colgando a medio camino.
  const negociosIds = negocios.map((n) => n.id);
  const repartidoresIds = repartidores.map((r) => r.id);

  const pasos = [
    ['perdidas_pedido',      `DELETE FROM perdidas_pedido WHERE pedido_id IN (SELECT id FROM pedidos WHERE cliente_id IN (:ids) OR negocio_id IN (:negs) OR repartidor_id IN (:reps))`],
    ['ledger_conciliacion',  `DELETE FROM ledger_conciliacion WHERE pedido_id IN (SELECT id FROM pedidos WHERE cliente_id IN (:ids) OR negocio_id IN (:negs) OR repartidor_id IN (:reps))`],
    ['pedidos',              `DELETE FROM pedidos WHERE cliente_id IN (:ids) OR negocio_id IN (:negs) OR repartidor_id IN (:reps)`],
    // OJO con los nombres de columna: delivery_batches usa `driver_id` y
    // liquidaciones es polimórfica (`entidad_tipo` + `entidad_id`), no
    // `repartidor_id`. Escribirlo mal no truena la limpieza —el paso se
    // salta con un aviso— pero deja filas huérfanas sin que se note.
    ['delivery_batches',     `DELETE FROM delivery_batches WHERE driver_id IN (:reps)`],
    ['fondo_repartidor',     `DELETE FROM fondo_repartidor WHERE repartidor_id IN (:reps)`],
    ['liquidaciones',        `DELETE FROM liquidaciones WHERE (entidad_tipo = 'repartidor' AND entidad_id IN (:reps)) OR (entidad_tipo = 'negocio' AND entidad_id IN (:negs))`],
    ['productos',            `DELETE FROM productos WHERE negocio_id IN (:negs)`],
    ['creditos_cliente',     `DELETE FROM creditos_cliente WHERE usuario_id IN (:ids)`],
    ['tarjetas_guardadas',   `DELETE FROM tarjetas_guardadas WHERE usuario_id IN (:ids)`],
    ['negocios',             `DELETE FROM negocios WHERE usuario_id IN (:ids)`],
    ['repartidores',         `DELETE FROM repartidores WHERE usuario_id IN (:ids)`],
    ['usuarios',             `DELETE FROM usuarios WHERE id IN (:ids)`],
  ];

  const repl = { ids, negs: negociosIds.length ? negociosIds : ['00000000-0000-0000-0000-000000000000'],
                 reps: repartidoresIds.length ? repartidoresIds : ['00000000-0000-0000-0000-000000000000'] };

  for (const [nombre, sql] of pasos) {
    try {
      await sequelize.query(sql, { replacements: repl });
      console.log(`  ✓ ${nombre}`);
    } catch (e) {
      console.log(`  · ${nombre}: ${e.message.split('\n')[0]}`);
    }
  }

  const [restantes] = await q('SELECT count(*) n FROM usuarios');
  console.log(`\nUsuarios restantes: ${restantes.n}`);
  await sequelize.close();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
