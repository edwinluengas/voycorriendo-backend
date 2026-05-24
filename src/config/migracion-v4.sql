-- ═══════════════════════════════════════════════════════
-- VoyCorriendo — Migración v4
-- Columnas nuevas en repartidores que existen en el modelo
-- pero no en el schema original.
-- Ejecutar UNA VEZ en Supabase SQL Editor.
-- Idempotente: se puede correr varias veces sin romper nada.
-- ═══════════════════════════════════════════════════════

-- 1. Estado de cuenta del repartidor (calidad / confianza)
ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS estado_cuenta VARCHAR(20) NOT NULL DEFAULT 'normal'
    CHECK (estado_cuenta IN ('normal', 'observacion', 'probation', 'suspendido', 'bloqueado'));

ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS estado_motivo TEXT;

-- 2. Métricas de calidad
ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS tasa_cancelacion DECIMAL(5,2) DEFAULT 0.00;

ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS tasa_aceptacion DECIMAL(5,2) DEFAULT 100.00;

ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS quejas_30d INTEGER DEFAULT 0;

-- 3. Conexión en tiempo real (Go Online / Go Offline)
ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS conectado BOOLEAN DEFAULT FALSE;

ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS conectado_desde TIMESTAMPTZ;

-- 4. Zona de cobertura y configuración de pago
ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS zona_cobertura VARCHAR(50) NOT NULL DEFAULT 'zacatepec';

ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS ciclo_pago VARCHAR(10) DEFAULT 'daily'
    CHECK (ciclo_pago IN ('daily', 'weekly'));

ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS max_pedidos_ruta INTEGER DEFAULT 3;

-- 5. Índices útiles
CREATE INDEX IF NOT EXISTS idx_repartidores_conectado
  ON repartidores(conectado) WHERE conectado = TRUE;

CREATE INDEX IF NOT EXISTS idx_repartidores_estado_cuenta
  ON repartidores(estado_cuenta);

-- ═══════════════════════════════════════════════════════
-- ✅ Migración v4 lista
-- ═══════════════════════════════════════════════════════
