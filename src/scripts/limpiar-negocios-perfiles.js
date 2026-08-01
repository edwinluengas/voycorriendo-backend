/**
 * Borra TODOS los negocios y TODOS los perfiles de repartidor.
 *
 * Deja las cuentas de login (tabla `usuarios`) intactas a propósito: si se
 * borraran los admins nadie podría entrar al panel. Quien tenía un negocio o
 * era repartidor conserva su cuenta y puede volver a darse de alta desde
 * cero — se limpia el perfil, no el acceso.
 *
 * Arrastra lo que cuelga de ellos (pedidos, ledger, productos, batches,
 * fondos) y borra del Storage sus documentos de identidad y fotos: guardar
 * la INE de un perfil que ya no existe no tiene justificación.
 *
 * OJO: esto borra también "Tacos Don Beto" y el repartidor de prueba, de los
 * que dependen los 43 tests de la suite. Después de correr esto hay que
 * volver a sembrar ese escenario para poder testear.
 *
 *   node src/scripts/limpiar-negocios-perfiles.js            (simulacro)
 *   node src/scripts/limpiar-negocios-perfiles.js --aplicar
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Sequelize } = require('sequelize');
const { sequelize } = require('../config/database');
const { borrarImagen } = require('../services/storage.service');
const {
  BUCKET_PRIVADO_NEGOCIOS, BUCKET_PRIVADO_REPARTIDORES, BUCKET_PUBLICO_NEGOCIOS,
  COLUMNAS_PRIVADAS_NEGOCIO, COLUMNAS_PRIVADAS_REPARTIDOR,
} = require('../config/buckets');

const APLICAR = process.argv.includes('--aplicar');
const q = (sql) => sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });

const rutaDesde = (url) => {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/object\/(?:public\/)?[^/]+\/(.+)$/);
  return m ? m[1] : null;
};

(async () => {
  console.log(APLICAR ? '=== BORRADO REAL ===\n' : '=== SIMULACRO (usa --aplicar) ===\n');

  const negocios = await q(`SELECT * FROM negocios`);
  const repartidores = await q(`SELECT * FROM repartidores`);
  const pedidos = await q(`SELECT * FROM pedidos`);
  const productos = await q(`SELECT count(*) c FROM productos`);

  console.log(`negocios:      ${negocios.length}`);
  console.log(`repartidores:  ${repartidores.length}`);
  console.log(`productos:     ${productos[0].c}`);
  console.log(`pedidos:       ${pedidos.length}`);
  console.log('\nLas cuentas de login (usuarios) NO se tocan.');

  if (!APLICAR) { console.log('\n[simulacro] no se borró nada.'); await sequelize.close(); return; }

  const archivo = path.join(__dirname, '..', '..',
    `backup-negocios-perfiles-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(archivo, JSON.stringify({
    generado: new Date().toISOString(), negocios, repartidores, pedidos,
    productos: await q(`SELECT * FROM productos`),
  }, null, 2));
  console.log(`\nRespaldo: ${path.basename(archivo)} (PII — no se commitea)`);

  // ── Storage ───────────────────────────────────────────────
  let borrados = 0;
  const borrar = async (bucket, url) => {
    const ruta = rutaDesde(url);
    if (ruta && await borrarImagen(bucket, ruta)) borrados++;
  };
  for (const n of negocios) {
    for (const c of COLUMNAS_PRIVADAS_NEGOCIO) await borrar(BUCKET_PRIVADO_NEGOCIOS, n[c]);
    for (const c of ['logo', 'foto_portada', 'foto_local']) await borrar(BUCKET_PUBLICO_NEGOCIOS, n[c]);
  }
  for (const r of repartidores) {
    for (const c of COLUMNAS_PRIVADAS_REPARTIDOR) await borrar(BUCKET_PRIVADO_REPARTIDORES, r[c]);
  }
  console.log(`Archivos borrados del Storage: ${borrados}`);

  // ── DB, de las hojas hacia la raíz ────────────────────────
  const pasos = [
    ['perdidas_pedido',     `DELETE FROM perdidas_pedido`],
    ['ledger_conciliacion', `DELETE FROM ledger_conciliacion`],
    ['pedidos',             `DELETE FROM pedidos`],
    ['delivery_batches',    `DELETE FROM delivery_batches`],
    ['fondo_repartidor',    `DELETE FROM fondo_repartidor`],
    ['liquidaciones',       `DELETE FROM liquidaciones`],
    ['platform_revenue',    `DELETE FROM platform_revenue`],
    ['productos',           `DELETE FROM productos`],
    ['negocios',            `DELETE FROM negocios`],
    ['repartidores',        `DELETE FROM repartidores`],
  ];
  for (const [nombre, sql] of pasos) {
    try { await sequelize.query(sql); console.log(`  ✓ ${nombre}`); }
    catch (e) { console.log(`  · ${nombre}: ${e.message.split('\n')[0]}`); }
  }

  // Las cuentas quedan como clientes: su perfil de negocio/repartidor ya no
  // existe, así que dejarlas en modo 'negocio' las mandaría a un panel vacío.
  await sequelize.query(
    `UPDATE usuarios SET modo_activo = 'cliente', rol = CASE WHEN rol = 'admin' THEN 'admin' ELSE 'cliente' END
      WHERE rol <> 'admin' OR modo_activo <> 'admin'`,
  );
  console.log('  ✓ cuentas devueltas a modo cliente (los admins siguen siendo admin)');

  const [n2] = await q('SELECT count(*) c FROM negocios');
  const [r2] = await q('SELECT count(*) c FROM repartidores');
  const [u2] = await q('SELECT count(*) c FROM usuarios');
  console.log(`\nnegocios: ${n2.c} | repartidores: ${r2.c} | cuentas de login intactas: ${u2.c}`);
  await sequelize.close();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
