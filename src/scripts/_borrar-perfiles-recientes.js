/**
 * Borrado selectivo de perfiles de prueba creados ayer/hoy.
 * CONSERVA la cuenta del dueño (5545074460) con su negocio y perfil repartidor.
 * Hace respaldo JSON completo antes de borrar. Ejecutar con --confirmar.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sequelize } = require('../config/database');

const CONSERVAR_TELEFONOS = ['5545074460', '0000000001', '0000000002', '0000000003', '0000000004'];

(async () => {
  const q = (sql, repl) => sequelize.query(sql, { type: sequelize.QueryTypes.SELECT, replacements: repl });
  const exec = (sql, repl, t) => sequelize.query(sql, { replacements: repl, transaction: t });

  const desde = `(NOW() AT TIME ZONE 'America/Mexico_City')::date - INTERVAL '1 day'`;

  const usuarios = await q(
    `SELECT * FROM usuarios WHERE creado_en >= ${desde} AND telefono NOT IN (:conservar)`,
    { conservar: CONSERVAR_TELEFONOS },
  );
  if (!usuarios.length) { console.log('Nada que borrar.'); await sequelize.close(); return; }

  const ids = usuarios.map((u) => u.id);
  const negocios     = await q(`SELECT * FROM negocios      WHERE usuario_id IN (:ids)`, { ids });
  const repartidores = await q(`SELECT * FROM repartidores  WHERE usuario_id IN (:ids)`, { ids });
  const negIds = negocios.map((n) => n.id);
  const repIds = repartidores.map((r) => r.id);

  const pedidos = await q(
    `SELECT * FROM pedidos WHERE cliente_id IN (:ids)
       ${negIds.length ? 'OR negocio_id IN (:negIds)' : ''}
       ${repIds.length ? 'OR repartidor_id IN (:repIds)' : ''}`,
    { ids, negIds: negIds.length ? negIds : [null], repIds: repIds.length ? repIds : [null] },
  );
  const pedIds = pedidos.map((p) => p.id);

  const productos  = negIds.length ? await q(`SELECT * FROM productos WHERE negocio_id IN (:negIds)`, { negIds }) : [];
  const creditos   = await q(`SELECT * FROM creditos_cliente WHERE usuario_id IN (:ids)`, { ids });
  const tarjetas   = await q(`SELECT * FROM tarjetas_guardadas WHERE usuario_id IN (:ids)`, { ids });
  const fondos     = repIds.length ? await q(`SELECT * FROM fondo_repartidor WHERE repartidor_id IN (:repIds)`, { repIds }) : [];
  const batches    = repIds.length ? await q(`SELECT * FROM delivery_batches WHERE driver_id IN (:repIds)`, { repIds }) : [];
  const ledger     = pedIds.length ? await q(`SELECT * FROM ledger_conciliacion WHERE pedido_id IN (:pedIds)`, { pedIds }) : [];
  const revenue    = pedIds.length ? await q(`SELECT * FROM platform_revenue   WHERE order_id  IN (:pedIds)`, { pedIds }) : [];
  const perdidas   = pedIds.length ? await q(`SELECT * FROM perdidas_pedido    WHERE pedido_id IN (:pedIds)`, { pedIds }) : [];

  const respaldo = {
    generado_en: new Date().toISOString(),
    conservados: CONSERVAR_TELEFONOS,
    usuarios, negocios, repartidores, pedidos, productos, creditos, tarjetas,
    fondos, batches, ledger, revenue, perdidas,
  };
  const archivo = path.join(__dirname, '..', '..', `backup-borrado-perfiles-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(archivo, JSON.stringify(respaldo, null, 2));

  console.log('RESPALDO →', archivo);
  console.log('Usuarios a borrar:');
  usuarios.forEach((u) => console.log(`  ${u.telefono} | ${u.nombre} ${u.apellido || ''} | rol=${u.rol}`));
  console.log(`Negocios: ${negocios.length} | Repartidores: ${repartidores.length} | Pedidos: ${pedidos.length} | Productos: ${productos.length}`);
  console.log(`Créditos: ${creditos.length} | Tarjetas: ${tarjetas.length} | Fondos: ${fondos.length} | Batches: ${batches.length} | Ledger: ${ledger.length} | Pérdidas: ${perdidas.length}`);

  if (!process.argv.includes('--confirmar')) {
    console.log('\n(simulación — sin --confirmar no se borra nada)');
    await sequelize.close();
    return;
  }

  // Negocios CONSERVADOS que pierden pedidos en efectivo ya entregados: su
  // deuda_plataforma quedaría contando pedidos que ya no existen. Se recalcula
  // a cero (son datos de prueba, no hay liquidación real que respetar).
  const negociosAAjustar = [...new Set(
    pedidos.filter((p) => p.metodo_pago === 'efectivo' && p.estado === 'entregado' && !negIds.includes(p.negocio_id))
      .map((p) => p.negocio_id),
  )];

  const t = await sequelize.transaction();
  try {
    if (pedIds.length) {
      await exec(`DELETE FROM perdidas_pedido     WHERE pedido_id IN (:pedIds)`, { pedIds }, t);
      await exec(`DELETE FROM ledger_conciliacion WHERE pedido_id IN (:pedIds)`, { pedIds }, t);
      await exec(`DELETE FROM platform_revenue    WHERE order_id  IN (:pedIds)`, { pedIds }, t);
      await exec(`DELETE FROM pedidos             WHERE id        IN (:pedIds)`, { pedIds }, t);
    }
    if (repIds.length) {
      await exec(`DELETE FROM delivery_batches   WHERE driver_id     IN (:repIds)`, { repIds }, t);
      await exec(`DELETE FROM fondo_repartidor   WHERE repartidor_id IN (:repIds)`, { repIds }, t);
      await exec(`DELETE FROM driver_payments    WHERE driver_id     IN (:repIds)`, { repIds }, t);
      await exec(`DELETE FROM repartidores       WHERE id            IN (:repIds)`, { repIds }, t);
    }
    if (negIds.length) {
      await exec(`DELETE FROM productos          WHERE negocio_id IN (:negIds)`, { negIds }, t);
      await exec(`DELETE FROM negocios           WHERE id         IN (:negIds)`, { negIds }, t);
    }
    await exec(`DELETE FROM creditos_cliente   WHERE usuario_id IN (:ids)`, { ids }, t);
    await exec(`DELETE FROM tarjetas_guardadas WHERE usuario_id IN (:ids)`, { ids }, t);
    await exec(`DELETE FROM audit_logs         WHERE admin_id   IN (:ids)`, { ids }, t);
    await exec(`DELETE FROM usuarios           WHERE id         IN (:ids)`, { ids }, t);
    if (negociosAAjustar.length) {
      await exec(
        `UPDATE negocios SET deuda_plataforma = 0, pedidos_efectivo_pendientes = 0, bloqueado_por_deuda = false
          WHERE id IN (:negociosAAjustar)`, { negociosAAjustar }, t);
      console.log(`Deuda reseteada en ${negociosAAjustar.length} negocio(s) conservado(s).`);
    }
    await t.commit();
    console.log('\n✅ Borrado completado.');
  } catch (e) {
    await t.rollback();
    console.error('❌ Rollback —', e.message);
    process.exitCode = 1;
  }
  await sequelize.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
