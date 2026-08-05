/**
 * Ancla una cuenta a una localidad, sin importar dónde esté el teléfono.
 *
 *   node src/scripts/cuenta-revision.js 0000000002 puerto_escondido
 *   node src/scripts/cuenta-revision.js 0000000002 --quitar
 *   node src/scripts/cuenta-revision.js --listar
 *
 * PARA QUÉ: la app decide qué catálogo mostrar SOLO por GPS. Es lo correcto
 * para un cliente real, y un problema para quien revisa la app en la tienda
 * de aplicaciones: no está en Oaxaca, vería "sin cobertura" y concluiría que
 * la app no funciona. Con esto, la cuenta que se le entrega a Google ve el
 * catálogo de una localidad esté donde esté.
 *
 * NO afecta a nadie más: la columna es nula para todos los usuarios reales.
 * Conviene quitarla cuando la revisión termine.
 */
require('dotenv').config();
const { sequelize } = require('../config/database');
const { Usuario } = require('../models');
const { SLUGS, esValida, nombreDe } = require('../config/ciudades');

(async () => {
  const [arg1, arg2] = process.argv.slice(2);
  try {
    if (!arg1 || arg1 === '--listar') {
      const anclados = await Usuario.findAll({
        where: sequelize.literal('ciudad_fija IS NOT NULL'),
        attributes: ['telefono', 'nombre', 'apellido', 'ciudad_fija'],
      });
      if (!anclados.length) {
        console.log('Ninguna cuenta tiene localidad anclada.');
      } else {
        console.log('Cuentas ancladas:');
        for (const u of anclados) {
          console.log(`  ${u.telefono}  ${u.nombre} ${u.apellido}  → ${nombreDe(u.ciudad_fija)}`);
        }
      }
      if (!arg1) {
        console.log(`\nUso: node src/scripts/cuenta-revision.js <telefono> <${SLUGS.join('|')}>`);
        console.log('     node src/scripts/cuenta-revision.js <telefono> --quitar');
      }
      return;
    }

    const usuario = await Usuario.findOne({ where: { telefono: arg1 } });
    if (!usuario) throw new Error(`No existe una cuenta con el teléfono ${arg1}.`);

    if (arg2 === '--quitar') {
      await usuario.update({ ciudad_fija: null });
      console.log(`✅ ${arg1} vuelve a detectar su localidad por GPS, como todos.`);
      return;
    }

    if (!esValida(arg2)) {
      throw new Error(`"${arg2 || '(vacío)'}" no es una localidad. Válidas: ${SLUGS.join(', ')}`);
    }

    await usuario.update({ ciudad_fija: arg2 });
    console.log(`✅ ${arg1} (${usuario.nombre} ${usuario.apellido}) queda anclada a ${nombreDe(arg2)}.`);
    console.log('   Verá ese catálogo desde cualquier parte del mundo.');
    console.log('   Quitar cuando termine la revisión:');
    console.log(`   node src/scripts/cuenta-revision.js ${arg1} --quitar`);
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
