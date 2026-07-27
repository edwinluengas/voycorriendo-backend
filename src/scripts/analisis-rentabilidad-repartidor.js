/**
 * ¿Alcanzan $35 flat para cubrir el costo del repartidor a 5 km?
 * -----------------------------------------------------------------
 * Modelo abierto y auditable: cambia los supuestos de arriba y vuelve a
 * correrlo (`node src/scripts/analisis-rentabilidad-repartidor.js`).
 *
 * Los precios son ESTIMADOS para Puerto Escondido, Oaxaca. Verifícalos con
 * un repartidor real antes de tomar la decisión de radio/tarifa.
 */
const SUPUESTOS = {
  precioGasolinaLitro: 24.5,   // MXN por litro de Magna
  rendimientoKmLitro:  33,     // moto 125–150cc en ciudad
  // Desgaste real que el repartidor paga tarde o temprano: llantas, aceite,
  // frenos, cadena, servicios. Es dinero de verdad aunque no se sienta hoy.
  mantenimientoPorKm:  0.60,
  // Depreciación: moto de $25,000 con vida útil de 50,000 km de trabajo.
  depreciacionPorKm:   0.50,
  // Recorrido real por entrega = ir al restaurante + llevar al cliente.
  // El regreso NO se cuenta completo: normalmente el siguiente pedido sale
  // de donde quedó (se agrega solo un 40% del tramo de entrega).
  kmAlRestaurante:     2.0,
  factorRegreso:       0.4,
  // Tiempos (minutos)
  minPorKm:            2.6,    // ~23 km/h reales con topes y calle de terracería
  minEsperaRestaurante: 8,
  minEntrega:          3,
  // Referencia legal 2026 (estimada): salario mínimo diario zona general
  salarioMinimoDiario: 315,
  horasJornada:        8,
};

const S = SUPUESTOS;
const gasPorKm = S.precioGasolinaLitro / S.rendimientoKmLitro;
const costoPorKm = gasPorKm + S.mantenimientoPorKm + S.depreciacionPorKm;
const minimoPorHora = S.salarioMinimoDiario / S.horasJornada;

const analizar = (kmEntrega, tarifa) => {
  const kmTotales = S.kmAlRestaurante + kmEntrega + kmEntrega * S.factorRegreso;
  const costo = kmTotales * costoPorKm;
  const utilidad = tarifa - costo;
  const minutos = kmTotales * S.minPorKm + S.minEsperaRestaurante + S.minEntrega;
  const entregasPorHora = 60 / minutos;
  return {
    kmEntrega, tarifa,
    kmTotales: +kmTotales.toFixed(1),
    costo: +costo.toFixed(2),
    utilidad: +utilidad.toFixed(2),
    minutos: Math.round(minutos),
    utilidadPorHora: +(utilidad * entregasPorHora).toFixed(2),
    brutoPorHora: +(tarifa * entregasPorHora).toFixed(2),
  };
};

console.log('SUPUESTOS');
console.log(`  Gasolina: $${S.precioGasolinaLitro}/L ÷ ${S.rendimientoKmLitro} km/L = $${gasPorKm.toFixed(2)}/km`);
console.log(`  + mantenimiento $${S.mantenimientoPorKm}/km + depreciación $${S.depreciacionPorKm}/km`);
console.log(`  = COSTO TOTAL $${costoPorKm.toFixed(2)} por km recorrido`);
console.log(`  Referencia: salario mínimo $${S.salarioMinimoDiario}/día = $${minimoPorHora.toFixed(2)}/hora\n`);

console.log('ENVÍO ESTÁNDAR — $35 flat');
console.log('  km  | km reales | costo  | UTILIDAD | min | $/hora neto | vs salario mín');
for (const km of [1, 2, 3, 3.5, 4, 4.5, 5, 6, 7]) {
  const r = analizar(km, 35);
  const vs = r.utilidadPorHora >= minimoPorHora ? '✅' : '⚠️ POR DEBAJO';
  console.log(`  ${String(km).padStart(3)} |  ${String(r.kmTotales).padStart(5)}    | $${String(r.costo).padStart(5)} |  $${String(r.utilidad).padStart(6)} | ${String(r.minutos).padStart(3)} |   $${String(r.utilidadPorHora).padStart(6)}   | ${vs}`);
}

console.log('\nENVÍO EXPRESS — $60 flat (viaja solo, sin batch)');
for (const km of [3, 4, 5]) {
  const r = analizar(km, 60);
  console.log(`  ${String(km).padStart(3)} km → costo $${r.costo} · utilidad $${r.utilidad} · $${r.utilidadPorHora}/hora`);
}

console.log('\nPUNTO DE EQUILIBRIO (utilidad = $0) con $35:');
for (let km = 1; km <= 30; km += 0.5) {
  if (analizar(km, 35).utilidad <= 0) { console.log(`  ${km} km de entrega — más allá de eso, el repartidor PIERDE dinero.`); break; }
}
console.log('\nTARIFA MÍNIMA para que el repartidor gane al menos el salario mínimo por hora:');
for (const km of [4, 5, 6]) {
  let tarifa = 20;
  while (analizar(km, tarifa).utilidadPorHora < minimoPorHora && tarifa < 200) tarifa += 1;
  console.log(`  a ${km} km → $${tarifa}`);
}
