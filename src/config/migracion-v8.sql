-- Migración v8: Estado en_envio para paquetería + número de guía
-- Ejecutar en Supabase → SQL Editor

-- 1. Agregar valor 'en_envio' al enum de estados del pedido
ALTER TYPE "enum_pedidos_estado" ADD VALUE IF NOT EXISTS 'en_envio' AFTER 'en_camino';

-- 2. Agregar columna para número de guía de paquetería
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS numero_guia VARCHAR(100);

-- 3. Agregar timestamp de envío por paquetería
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS enviado_en TIMESTAMPTZ;
