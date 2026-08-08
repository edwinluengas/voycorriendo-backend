/**
 * Vuelve a vincular los clientes de Mercado Pago que quedaron sueltos.
 *
 *   node src/scripts/resincronizar-clientes-mp.js            (simulación)
 *   node src/scripts/resincronizar-clientes-mp.js --aplicar
 *
 * POR QUÉ: Mercado Pago guarda sus clientes para siempre, del lado de ellos.
 * Nosotros solo anotamos el id en `usuarios.mp_customer_id`. Si esa columna se
 * pierde —una limpieza de datos, recrear una cuenta, borrarse y volver a
 * registrarse— MP se queda con un cliente que nosotros creemos inexistente, y
 * al intentar crear otro con el mismo correo responde "the customer already
 * exist". El síntoma que ve la persona es "verifica los datos o intenta con
 * otra tarjeta", y NINGUNA tarjeta le va a funcionar.
 *
 * `pagos.service.obtenerOCrearCustomerMP` ya se recupera solo de ese caso.
 * Este script repara lo que quedó de antes, sin esperar a que alguien tropiece.
 */
require('dotenv').config();
const axios = require('axios');
const https = require('https');
const { sequelize } = require('../config/database');
const { Usuario } = require('../models');

const APLICAR = process.argv.includes('--aplicar');
const TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const agente = new https.Agent({ rejectUnauthorized: false });

(async () => {
  try {
    if (!TOKEN) throw new Error('Falta MERCADOPAGO_ACCESS_TOKEN.');

    const sueltos = await Usuario.findAll({
      where: sequelize.literal("email IS NOT NULL AND mp_customer_id IS NULL AND estado <> 'eliminado'"),
      attributes: ['id', 'telefono', 'email', 'nombre', 'apellido'],
    });
    console.log(`\n${APLICAR ? '── APLICANDO ──' : '── SIMULACIÓN (sin --aplicar no se cambia nada) ──'}`);
    console.log(`${sueltos.length} cuenta(s) con correo y sin cliente de MP vinculado.\n`);

    let reparados = 0;
    for (const u of sueltos) {
      const r = await axios.get(
        `https://api.mercadopago.com/v1/customers/search?email=${encodeURIComponent(u.email)}`,
        { headers: { Authorization: `Bearer ${TOKEN}` }, httpsAgent: agente, validateStatus: () => true },
      );
      const encontrado = (r.data?.results || [])[0];
      if (!encontrado) {
        console.log(`   ${u.telefono.padEnd(12)} ${u.email.padEnd(38)} sin cliente en MP (nada que reparar)`);
        continue;
      }
      const tarjetas = (encontrado.cards || []).length;
      console.log(`   ${u.telefono.padEnd(12)} ${u.email.padEnd(38)} → ${encontrado.id}  (${tarjetas} tarjeta[s])`);
      if (APLICAR) {
        await u.update({ mp_customer_id: encontrado.id });
        reparados++;
      }
    }

    if (APLICAR) {
      console.log(`\n✅ ${reparados} vínculo(s) restaurado(s).`);
    } else {
      console.log('\n(simulación — vuelve a correr con --aplicar para repararlos)');
    }
  } catch (e) {
    console.error('ERROR:', e.response?.data ? JSON.stringify(e.response.data) : e.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
