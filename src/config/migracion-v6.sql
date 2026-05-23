-- ═══════════════════════════════════════════════════════
-- VoyCorriendo — Migración v6
-- Columnas faltantes en la tabla pedidos.
-- El modelo Sequelize las tiene pero el schema.sql original no.
-- Ejecutar UNA VEZ en Supabase SQL Editor.
-- Idempotente: se puede correr varias veces sin romper nada.
-- ═══════════════════════════════════════════════════════

-- 1. Distancia y zona (modelo económico por km)
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS distancia_km DECIMAL(6,2);

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS zona VARCHAR(1);

-- 2. Distribución del dinero por pedido
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS pago_repartidor DECIMAL(10,2) DEFAULT 0;

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS comision_negocio DECIMAL(10,2) DEFAULT 0;

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS ganancia_app DECIMAL(10,2) DEFAULT 0;

-- 3. Fee que pagó el cliente (envío)
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS fee_cliente DECIMAL(10,2) DEFAULT 25.00;

-- 4. Zona premium (Zicatela / La Punta → +$5 MXN)
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS zona_premium BOOLEAN DEFAULT FALSE;

-- 5. Tipo de envío
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS tipo_envio VARCHAR(10) DEFAULT 'standard'
    CHECK (tipo_envio IN ('express', 'standard'));

-- 6. Ciudad de operación (multi-ciudad)
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS ciudad VARCHAR(50);

-- 7. Foto INE del cliente (productos con restricción de edad)
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS ine_foto_url TEXT;

-- 8. Referencia al batch de delivery (entrega multi-pedido)
--    Sin FK para evitar problemas si delivery_batches tiene schema distinto.
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS batch_id UUID;

-- ═══════════════════════════════════════════════════════
-- ✅ Migración v6 lista
-- ═══════════════════════════════════════════════════════
