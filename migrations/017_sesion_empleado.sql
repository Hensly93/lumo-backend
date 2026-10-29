-- 017: sesión segura del empleado + bloqueo de PIN
ALTER TABLE turnos_caja ADD COLUMN IF NOT EXISTS sesion_token_hash text;
CREATE INDEX IF NOT EXISTS idx_turnos_caja_sesion_token ON turnos_caja(sesion_token_hash) WHERE sesion_token_hash IS NOT NULL;
ALTER TABLE empleados_negocio ADD COLUMN IF NOT EXISTS pin_fallidos integer NOT NULL DEFAULT 0;
ALTER TABLE empleados_negocio ADD COLUMN IF NOT EXISTS pin_bloqueado_hasta timestamp NULL;
