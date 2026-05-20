-- Migración v5: modelo híbrido D (tokens + tiers + batches de ruta)
-- Ejecutar UNA sola vez.

BEGIN;

-- 1. delivery_batches — agrupación de pedidos en una ruta del repartidor
CREATE TABLE IF NOT EXISTS delivery_batches (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id   UUID NOT NULL REFERENCES repartidores(id) ON DELETE CASCADE,
  route_data  JSONB,
  waypoints   JSONB,
  status      VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'completed', 'cancelled')),
  max_orders  SMALLINT NOT NULL DEFAULT 3,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_batches_driver   ON delivery_batches(driver_id, status);

-- 2. Agregar campos a pedidos
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS tipo_envio    VARCHAR(10) DEFAULT 'standard'
                                           CHECK (tipo_envio IN ('express','standard')),
  ADD COLUMN IF NOT EXISTS fee_cliente   DECIMAL(10,2) DEFAULT 25.00,
  ADD COLUMN IF NOT EXISTS zona_premium  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS batch_id      UUID REFERENCES delivery_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pedidos_batch ON pedidos(batch_id);

-- 3. Agregar campos a repartidores
ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS tier             VARCHAR(10) DEFAULT 'weekly'
                                              CHECK (tier IN ('daily','weekly')),
  ADD COLUMN IF NOT EXISTS max_pedidos_ruta SMALLINT DEFAULT 3;

-- 4. restaurant_tokens — saldo de tokens por negocio
CREATE TABLE IF NOT EXISTS restaurant_tokens (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id     UUID NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  tokens_remaining  INTEGER NOT NULL DEFAULT 0,
  pack_type         VARCHAR(10) NOT NULL CHECK (pack_type IN ('starter','pro','elite')),
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tokens_restaurant ON restaurant_tokens(restaurant_id);

-- 5. driver_payments — registro de pagos a repartidores por entrega
CREATE TABLE IF NOT EXISTS driver_payments (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id    UUID NOT NULL REFERENCES repartidores(id),
  order_id     UUID NOT NULL REFERENCES pedidos(id),
  amount       DECIMAL(10,2) NOT NULL,
  tier         VARCHAR(10) NOT NULL CHECK (tier IN ('daily','weekly')),
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','paid','failed')),
  scheduled_at TIMESTAMPTZ,
  paid_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dpayments_driver ON driver_payments(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_dpayments_order  ON driver_payments(order_id);

-- 6. platform_revenue — ganancia neta por pedido (reporting)
CREATE TABLE IF NOT EXISTS platform_revenue (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id         UUID NOT NULL REFERENCES pedidos(id),
  token_value      DECIMAL(10,2) DEFAULT 0,
  client_fee       DECIMAL(10,2) DEFAULT 0,
  driver_payout    DECIMAL(10,2) DEFAULT 0,
  transaction_cost DECIMAL(10,2) DEFAULT 0,
  gateway_fee      DECIMAL(10,2) DEFAULT 0,
  net_revenue      DECIMAL(10,2) DEFAULT 0,
  tier             VARCHAR(10),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_order ON platform_revenue(order_id);

COMMIT;
