-- 021_cajas_sucursal.sql
-- Cantidad de cajas de cada local (define parte del precio del abono).
-- Tambien se asegura sola al arrancar el servidor (routes_plan.js); este archivo es el registro.
ALTER TABLE mis_sucursales ADD COLUMN IF NOT EXISTS cajas integer NOT NULL DEFAULT 1;
