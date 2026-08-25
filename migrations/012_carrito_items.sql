-- 012_carrito_items.sql
-- Carrito temporal de items escaneados durante un turno

CREATE TABLE carrito_items (
  id SERIAL PRIMARY KEY,
  turno_id INTEGER NOT NULL REFERENCES turnos_caja(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad NUMERIC NOT NULL,
  precio_unitario NUMERIC NOT NULL,
  agregado_por VARCHAR(20) NOT NULL,
  creado_en TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_carrito_items_turno ON carrito_items(turno_id);
