-- ═══════════════════════════════════════════════════════
-- VoyCorriendo — Migración v5
-- Columnas correctas para repartidores:
--   · ciudad  (el modelo usa 'ciudad', NO 'zona_cobertura')
--   · tier    (el modelo usa 'tier',   NO 'ciclo_pago')
-- Ejecutar UNA VEZ en Supabase SQL Editor.
-- Idempotente: se puede correr varias veces sin romper nada.
-- ═══════════════════════════════════════════════════════

-- 1. Ciudad de operación del repartidor
ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS ciudad VARCHAR(50) NOT NULL DEFAULT 'puerto_escondido';

-- 2. Ciclo de pago del repartidor (modelo Sequelize usa 'tier')
ALTER TABLE repartidores
  ADD COLUMN IF NOT EXISTS tier VARCHAR(10) DEFAULT 'weekly'
    CHECK (tier IN ('daily', 'weekly'));

-- ═══════════════════════════════════════════════════════
-- ✅ Migración v5 lista
-- ═══════════════════════════════════════════════════════
