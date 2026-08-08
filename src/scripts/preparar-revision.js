/**
 * Deja la app lista para que la revise la tienda de aplicaciones.
 *
 *   node src/scripts/preparar-revision.js            (simulación)
 *   node src/scripts/preparar-revision.js --aplicar
 *   node src/scripts/preparar-revision.js --revertir  (quita el anclaje)
 *
 * POR QUÉ EXISTE: quien revisa la app no está en Oaxaca. Con la detección
 * normal por GPS vería "Sin cobertura en este lugar", cero catálogo, y
 * concluiría que la app no funciona. Además, un catálogo sin fotos y con un
 * restaurante vacío se lee como una app a medio terminar — motivo de rechazo
 * por "funcionalidad mínima".
 *
 * Lo que hace:
 *   1. Ancla las cuentas de revisión (cliente y repartidor) a una localidad,
 *      para que vean el catálogo y puedan conectarse desde donde estén.
 *   2. Da de alta productos en los negocios que estén vacíos.
 *   3. Pone fotos donde falten: portada y foto oficial del negocio, e imagen
 *      de cada producto.
 *
 * SOBRE LAS FOTOS: son imágenes generadas con el color de la marca y el
 * nombre del platillo. NO son fotos de comida de banco de imágenes, a
 * propósito: una foto profesional de unos tacos que no son los del negocio
 * le promete al cliente algo que no va a recibir, y las licencias de esas
 * fotos rara vez permiten uso comercial. Estas son honestas —se ven como lo
 * que son— y cada negocio debe reemplazarlas por las suyas desde
 * Negocio → Fotos. El script NUNCA pisa una foto que ya exista.
 */
require('dotenv').config();
const axios = require('axios');
const https = require('https');
const { sequelize } = require('../config/database');
const { Usuario, Negocio, Producto } = require('../models');
const { subirImagen } = require('../services/storage.service');
const { BUCKET_PUBLICO_NEGOCIOS } = require('../config/buckets');
const { esValida, nombreDe } = require('../config/ciudades');

const APLICAR  = process.argv.includes('--aplicar');
const REVERTIR = process.argv.includes('--revertir');
const PLAZA    = process.argv.find((a) => esValida(a)) || 'puerto_escondido';

// Las cuentas que se le entregan a quien revisa.
const CUENTAS_REVISION = ['0000000002', '0000000004'];   // cliente y repartidor

const agente = new https.Agent({ rejectUnauthorized: false });

// Paleta de la marca. Se alterna para que el catálogo no se vea monótono.
const COLORES = ['FF5C00', 'CC4900', 'FF8533', '1C1C1E', '00B341'];

const generarImagen = async (texto, ancho, alto, i = 0) => {
  const fondo = COLORES[i % COLORES.length];
  const url = `https://placehold.co/${ancho}x${alto}/${fondo}/FFFFFF/jpeg`
            + `?text=${encodeURIComponent(texto)}`;
  const r = await axios.get(url, { httpsAgent: agente, responseType: 'arraybuffer', timeout: 30000 });
  const buf = Buffer.from(r.data);
  if (buf.slice(0, 3).toString('hex') !== 'ffd8ff') throw new Error('lo devuelto no es un JPEG');
  return buf.toString('base64');
};

// Menú por categoría, con precios que superan el pedido mínimo.
const MENU = {
  restaurante: [
    { nombre: 'Coctel de camarón',   precio: 165, categoria: 'Mariscos', descripcion: 'Camarón fresco, pico de gallo y aguacate.' },
    { nombre: 'Pescado a la talla',  precio: 220, categoria: 'Mariscos', descripcion: 'Al carbón, con arroz y ensalada.' },
    { nombre: 'Tostada de ceviche',  precio: 75,  categoria: 'Mariscos', descripcion: 'De la pesca del día.' },
    { nombre: 'Agua de horchata 1L', precio: 45,  categoria: 'Bebidas',  descripcion: 'Hecha en casa.' },
  ],
  otro: [
    { nombre: 'Comida corrida',      precio: 95,  categoria: 'Comida',  descripcion: 'Sopa, guisado del día, arroz y tortillas.' },
    { nombre: 'Orden para compartir', precio: 180, categoria: 'Comida', descripcion: 'Rinde para dos personas.' },
    { nombre: 'Agua fresca 1L',      precio: 40,  categoria: 'Bebidas', descripcion: 'Del sabor del día.' },
  ],
};

(async () => {
  try {
    // ─── Revertir ──────────────────────────────────────────────────
    if (REVERTIR) {
      const [, meta] = await sequelize.query(
        `UPDATE usuarios SET ciudad_fija = NULL WHERE ciudad_fija IS NOT NULL`);
      console.log(`✅ Anclaje quitado (${meta.rowCount || 0} cuenta[s]). Todas vuelven a detectar su localidad por GPS.`);
      console.log('   Las fotos y productos NO se tocan: son datos legítimos del catálogo.');
      return;
    }

    console.log(`\n${APLICAR ? '── APLICANDO ──' : '── SIMULACIÓN (sin --aplicar no se cambia nada) ──'}`);
    console.log(`Localidad de revisión: ${nombreDe(PLAZA)}\n`);

    // ─── 1. Cuentas de revisión ────────────────────────────────────
    console.log('1. CUENTAS DE REVISIÓN');
    for (const tel of CUENTAS_REVISION) {
      const u = await Usuario.findOne({ where: { telefono: tel } });
      if (!u) { console.log(`   ⚠️  ${tel} no existe`); continue; }
      const yaEsta = u.ciudad_fija === PLAZA;
      console.log(`   ${tel}  ${u.nombre} ${u.apellido}  ${yaEsta ? '(ya anclada)' : '→ anclar a ' + nombreDe(PLAZA)}`);
      if (APLICAR && !yaEsta) await u.update({ ciudad_fija: PLAZA });
    }

    // ─── 2. Productos donde falten ─────────────────────────────────
    console.log('\n2. NEGOCIOS SIN PRODUCTOS');
    const negocios = await Negocio.findAll({ where: { ciudad: PLAZA } });
    for (const n of negocios) {
      const cuantos = await Producto.count({ where: { negocio_id: n.id } });
      if (cuantos > 0) { console.log(`   ${n.nombre} — ya tiene ${cuantos}`); continue; }
      const menu = MENU[n.categoria] || MENU.otro;
      console.log(`   ${n.nombre} — VACÍO → dar de alta ${menu.length} productos`);
      if (!APLICAR) continue;
      for (const p of menu) {
        await Producto.findOrCreate({
          where: { negocio_id: n.id, nombre: p.nombre },
          defaults: { ...p, negocio_id: n.id, disponible: true },
        });
      }
    }

    // ─── 3. Fotos donde falten ─────────────────────────────────────
    console.log('\n3. FOTOS QUE FALTAN');
    let i = 0;
    for (const n of await Negocio.findAll({ where: { ciudad: PLAZA } })) {
      const faltan = [];
      if (!n.foto_portada) faltan.push('portada');
      if (!n.logo) faltan.push('foto oficial');
      if (faltan.length === 0) {
        console.log(`   ${n.nombre} — ya tiene sus fotos (no se toca)`);
      } else {
        console.log(`   ${n.nombre} — falta: ${faltan.join(', ')}`);
        if (APLICAR) {
          if (!n.foto_portada) {
            const b64 = await generarImagen(n.nombre, 1200, 800, i);
            n.foto_portada = await subirImagen(BUCKET_PUBLICO_NEGOCIOS,
              `negocios/${n.id}/portada_${Date.now()}.jpg`, b64, 'image/jpeg');
          }
          if (!n.logo) {
            // Iniciales, que es lo que cabe legible en un círculo chico.
            const iniciales = n.nombre.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
            const b64 = await generarImagen(iniciales, 600, 600, i + 1);
            n.logo = await subirImagen(BUCKET_PUBLICO_NEGOCIOS,
              `negocios/${n.id}/logo_${Date.now()}.jpg`, b64, 'image/jpeg');
          }
          await n.save();
        }
      }
      i += 2;

      const productos = await Producto.findAll({ where: { negocio_id: n.id } });
      const sinFoto = productos.filter((p) => !p.imagen);
      if (sinFoto.length) {
        console.log(`      ${sinFoto.length}/${productos.length} productos sin foto`);
        if (APLICAR) {
          for (const p of sinFoto) {
            const b64 = await generarImagen(p.nombre, 800, 600, i++);
            p.imagen = await subirImagen(BUCKET_PUBLICO_NEGOCIOS,
              `negocios/${n.id}/productos/${p.id}_${Date.now()}.jpg`, b64, 'image/jpeg');
            await p.save();
          }
        }
      }
    }

    if (!APLICAR) {
      console.log('\n(simulación — vuelve a correr con --aplicar para hacerlo)');
    } else {
      console.log('\n✅ Listo. Credenciales para el formulario de revisión:');
      console.log('   Cliente:    0000000002 / VoyTest2026!');
      console.log('   Repartidor: 0000000004 / VoyTest2026!');
      console.log('\n   Al terminar la revisión, quitar el anclaje:');
      console.log('   node src/scripts/preparar-revision.js --revertir');
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
