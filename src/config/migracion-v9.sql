-- Migración v9: VoyTokens — Programa de lealtad para clientes
-- Ejecutar en Supabase → SQL Editor

-- 1. Agregar columna voytokens a usuarios (acumula 1 token por cada $10 en productos)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS voytokens INTEGER NOT NULL DEFAULT 0;

-- 2. Verificar que la columna quedó correcta
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'usuarios' AND column_name = 'voytokens';
