/**
 * Normalización de teléfonos internacionales — VoyCorriendo
 * ------------------------------------------------------------------
 * Puerto Escondido recibe mucho turismo extranjero, así que el número deja
 * de ser "10 dígitos mexicanos": se guarda como (lada, telefono nacional) y
 * se marca en formato E.164 (+<lada><nacional>).
 *
 * Reglas:
 *  - `lada` son solo dígitos, 1 a 4 (52 México, 1 EUA/Canadá, 34 España…).
 *  - `telefono` es el número NACIONAL, sin lada, sin ceros troncales.
 *  - Si no viene lada, se asume México ('52') — así las cuentas y los
 *    clientes viejos (y los APK ya instalados, que no mandan el campo)
 *    siguen funcionando exactamente igual.
 */

const LADA_DEFAULT = '52';
const PAIS_DEFAULT = 'MX';

const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');

// Quita el '+', la lada si el usuario la volvió a escribir, y los ceros
// troncales que se usan al marcar dentro de varios países (0 en AR/IT/GB,
// 1 largo en MX viejo).
//
// CLAVE: solo se recorta cuando el número quedó MÁS LARGO de lo que ese país
// permite. Un `replace(/^0+/, '')` a ciegas convertía "0000000001" (las
// cuentas de prueba internas) en "1" y dejaba fuera a cualquier usuario cuyo
// número guardado empiece con cero. Si ya cabe en el rango del país, se
// respeta tal cual.
const normalizarTelefono = (telefonoCrudo, ladaCruda) => {
  const lada = soloDigitos(ladaCruda) || LADA_DEFAULT;
  let tel = soloDigitos(telefonoCrudo);
  const [, max] = RANGOS[lada] || RANGO_DEFAULT;

  // Se alternan las dos limpiezas hasta que el número quepa: hay gente que
  // escribe el prefijo internacional completo ("00 44 7911…"), así que el
  // cero troncal y la lada pueden venir intercalados. El tope de 4 vueltas
  // evita cualquier ciclo infinito.
  for (let i = 0; i < 4 && tel.length > max; i++) {
    // "+52 954 123 4567" escrito completo en el campo del número
    if (tel.startsWith(lada) && tel.length - lada.length >= 6) { tel = tel.slice(lada.length); continue; }
    // Ceros troncales al inicio (0 en Francia, Italia, Reino Unido, Argentina…)
    if (tel.startsWith('0')) { tel = tel.slice(1); continue; }
    break;
  }
  // México: el "1" que se marcaba antes para celular ya no forma parte del número
  if (lada === '52' && tel.length === 11 && tel.startsWith('1')) tel = tel.slice(1);

  return { lada, telefono: tel };
};

// Longitudes reales por país (mínimo/máximo del número NACIONAL).
// El default cubre el resto del mundo sin bloquear a nadie.
const RANGOS = {
  '52': [10, 10],   // México
  '1':  [10, 10],   // EUA / Canadá
  '34': [9, 9],     // España
  '33': [9, 9],     // Francia
  '39': [6, 11],    // Italia
  '49': [6, 12],    // Alemania
  '44': [9, 10],    // Reino Unido
  '31': [9, 9],     // Países Bajos
  '41': [9, 9],     // Suiza
  '43': [7, 13],    // Austria
  '46': [7, 13],    // Suecia
  '47': [8, 8],     // Noruega
  '45': [8, 8],     // Dinamarca
  '55': [10, 11],   // Brasil
  '54': [10, 11],   // Argentina
  '57': [10, 10],   // Colombia
  '56': [9, 9],     // Chile
  '51': [9, 9],     // Perú
  '61': [9, 9],     // Australia
  '64': [8, 10],    // Nueva Zelanda
  '81': [10, 11],   // Japón
  '82': [9, 11],    // Corea del Sur
  '972': [9, 9],    // Israel
};
const RANGO_DEFAULT = [6, 15];

const telefonoValido = ({ lada, telefono }) => {
  if (!/^\d{1,4}$/.test(lada || '')) return { ok: false, mensaje: 'El código de país no es válido.' };
  const [min, max] = RANGOS[lada] || RANGO_DEFAULT;
  if (!/^\d+$/.test(telefono || '')) return { ok: false, mensaje: 'El número solo puede tener dígitos.' };
  if (telefono.length < min || telefono.length > max) {
    return {
      ok: false,
      mensaje: min === max
        ? `Para +${lada} el número debe tener ${min} dígitos (escribiste ${telefono.length}).`
        : `Para +${lada} el número debe tener entre ${min} y ${max} dígitos (escribiste ${telefono.length}).`,
    };
  }
  return { ok: true };
};

// Formato E.164 para Twilio / WhatsApp
const aE164 = ({ lada, telefono }) => `+${soloDigitos(lada) || LADA_DEFAULT}${soloDigitos(telefono)}`;

// Para logs: nunca imprimir el número completo (PII)
const enmascarar = ({ lada, telefono }) => `+${lada}***${String(telefono || '').slice(-4)}`;

module.exports = {
  LADA_DEFAULT, PAIS_DEFAULT, RANGOS, RANGO_DEFAULT,
  normalizarTelefono, telefonoValido, aE164, enmascarar, soloDigitos,
};
