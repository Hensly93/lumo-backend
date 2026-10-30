-- 020_gastos_rentabilidad.sql — Gastos mensuales por categoría + impuestos declarados por el dueño
CREATE TABLE IF NOT EXISTS gastos_mensuales (
  id             serial PRIMARY KEY,
  negocio_id     integer NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  sucursal_id    integer REFERENCES mis_sucursales(id) ON DELETE CASCADE,   -- NULL = todo el negocio
  mes            date NOT NULL,                                             -- primer día del mes
  categoria      varchar(40) NOT NULL,
  monto          numeric(14,2) NOT NULL CHECK (monto >= 0),
  actualizado_en timestamp NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_gastos_mensuales
  ON gastos_mensuales (negocio_id, COALESCE(sucursal_id, 0), mes, categoria);

CREATE TABLE IF NOT EXISTS impuestos_declarados (
  negocio_id     integer PRIMARY KEY REFERENCES negocios(id) ON DELETE CASCADE,
  modo           varchar(12) NOT NULL DEFAULT 'ninguno' CHECK (modo IN ('ninguno','porcentaje','monto')),
  base           varchar(10) NOT NULL DEFAULT 'ventas' CHECK (base IN ('ventas','ganancia')),
  valor          numeric(14,2) NOT NULL DEFAULT 0,
  actualizado_en timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_egresos_negocio_hora ON egresos_caja (negocio_id, hora);
