-- Migración v4b: columna ciudad en pedidos
-- Complementa v4 (que ya agregó ciudad a negocios y repartidores).
-- Ejecutar UNA sola vez.

BEGIN;

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS ciudad VARCHAR(50);

-- Propagar ciudad desde el negocio a pedidos existentes
UPDATE pedidos p
SET ciudad = n.ciudad
FROM negocios n
WHERE p.negocio_id = n.id
  AND p.ciudad IS NULL;

CREATE INDEX IF NOT EXISTS idx_pedidos_ciudad ON pedidos(ciudad);

COMMIT;
