-- Migración 003: Tabla goteo_historico para snapshots diarios del job nocturno
-- Almacena resultados de detectarGoteo() por negocio/día

CREATE TABLE IF NOT EXISTS goteo_historico (
  id SERIAL PRIMARY KEY,
  negocio_id INTEGER NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  fecha DATE NOT NULL,
  detectado BOOLEAN NOT NULL,
  ventana_dias INTEGER,
  turnos_analizados INTEGER,
  turnos_con_brecha INTEGER,
  porcentaje_con_brecha NUMERIC(5,1),
  brecha_total_acumulada NUMERIC(12,2),
  brecha_promedio_por_turno NUMERIC(12,2),
  patron_empleado JSONB,
  patron_turno JSONB,
  mensaje TEXT,
  motivo TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(negocio_id, fecha)
);

CREATE INDEX IF NOT EXISTS idx_goteo_historico_negocio_fecha
  ON goteo_historico(negocio_id, fecha DESC);
