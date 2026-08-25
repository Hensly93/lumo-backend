-- 010_transacciones_detalle.sql
-- Detalle línea por línea de cada transacción

CREATE TABLE transacciones_detalle (
  id SERIAL PRIMARY KEY,
  transaccion_id INTEGER NOT NULL REFERENCES transacciones(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad NUMERIC NOT NULL,
  precio_unitario NUMERIC NOT NULL,
  subtotal NUMERIC NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transacciones_detalle_transaccion ON transacciones_detalle(transaccion_id);
