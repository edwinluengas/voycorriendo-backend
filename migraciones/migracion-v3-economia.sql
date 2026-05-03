-- ─────────────────────────────────────────────────────────────
-- VoyCorriendo — Migración v3: columnas del modelo económico
-- Ejecutar en el SQL Editor de Supabase.
-- Es idempotente: se puede correr varias veces sin romper nada.
-- ─────────────────────────────────────────────────────────────

-- Distancia entre negocio y cliente (km)
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS distancia_km NUMERIC(6,2);

-- Zona A/B/C (nullable si el pedido quedó fuera de cobertura o no se pudo calcular)
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS zona VARCHAR(1);

-- Cuánto le pagamos al repartidor por este pedido (MXN)
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS pago_repartidor NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Comisión que retenemos al negocio (MXN)
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS comision_negocio NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Ganancia neta de VoyCorriendo (MXN)
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS ganancia_app NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Índice para reportes por zona
CREATE INDEX IF NOT EXISTS idx_pedidos_zona ON pedidos(zona);

-- Chequeo: zona solo puede ser A, B o C (o NULL)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_zona_check'
  ) THEN
    ALTER TABLE pedidos
      ADD CONSTRAINT pedidos_zona_check
      CHECK (zona IS NULL OR zona IN ('A','B','C'));
  END IF;
END$$;
