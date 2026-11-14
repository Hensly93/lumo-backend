-- Migración 004: Agregar campos de geolocalización a mis_sucursales
-- Fecha: 2026-08-18
-- Permite geocodificar direcciones de sucursales con lat/lon estructurados

ALTER TABLE mis_sucursales
  ADD COLUMN IF NOT EXISTS calle TEXT,
  ADD COLUMN IF NOT EXISTS numero TEXT,
  ADD COLUMN IF NOT EXISTS localidad TEXT,
  ADD COLUMN IF NOT EXISTS provincia TEXT,
  ADD COLUMN IF NOT EXISTS latitud NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS longitud NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS geocoding_status TEXT DEFAULT 'pendiente',
  ADD COLUMN IF NOT EXISTS geocoding_fecha TIMESTAMP;
