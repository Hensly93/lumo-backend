-- 023_turno_id_transacciones.sql — cada venta de la caja queda atada a su turno (13/11/2026)
-- Sin esto, con dos cajas abiertas a la vez cada turno sumaba las ventas del otro.
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS turno_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_tx_turno ON transacciones(turno_id) WHERE turno_id IS NOT NULL;
-- predicciones por negocio (en producción ya existe; acá para poder rearmar la base)
ALTER TABLE predicciones_negocio ADD COLUMN IF NOT EXISTS negocio_id INTEGER;
