/**
 * limpiar-test.js
 * Resetea el entorno de pruebas a cero:
 *   - Cancela todos los pedidos no finales (pendiente, confirmado, preparando, listo, en_camino, en_envio)
 *   - Vacía fondo_repartidor de cuentas de test
 *   - Limpia ledger_conciliacion de pedidos cancelados
 *   - Muestra resumen de estado final
 *
 * Uso: node src/scripts/limpiar-test.js
 */
require('dotenv').config();

const { conectarDB, sequelize } = require('../config/database');

const ESTADOS_FINALES = ['entregado', 'cancelado', 'rechazado'];
const TELEFONOS_TEST  = ['0000000001', '0000000002', '0000000003', '0000000004'];

async function main() {
  await conectarDB();

  // 1. Cancelar pedidos no finales
  const [cancelados] = await sequelize.query(`
    UPDATE pedidos
    SET estado = 'cancelado', cancelado_en = NOW()
    WHERE estado NOT IN ('entregado', 'cancelado', 'rechazado')
    RETURNING id, numero, estado
  `);
  console.log(`\n✅ Pedidos cancelados: ${cancelados.length}`);
  cancelados.forEach((p) => console.log(`   #${p.numero} (era: ${p.estado})`));

  // 2. Limpiar batches activos
  const [batches] = await sequelize.query(`
    UPDATE delivery_batches SET status = 'completed' WHERE status = 'active'
    RETURNING id
  `);
  console.log(`✅ Batches cerrados: ${batches.length}`);

  // 3. Desconectar repartidores activos
  await sequelize.query(`
    UPDATE repartidores SET conectado = false, disponible = false WHERE conectado = true
  `);
  console.log('✅ Repartidores desconectados');

  // 4. Vaciar fondo_repartidor de cuentas test
  const telefonosSQL = TELEFONOS_TEST.map((t) => `'${t}'`).join(', ');
  const [fondos] = await sequelize.query(`
    UPDATE fondo_repartidor fr
    SET monto_disponible = 0, monto_reservado = 0
    FROM repartidores r
    JOIN usuarios u ON u.id = r.usuario_id
    WHERE r.id = fr.repartidor_id
      AND u.telefono IN (${telefonosSQL})
    RETURNING fr.id
  `);
  console.log(`✅ Fondos de test reseteados: ${fondos.length}`);

  // 5. Reset tokens VoyTokens de cuentas test (a 13 para la cuenta cliente test)
  await sequelize.query(`
    UPDATE usuarios SET voytokens = CASE telefono WHEN '0000000002' THEN 13 ELSE 0 END
    WHERE telefono IN (${telefonosSQL})
  `);
  console.log('✅ VoyTokens de cuentas test reseteados');

  // 6. Resumen del estado actual
  const [[{ total_pedidos }]] = await sequelize.query(
    `SELECT COUNT(*) as total_pedidos FROM pedidos WHERE estado NOT IN ('cancelado', 'rechazado')`
  );
  const [[{ usuarios_activos }]] = await sequelize.query(
    `SELECT COUNT(*) as usuarios_activos FROM usuarios WHERE estado = 'activo'`
  );
  const [[{ negocios_activos }]] = await sequelize.query(
    `SELECT COUNT(*) as negocios_activos FROM negocios WHERE activo = true AND verificacion_estado = 'aprobado'`
  );

  console.log('\n─── Estado final ───────────────────────');
  console.log(`   Pedidos activos restantes: ${total_pedidos}`);
  console.log(`   Usuarios activos:          ${usuarios_activos}`);
  console.log(`   Negocios aprobados:        ${negocios_activos}`);
  console.log('────────────────────────────────────────\n');
  console.log('Listo para testear de cero ✅\n');

  process.exit(0);
}

main().catch((e) => {
  console.error('Error al limpiar:', e.message);
  process.exit(1);
});
