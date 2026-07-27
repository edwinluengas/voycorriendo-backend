/**
 * Verifica que la tarifa de envío sea PLANA a cualquier distancia dentro de
 * cobertura (era dinámica: $35 + $5/km arriba de 3 km).
 */
require('dotenv').config();
const { calcularCostoEnvio, getMaxKm } = require('../utils/precios');

(async () => {
  console.log('Cobertura máx:', 'standard', await getMaxKm('standard'), 'km |', 'express', await getMaxKm('express'), 'km\n');
  for (const tipo of ['standard', 'express']) {
    for (const km of [0.5, 1, 2, 3, 3.5, 4, 4.71, 5, 5.2]) {
      const r = await calcularCostoEnvio({ distanciaKm: km, tipoEnvio: tipo });
      console.log(`${tipo.padEnd(9)} ${String(km).padStart(4)} km → ${r.fueraDeCobertura ? 'FUERA DE COBERTURA' : '$' + r.costo}`);
    }
    console.log('');
  }
  const pickup = await calcularCostoEnvio({ distanciaKm: 12, tipoEnvio: 'pickup' });
  console.log('pickup →', pickup.costo, '(sin cobertura aplicable:', !pickup.fueraDeCobertura, ')');
  process.exit(0);
})();
