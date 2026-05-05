-- ═══════════════════════════════════════════════════════════════
-- MIGRACION V7: Promover usuario a admin
-- ═══════════════════════════════════════════════════════════════
-- Esta migracion convierte al usuario con email 'edwinluengas1979@gmail.com'
-- en admin del sistema. Despues podra entrar al panel /admin del backend.
--
-- Si tu cuenta de admin tiene OTRO email, cambia el email en el WHERE.
--
-- IMPORTANTE: corre los bloques UNO POR UNO en Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════


-- ─── BLOQUE 1: ver el usuario actual antes de tocarlo ─────
-- (Este bloque solo es para verificar. Si no aparece, NO existes
--  como usuario y debes registrarte primero desde la app.)
SELECT id, nombre, apellido, email, telefono, rol, modo_activo, estado, creado_en
FROM usuarios
WHERE email = 'edwinluengas1979@gmail.com';


-- ─── BLOQUE 2: promover a admin ───────────────────────────
UPDATE usuarios
SET rol = 'admin'
WHERE email = 'edwinluengas1979@gmail.com';


-- ─── BLOQUE 3: verificar que quedo como admin ─────────────
SELECT id, nombre, email, rol, estado
FROM usuarios
WHERE rol = 'admin';
