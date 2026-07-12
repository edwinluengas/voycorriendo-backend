require('dotenv').config();
const { Sequelize, Op } = require('sequelize');

const seq = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST, port: process.env.DB_PORT, dialect: 'postgres',
  dialectOptions: { ssl: { rejectUnauthorized: false } }, logging: false,
});

seq.authenticate().then(async () => {
  const q   = (sql, opts) => seq.query(sql, { type: 'SELECT', ...opts });
  const now = new Date();

  // --- Negocios en revisión → aprobado ---
  const negocios = await q(
    "SELECT id, nombre FROM negocios WHERE verificacion_estado = 'en_revision' ORDER BY enviado_revision_en ASC NULLS LAST"
  );
  console.log(`\nNEGOCIOS a aprobar: ${negocios.length}`);
  for (const n of negocios) {
    await seq.query(
      "UPDATE negocios SET verificacion_estado='aprobado', verificacion_nota=NULL, activo=true, resolucion_en=:now WHERE id=:id",
      { replacements: { now, id: n.id } }
    );
    console.log(`  ✓ ${n.nombre} (${n.id})`);
  }

  // --- Repartidores pendientes → aprobado ---
  const repartidores = await q(
    "SELECT r.id, u.nombre, u.apellido FROM repartidores r JOIN usuarios u ON r.usuario_id = u.id WHERE r.verificacion_estado IN ('pendiente','en_revision') ORDER BY r.enviado_revision_en ASC NULLS LAST"
  );
  console.log(`\nREPARTIDORES a aprobar: ${repartidores.length}`);
  for (const r of repartidores) {
    await seq.query(
      "UPDATE repartidores SET verificacion_estado='aprobado', verificacion_nota=NULL, antecedentes_ok=true, resolucion_en=:now WHERE id=:id",
      { replacements: { now, id: r.id } }
    );
    console.log(`  ✓ ${r.nombre} ${r.apellido} (${r.id})`);
  }

  // --- Pedidos atascados (+30 días en pendiente) → cancelado ---
  const cutoff = new Date(now - 7 * 24 * 60 * 60 * 1000); // más de 7 días
  const pedidos = await q(
    "SELECT id, numero, total FROM pedidos WHERE estado='pendiente' AND creado_en < :cutoff",
    { replacements: { cutoff } }
  );
  console.log(`\nPEDIDOS atascados a cancelar: ${pedidos.length}`);
  for (const p of pedidos) {
    await seq.query(
      "UPDATE pedidos SET estado='cancelado', cancelado_en=:now WHERE id=:id",
      { replacements: { now, id: p.id } }
    );
    console.log(`  ✓ #${p.numero} $${p.total}`);
  }

  // --- Verificación final ---
  console.log('\n--- RESULTADO FINAL ---');
  const [resNeg]  = await seq.query("SELECT verificacion_estado, COUNT(*) total FROM negocios GROUP BY verificacion_estado");
  const [resRep]  = await seq.query("SELECT verificacion_estado, COUNT(*) total FROM repartidores GROUP BY verificacion_estado");
  const [resPed]  = await seq.query("SELECT estado, COUNT(*) total FROM pedidos GROUP BY estado ORDER BY total DESC");
  console.log('Negocios:',     resNeg.map(r => `${r.verificacion_estado}:${r.total}`).join(' | '));
  console.log('Repartidores:', resRep.map(r => `${r.verificacion_estado}:${r.total}`).join(' | '));
  console.log('Pedidos:',      resPed.map(r => `${r.estado}:${r.total}`).join(' | '));

  seq.close();
}).catch(e => { console.error(e.message); process.exit(1); });
