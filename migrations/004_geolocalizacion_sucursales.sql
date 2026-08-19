-- Migración 004: Agregar campos de geolocalización a mis_sucursales
-- Fecha: 2026-08-18
-- Permite geocodificar direcciones de sucursales con lat/lon estructurados

ALTER TABLE mis_sucursales
  ADD COLUMN calle TEXT,
  ADD COLUMN numero TEXT,
  ADD COLUMN localidad TEXT,
  ADD COLUMN provincia TEXT,
  ADD COLUMN latitud NUMERIC(9,6),
  ADD COLUMN longitud NUMERIC(9,6),
  ADD COLUMN geocoding_status TEXT DEFAULT 'pendiente',
  ADD COLUMN geocoding_fecha TIMESTAMP;
