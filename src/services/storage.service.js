/**
 * Servicio de subida de archivos a Supabase Storage.
 *
 * Usa la REST API de Supabase Storage en lugar del SDK para no
 * agregar dependencias nuevas (ya tenemos axios).
 *
 * Variables de entorno requeridas en Railway:
 *   SUPABASE_URL                = https://uxchuyfwxhkpjykbgahy.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   = eyJ... (service_role, NO el anon)
 *
 * Buckets esperados (crearlos en Supabase con read publico):
 *   - documentos-repartidores  (INE, licencia, tarjeta de circulacion)
 *   - documentos-negocios      (acta constitutiva, RFC, etc.)
 *   - fotos-perfil             (avatares de usuarios)
 *   - fotos-productos          (catalogo de cada negocio)
 */
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const validarConfig = () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      'Storage no configurado. Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en variables de entorno.'
    );
  }
};

/**
 * Sube una imagen base64 a Supabase Storage.
 *
 * @param {string} bucket  Nombre del bucket (ej. 'documentos-repartidores')
 * @param {string} ruta    Ruta dentro del bucket (ej. 'repartidores/uuid/ine_frente_123.jpg')
 * @param {string} base64  Contenido en base64 (con o sin prefijo data:)
 * @param {string} mime    MIME type (ej. 'image/jpeg', 'image/png')
 * @returns {Promise<string>} URL publica del archivo subido
 */
const subirImagen = async (bucket, ruta, base64, mime) => {
  validarConfig();

  // Limpiamos el prefijo data: por si llega "data:image/jpeg;base64,..."
  const limpio = base64.includes(',') ? base64.split(',')[1] : base64;
  const buffer = Buffer.from(limpio, 'base64');

  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${ruta}`;

  try {
    await axios.post(url, buffer, {
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': mime || 'image/jpeg',
        'x-upsert': 'true',
        'Cache-Control': '3600',
      },
      maxContentLength: 10 * 1024 * 1024, // 10 MB
      maxBodyLength: 10 * 1024 * 1024,
    });
  } catch (e) {
    const detalle = e.response?.data?.message || e.response?.data?.error || e.message;
    console.error('Storage error:', detalle, '| status:', e.response?.status);
    throw new Error(`No se pudo subir el archivo: ${detalle}`);
  }

  // URL publica (el bucket debe ser publico en Supabase)
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${ruta}`;
};

/**
 * Borra un archivo del bucket. No truena si no existe.
 */
const borrarImagen = async (bucket, ruta) => {
  validarConfig();
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${ruta}`;
  try {
    await axios.delete(url, {
      headers: { Authorization: `Bearer ${SUPABASE_KEY}` },
    });
  } catch (e) {
    if (e.response?.status !== 404) {
      console.error('Storage delete error:', e.response?.data || e.message);
    }
  }
};

module.exports = { subirImagen, borrarImagen };
