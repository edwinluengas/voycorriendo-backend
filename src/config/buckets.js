/**
 * Qué va en un bucket PÚBLICO y qué en uno PRIVADO.
 *
 * Hasta 2026-07-31 todo vivía revuelto en buckets públicos: la foto de
 * portada del restaurante y la INE de su dueño compartían bucket, así que
 * la identificación oficial se descargaba con un GET sin token. Documento
 * de identidad = dato personal sensible (LFPDPPP) y motivo de suspensión
 * en Google Play, así que ahora están separados por bucket:
 *
 *  - PÚBLICO  → lo que la app le enseña a cualquiera: portada, local, logo,
 *               fotos de producto, foto de perfil del repartidor.
 *  - PRIVADO  → identificaciones y comprobantes. Solo se leen con URL
 *               firmada temporal (storage.service.obtenerUrlFirmada), que
 *               es lo que ya usa el panel de aprobaciones del admin.
 *
 * Al agregar un tipo de archivo nuevo, decidir explícitamente dónde cae.
 */

// Públicos (siguen siendo public-read en Supabase).
const BUCKET_PUBLICO_NEGOCIOS     = 'documentos-negocios';
const BUCKET_PUBLICO_REPARTIDORES = 'documentos-repartidores';

// Privados (public=false en Supabase — solo service key o URL firmada).
const BUCKET_PRIVADO_NEGOCIOS     = 'verificacion-negocios';
const BUCKET_PRIVADO_REPARTIDORES = 'verificacion-repartidores';
const BUCKET_PRIVADO_CLIENTES     = 'documentos-clientes';

// Tipos que el wizard de onboarding manda y que SON documentos de identidad.
const TIPOS_PRIVADOS_NEGOCIO = ['comprobante_domicilio', 'documento_rfc', 'documento_ine_dueno'];
const TIPOS_PRIVADOS_REPARTIDOR = ['ine_frente', 'ine_reverso', 'licencia', 'tarjeta_circulacion'];

// Columnas donde viven esas URLs (las usa el script de migración).
const COLUMNAS_PRIVADAS_NEGOCIO = ['comprobante_domicilio', 'documento_rfc', 'documento_ine_dueno'];
const COLUMNAS_PRIVADAS_REPARTIDOR = ['foto_ine_frente', 'foto_ine_reverso', 'foto_licencia', 'foto_tarjeta_circulacion'];

module.exports = {
  BUCKET_PUBLICO_NEGOCIOS,
  BUCKET_PUBLICO_REPARTIDORES,
  BUCKET_PRIVADO_NEGOCIOS,
  BUCKET_PRIVADO_REPARTIDORES,
  BUCKET_PRIVADO_CLIENTES,
  TIPOS_PRIVADOS_NEGOCIO,
  TIPOS_PRIVADOS_REPARTIDOR,
  COLUMNAS_PRIVADAS_NEGOCIO,
  COLUMNAS_PRIVADAS_REPARTIDOR,
};
