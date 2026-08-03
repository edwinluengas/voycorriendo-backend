/**
 * Borra TODOS los pedidos y su contabilidad para volver a probar desde cero.
 * Respalda a JSON antes de borrar. Deja consistentes las cifras derivadas:
 * deudas de negocios, fondos de repartidores y rutas abiertas.
 *
 * NO toca cuentas, negocios, productos ni créditos otorgados.
 * Correr con --confirmar.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sequelize } = require('../config/database');

(async () => {
  const q = (s) => sequelize.query(s, { type: sequelize.QueryTypes.SELECT });

  const pedidos  = await q('SELECT * FROM pedidos');
  const ledger   = await q('SELECT * FROM ledger_conciliacion');
  const revenue  = await q('SELECT * FROM platform_revenue');
  const batches  = await q('SELECT * FROM delivery_batches');
  const perdidas = await q('SELECT * FROM perdidas_pedido');
  const negocios = await q('SELECT id, nombre, deuda_plataforma, pedidos_efectivo_pendientes, bloqueado_por_deuda FROM negocios WHERE deuda_plataforma > 0 OR pedidos_efectivo_pendientes > 0');
  const fondos   = await q('SELECT * FROM fondo_repartidor');

  console.log('A borrar:');
  console.log(`  pedidos: ${pedidos.length} | ledger: ${ledger.length} | platform_revenue: ${revenue.length}`);
  console.log(`  rutas: ${batches.length} | pérdidas: ${perdidas.length}`);
  console.log(`A resetear: ${negocios.length} negocio(s) con deuda, ${fondos.length} fondo(s) de repartidor`);
  if (pedidos.length) {
    const porEstado = pedidos.reduce((a, p) => ({ ...a, [p.estado]: (a[p.estado] || 0) + 1 }), {});
    console.log('  por estado:', porEstado);
  }

  if (!process.argv.includes('--confirmar')) {
    console.log('\n(simulación — sin --confirmar no se borra nada)');
    await sequelize.close();
    return;
  }

  // El nombre lleva la HORA, no solo el día: con solo la fecha, correr el
  // script dos veces el mismo día pisaba el respaldo bueno con uno del
  // estado ya vacío — y con él, el único registro de lo borrado.
  const sello = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const archivo = path.join(__dirname, '..', '..', `backup-pedidos-${sello}.json`);
  fs.writeFileSync(archivo, JSON.stringify({
    generado_en: new Date().toISOString(),
    pedidos, ledger, revenue, batches, perdidas, negocios, fondos,
  }, null, 2));
  console.log(`\nRESPALDO → ${path.basename(archivo)}`);

  const t = await sequelize.transaction();
  try {
    const exec = (s) => sequelize.query(s, { transaction: t });
    await exec('DELETE FROM perdidas_pedido');
    await exec('DELETE FROM ledger_conciliacion');
    await exec('DELETE FROM platform_revenue');
    await exec('DELETE FROM delivery_batches');
    await exec('DELETE FROM pedidos');
    // Cifras derivadas: sin pedidos, la única deuda y el único fondo
    // correctos son cero. Dejarlos con saldo bloquearía negocios por una
    // deuda de pedidos que ya no existen.
    await exec(`UPDATE negocios SET deuda_plataforma = 0, pedidos_efectivo_pendientes = 0, bloqueado_por_deuda = false`);
    await exec(`UPDATE fondo_repartidor SET monto_disponible = 0, monto_reservado = 0,
                  retiro_pendiente = false, monto_pendiente_confirmar = 0, saldo_por_cobrar = 0`);
    // Contadores de reputación. También salen de los pedidos borrados: sin
    // esto un negocio seguía anunciando "33 pedidos" y una calificación con
    // la base en cero — números que el catálogo público muestra al cliente
    // y que ya no respaldaba ningún pedido real.
    await exec(`UPDATE negocios SET total_pedidos = 0, calificacion_promedio = 0,
                  tasa_cancelacion = 0, tiempo_prep_promedio_min = 0, quejas_30d = 0`);
    await exec(`UPDATE repartidores SET total_entregas = 0, calificacion_promedio = 0,
                  ganancias_totales = 0, tasa_cancelacion = 0, tasa_aceptacion = 0`);
    await t.commit();
  } catch (e) {
    await t.rollback();
    console.error('❌ Rollback —', e.message);
    process.exit(1);
  }

  console.log('\nEstado final:');
  console.log('  pedidos:', (await q('SELECT COUNT(*)::int c FROM pedidos'))[0].c);
  console.log('  ledger :', (await q('SELECT COUNT(*)::int c FROM ledger_conciliacion'))[0].c);
  console.log('  rutas  :', (await q('SELECT COUNT(*)::int c FROM delivery_batches'))[0].c);
  console.log('  negocios con deuda:', (await q('SELECT COUNT(*)::int c FROM negocios WHERE deuda_plataforma > 0'))[0].c);
  console.log('  fondos con saldo  :', (await q('SELECT COUNT(*)::int c FROM fondo_repartidor WHERE monto_disponible > 0'))[0].c);
  console.log('  negocios activos  :', (await q(`SELECT COUNT(*)::int c FROM negocios WHERE activo = true`))[0].c);
  console.log('  clientes          :', (await q(`SELECT COUNT(*)::int c FROM usuarios`))[0].c);
  await sequelize.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
