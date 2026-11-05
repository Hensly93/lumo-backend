-- 022_tamano_declarado.sql
-- Tamano que el negocio declara al registrarse (define el piso del abono; si lo real es mayor, manda lo real).
-- Tambien se asegura solo al arrancar el servidor (routes_plan.js); este archivo es el registro.
ALTER TABLE negocios
  ADD COLUMN IF NOT EXISTS locales_declarados integer,
  ADD COLUMN IF NOT EXISTS cajas_declaradas integer,
  ADD COLUMN IF NOT EXISTS empleados_declarados integer;
