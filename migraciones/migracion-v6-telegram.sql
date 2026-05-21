-- Migración v6: campo telegram_chat_id en usuarios
-- Ejecutar en Railway: psql o panel SQL
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_usuarios_telegram ON usuarios(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
