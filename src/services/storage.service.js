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

const MIME_PERMITIDOS = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — deja margen bajo el límite de axios de 10 MB

const validarImagen = (mime, buffer) => {
  if (!MIME_PERMITIDOS.includes((mime || '').toLowerCase())) {
    throw new Error(`Tipo de archivo no permitido: ${mime || 'desconocido'}. Solo se aceptan imágenes JPEG, PNG o WEBP.`);
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error(`La imagen es demasiado grande (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Máximo ${MAX_BYTES / 1024 / 1024} MB.`);
  }
  if (buffer.length === 0) {
    throw new Error('El archivo está vacío.');
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

  validarImagen(mime, buffer);

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
 * Genera una URL firmada (temporal) para acceder a un archivo en un bucket
 * privado. Util para que el panel admin pueda ver INE/RFC sin que sean
 * publicos en internet.
 *
 * Acepta ruta_o_url: o la ruta dentro del bucket (ej. 'negocios/uuid/ine.jpg')
 * o la URL completa que guardamos en BD (ej. https://.../object/public/...).
 *
 * @param {string} bucket   Nombre del bucket
 * @param {string} ruta_o_url  Ruta dentro del bucket o URL completa guardada
 * @param {number} segundos  Validez de la URL (default 3600 = 1 hora)
 * @returns {Promise<string>} URL firmada lista para abrir en navegador
 */
const obtenerUrlFirmada = async (bucket, ruta_o_url, segundos = 3600) => {
  validarConfig();
  if (!ruta_o_url) return null;

  // Si nos pasaron una URL completa, extraemos la ruta despues del bucket
  let ruta = ruta_o_url;
  const marcador = `/object/public/${bucket}/`;
  const marcador2 = `/object/${bucket}/`;
  if (ruta.includes(marcador)) {
    ruta = ruta.split(marcador)[1];
  } else if (ruta.includes(marcador2)) {
    ruta = ruta.split(marcador2)[1];
  }

  const url = `${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${ruta}`;
  try {
    const resp = await axios.post(
      url,
      { expiresIn: segundos },
      { headers: { Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    // Supabase devuelve { signedURL: "/object/sign/..." } - hay que prefijar
    const signedURL = resp.data?.signedURL || resp.data?.signedUrl;
    if (!signedURL) return null;
    return `${SUPABASE_URL}/storage/v1${signedURL}`;
  } catch (e) {
    console.error('Storage sign error:', e.response?.data || e.message);
    return null;
  }
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

module.exports = { subirImagen, borrarImagen, obtenerUrlFirmada };
