-- 019_ipc_mensual.sql — IPC mensual (INDEC) para comparativas en valor real
CREATE TABLE IF NOT EXISTS ipc_mensual (
  mes            date PRIMARY KEY,          -- primer día del mes
  indice         numeric(14,4) NOT NULL,
  actualizado_en timestamp NOT NULL DEFAULT NOW()
);
-- Acelera las consultas por período (fecha en hora Argentina)
CREATE INDEX IF NOT EXISTS idx_tx_negocio_fecha ON transacciones (negocio_id, fecha);
CREATE INDEX IF NOT EXISTS idx_turnos_negocio_cierre ON turnos_caja (negocio_id, hora_cierre);
