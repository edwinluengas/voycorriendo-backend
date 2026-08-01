/**
 * Interruptor único de las APIs de pago de Google Maps.
 *
 * Contexto (2026-07-31): el proyecto de Google Cloud no tiene facturación
 * activa, así que TODA llamada respondía REQUEST_DENIED. Peor: el código
 * reintentaba en cada cotización y en cada pedido, generando cientos de
 * llamadas fallidas (608 registradas en Distance Matrix) que no servían
 * para nada — el resultado siempre terminaba saliendo del fallback local.
 *
 * Decisión del dueño mientras dure el periodo de prueba: NO se paga Google.
 * Con `GOOGLE_MAPS_ACTIVO=false` (el default) el backend no sale a la red
 * ni una vez: la distancia se estima en local y el mapa dibuja la línea
 * recta. Nada se borró — poner la variable en `true` en Railway reactiva
 * Distance Matrix y Routes API sin tocar código.
 *
 * OJO, esto NO cubre el Maps SDK for Android (el mapa que se ve dentro de
 * la app): ese se factura por separado y depende de la misma cuenta. Sin
 * facturación puede mostrarse degradado o con marca de agua — hay que
 * verificarlo en el APK, no se puede comprobar desde el backend.
 */

// Se lee en cada consulta, no al cargar el módulo: cambiar la variable en
// Railway surte efecto con solo reiniciar, y los tests pueden probar los dos
// modos (encendido y apagado) sin recargar módulos.
const googleActivo = () =>
  String(process.env.GOOGLE_MAPS_ACTIVO || 'false').toLowerCase() === 'true';

/**
 * Cuánto más largo es el recorrido real por calle que la línea recta.
 * 1.3 es el valor típico para traza urbana (la calle nunca va en diagonal
 * perfecta). Sin Google, esto es lo que convierte "4 km en línea recta" en
 * una estimación honesta de ~5.2 km de manejo real, que es lo que de verdad
 * gasta el repartidor.
 *
 * Con el factor en 1.3 el límite de cobertura se subió de 5 a 6.5 km
 * (decisión del dueño 2026-07-31) para conservar exactamente el área que
 * se atendía antes: lo que cambia es que ahora el número que se muestra y
 * se registra es el recorrido real estimado, no la línea recta.
 */
const FACTOR_RUTA_REAL = parseFloat(process.env.FACTOR_RUTA_REAL || '1.3');

module.exports = { googleActivo, FACTOR_RUTA_REAL };
