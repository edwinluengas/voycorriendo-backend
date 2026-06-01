-- Migración v10: codigo_entrega y foto_entrega en pedidos
-- Ejecutar en Supabase → SQL Editor

-- 1. Código de 4 dígitos que el cliente muestra al repartidor al recibir
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS codigo_entrega VARCHAR(6);

-- 2. URL de foto de confirmación de entrega (Supabase Storage)
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS foto_entrega TEXT;

-- 3. Rellenar código en pedidos existentes que no tengan uno aún
UPDATE pedidos
SET codigo_entrega = LPAD((FLOOR(RANDOM() * 9000) + 1000)::TEXT, 4, '0')
WHERE codigo_entrega IS NULL;

-- 4. Verificar
SELECT COUNT(*) AS total, COUNT(codigo_entrega) AS con_codigo FROM pedidos;
