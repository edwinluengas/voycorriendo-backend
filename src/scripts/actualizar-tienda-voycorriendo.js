/**
 * Actualiza la tienda Ahívoy → Tienda VoyCorriendo en la BD existente.
 * Uso: node src/scripts/actualizar-tienda-voycorriendo.js
 */
require('dotenv').config();
const { sequelize } = require('../config/database');
const { Negocio }  = require('../models');

async function actualizar() {
  try {
    await sequelize.authenticate();
    console.log('✅ Conectado a la BD\n');

    const tienda = await Negocio.findOne({ where: { categoria: 'ahivoy store' } });
    if (!tienda) {
      console.log('⚠️  No se encontró ninguna tienda con categoría "ahivoy store".');
      process.exit(0);
    }

    tienda.nombre              = 'Tienda VoyCorriendo';
    tienda.descripcion         = '🛍️ La tienda oficial de VoyCorriendo. Productos seleccionados desde México a tu puerta en Puerto Escondido. Envío 3-5 días por paquetería.';
    tienda.verificacion_estado = 'aprobado';
    tienda.activo              = true;
    tienda.abierto_ahora       = true;
    await tienda.save();

    console.log(`✅ Tienda actualizada: "${tienda.nombre}" (id: ${tienda.id})`);
    console.log('   verificacion_estado:', tienda.verificacion_estado);
    console.log('   activo:', tienda.activo);
    process.exit(0);
  } catch (e) {
    console.error('❌ Error:', e);
    process.exit(1);
  }
}

actualizar();
