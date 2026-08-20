-- 006_clima_historico.sql
-- Tabla para almacenar datos históricos de clima por sucursal

CREATE TABLE clima_historico (
  id SERIAL PRIMARY KEY,
  sucursal_id INTEGER NOT NULL REFERENCES mis_sucursales(id) ON DELETE CASCADE,
  fecha DATE NOT NULL,
  clima TEXT NOT NULL,
  precipitacion_mm NUMERIC(6,2),
  temp_max NUMERIC(5,2),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(sucursal_id, fecha)
);

-- Índice para consultas por sucursal y fecha
CREATE INDEX idx_clima_sucursal_fecha ON clima_historico(sucursal_id, fecha DESC);
