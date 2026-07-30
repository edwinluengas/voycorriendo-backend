/**
 * Verifica que la estructura de teléfonos por país COINCIDA entre:
 *   - backend  src/utils/telefono.js         (RANGOS)
 *   - app      src/components/CampoTelefono.js (PAISES[].dig)
 *
 * Si no coinciden, el cliente teclea un número que la app acepta y el
 * servidor rechaza (o al revés): el campo se ve válido y el registro falla
 * sin explicación clara. Correr después de tocar cualquiera de las dos listas.
 */
const fs = require('fs');
const path = require('path');
const { RANGOS, RANGO_DEFAULT, normalizarTelefono, telefonoValido, aE164 } = require('../utils/telefono');

const RUTA_APP = process.env.RUTA_APP
  || path.join(__dirname, '..', '..', '..', 'voycorriendo-app', 'src', 'components', 'CampoTelefono.js');

// Extrae las filas { iso, lada, nombre, dig } del archivo de la app sin
// ejecutarlo (importa react-native, no se puede requerir desde aquí).
const leerPaisesApp = () => {
  const src = fs.readFileSync(RUTA_APP, 'utf8');
  const filas = [];
  const re = /iso:\s*'([A-Z]{2})'\s*,\s*lada:\s*'(\d+)'[^}]*?nombre:\s*'([^']+)'[^}]*?dig:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    filas.push({ iso: m[1], lada: m[2], nombre: m[3], dig: [Number(m[4]), Number(m[5])] });
  }
  return filas;
};

const paises = leerPaisesApp();
let problemas = 0;

console.log(`Países en la app: ${paises.length}\n`);
console.log('país            lada   app        backend    ¿coincide?');
console.log('─'.repeat(64));

for (const p of paises) {
  const backend = RANGOS[p.lada];
  const usaDefault = !backend;
  const rango = backend || RANGO_DEFAULT;
  const coincide = rango[0] === p.dig[0] && rango[1] === p.dig[1];
  if (!coincide) problemas++;
  console.log(
    `${(p.nombre + ' (' + p.iso + ')').padEnd(24).slice(0, 24)}+${p.lada.padEnd(4)} `
    + `[${p.dig[0]}-${p.dig[1]}]`.padEnd(11)
    + `[${rango[0]}-${rango[1]}]${usaDefault ? '*' : ''}`.padEnd(11)
    + (coincide ? '✅' : '❌ DESALINEADO'),
  );
}

// Ladas declaradas en el backend que la app no ofrece: no es un error (el
// backend puede aceptar más países de los que la app lista), solo se informa.
const ladasApp = new Set(paises.map((p) => p.lada));
const soloBackend = Object.keys(RANGOS).filter((l) => !ladasApp.has(l));
if (soloBackend.length) {
  console.log(`\nLadas que el backend valida pero la app no ofrece: ${soloBackend.map((l) => '+' + l).join(', ')}`);
  console.log('(no es problema: la app solo muestra los países con presencia real en Puerto)');
}
console.log('\n* = el backend no tiene regla específica y usa el rango genérico');

// ── Prueba funcional: un número típico de cada país debe pasar ──
console.log('\nPrueba funcional (número de largo mínimo y máximo por país):');
let fallosFuncionales = 0;
for (const p of paises) {
  for (const largo of [p.dig[0], p.dig[1]]) {
    // Se evita empezar con 0 (se interpretaría como cero troncal) y con la
    // propia lada (se recortaría como prefijo internacional repetido).
    const numero = '9'.repeat(largo);
    const n = normalizarTelefono(numero, p.lada);
    const v = telefonoValido(n);
    if (!v.ok || n.telefono.length !== largo) {
      fallosFuncionales++;
      console.log(`  ❌ ${p.nombre} +${p.lada} con ${largo} dígitos → ${aE164(n)} · ${v.mensaje || 'se alteró el número'}`);
    }
  }
}
if (fallosFuncionales === 0) console.log('  ✅ Todos los países aceptan sus largos mínimo y máximo sin alterar el número.');

console.log(`\n${problemas === 0 && fallosFuncionales === 0
  ? '✅ App y backend están alineados.'
  : `❌ ${problemas} país(es) desalineado(s) y ${fallosFuncionales} fallo(s) funcional(es).`}`);
process.exit(problemas === 0 && fallosFuncionales === 0 ? 0 : 1);
