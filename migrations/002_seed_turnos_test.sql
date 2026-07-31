-- ============================================================================
-- LUMO - Siembra de datos de test para ERM
-- Fecha: 2026-07-09
-- Crea turnos de prueba para negocio_id=13 (Café Maria)
-- 3 empleados: Pedro (rojo - anomalía deliberada), Carlos y Marta (verdes)


DELETE FROM turnos_caja WHERE negocio_id=13 AND nombre_empleado IN ('Pedro', 'Carlos', 'Marta');
-- ============================================================================

-- EMPLEADO: Marta (normal - patrón limpio)
INSERT INTO turnos_caja (
  negocio_id, usuario_id, nombre_empleado, tipo_turno,
  caja_apertura, caja_cierre, caja_esperada, brecha,
  hora_apertura, hora_cierre, estado,
  conteo_aleatorio_omitido, conteo_aleatorio2_omitido, gasto_inesperado
) VALUES
  (13, 14, 'Marta', 'manana', 5000, 12100, 12000, -100, NOW() - INTERVAL '29 days' + INTERVAL '8 hours', NOW() - INTERVAL '29 days' + INTERVAL '14 hours', 'cerrado', false, false, false),
  (13, 14, 'Marta', 'tarde', 12100, 18200, 18100, -100, NOW() - INTERVAL '26 days' + INTERVAL '14 hours', NOW() - INTERVAL '26 days' + INTERVAL '20 hours', 'cerrado', false, false, false),
  (13, 14, 'Marta', 'noche', 18200, 23150, 23200, 50, NOW() - INTERVAL '23 days' + INTERVAL '20 hours', NOW() - INTERVAL '22 days' + INTERVAL '2 hours', 'cerrado', false, false, false),
  (13, 14, 'Marta', 'manana', 5000, 11950, 12000, 50, NOW() - INTERVAL '20 days' + INTERVAL '8 hours', NOW() - INTERVAL '20 days' + INTERVAL '14 hours', 'cerrado', false, false, false),
  (13, 14, 'Marta', 'tarde', 11950, 17900, 17850, -50, NOW() - INTERVAL '17 days' + INTERVAL '14 hours', NOW() - INTERVAL '17 days' + INTERVAL '20 hours', 'cerrado', false, false, false),
  (13, 14, 'Marta', 'manana', 5000, 12200, 12100, -100, NOW() - INTERVAL '14 days' + INTERVAL '8 hours', NOW() - INTERVAL '14 days' + INTERVAL '14 hours', 'cerrado', false, false, false),
  (13, 14, 'Marta', 'tarde', 12200, 18350, 18250, -100, NOW() - INTERVAL '19 days' + INTERVAL '14 hours', NOW() - INTERVAL '19 days' + INTERVAL '20 hours', 'cerrado', false, false, false),
  (13, 14, 'Marta', 'noche', 18350, 23250, 23300, 50, NOW() - INTERVAL '8 days' + INTERVAL '20 hours', NOW() - INTERVAL '7 days' + INTERVAL '2 hours', 'cerrado', false, false, false),
  (13, 14, 'Marta', 'manana', 5000, 12050, 12000, -50, NOW() - INTERVAL '5 days' + INTERVAL '8 hours', NOW() - INTERVAL '5 days' + INTERVAL '14 hours', 'cerrado', false, false, false),
  (13, 14, 'Marta', 'tarde', 12050, 18100, 18150, 50, NOW() - INTERVAL '28 days' + INTERVAL '14 hours', NOW() - INTERVAL '28 days' + INTERVAL '20 hours', 'cerrado', false, false, false);

-- EMPLEADO: Carlos (normal - patrón limpio)
INSERT INTO turnos_caja (
  negocio_id, usuario_id, nombre_empleado, tipo_turno,
  caja_apertura, caja_cierre, caja_esperada, brecha,
  hora_apertura, hora_cierre, estado,
  conteo_aleatorio_omitido, conteo_aleatorio2_omitido, gasto_inesperado
) VALUES
  (13, 14, 'Carlos', 'manana', 5000, 11850, 11900, 50, NOW() - INTERVAL '28 days' + INTERVAL '8 hours', NOW() - INTERVAL '28 days' + INTERVAL '14 hours', 'cerrado', false, false, false),
  (13, 14, 'Carlos', 'noche', 18000, 23050, 23100, 50, NOW() - INTERVAL '25 days' + INTERVAL '20 hours', NOW() - INTERVAL '24 days' + INTERVAL '2 hours', 'cerrado', false, false, false),
  (13, 14, 'Carlos', 'tarde', 12000, 17950, 18000, 50, NOW() - INTERVAL '22 days' + INTERVAL '14 hours', NOW() - INTERVAL '22 days' + INTERVAL '20 hours', 'cerrado', false, false, false),
  (13, 14, 'Carlos', 'manana', 5000, 12100, 12000, -100, NOW() - INTERVAL '19 days' + INTERVAL '8 hours', NOW() - INTERVAL '19 days' + INTERVAL '14 hours', 'cerrado', false, false, false),
  (13, 14, 'Carlos', 'noche', 18100, 23200, 23150, -50, NOW() - INTERVAL '16 days' + INTERVAL '20 hours', NOW() - INTERVAL '15 days' + INTERVAL '2 hours', 'cerrado', false, false, false),
  (13, 14, 'Carlos', 'tarde', 12100, 18050, 18000, -50, NOW() - INTERVAL '18 days' + INTERVAL '14 hours', NOW() - INTERVAL '18 days' + INTERVAL '20 hours', 'cerrado', false, false, false),
  (13, 14, 'Carlos', 'manana', 5000, 11900, 11950, 50, NOW() - INTERVAL '10 days' + INTERVAL '8 hours', NOW() - INTERVAL '10 days' + INTERVAL '14 hours', 'cerrado', false, false, false),
  (13, 14, 'Carlos', 'tarde', 11900, 17850, 17900, 50, NOW() - INTERVAL '27 days' + INTERVAL '14 hours', NOW() - INTERVAL '27 days' + INTERVAL '20 hours', 'cerrado', false, false, false),
  (13, 14, 'Carlos', 'noche', 17850, 23000, 22950, -50, NOW() - INTERVAL '4 days' + INTERVAL '20 hours', NOW() - INTERVAL '3 days' + INTERVAL '2 hours', 'cerrado', false, false, false),
  (13, 14, 'Carlos', 'manana', 5000, 12050, 12000, -50, NOW() - INTERVAL '1 days' + INTERVAL '8 hours', NOW() - INTERVAL '1 days' + INTERVAL '14 hours', 'cerrado', false, false, false);

-- EMPLEADO: Pedro (rojo - anomalía deliberada en turnos de tarde)
-- NOTA: los 7 turnos tarde de Pedro (anomalía) se mantienen deliberadamente
-- dentro de los últimos 14 días — cusum.js usa VENTANA_DIAS=14, distinto de
-- los 30 días que usa el ERM general. Los turnos tarde de Marta/Carlos se
-- mantienen fuera de esos 14 días a propósito, para que no diluyan la señal
-- de CUSUM con ruido de empleados normales.
-- Brecha creciente y consistentemente negativa en turno "tarde"
-- + omisión de conteos aleatorios
INSERT INTO turnos_caja (
  negocio_id, usuario_id, nombre_empleado, tipo_turno,
  caja_apertura, caja_cierre, caja_esperada, brecha,
  hora_apertura, hora_cierre, estado,
  conteo_aleatorio_omitido, conteo_aleatorio2_omitido, gasto_inesperado
) VALUES
  -- Turnos mañana (normales)
  (13, 14, 'Pedro', 'manana', 5000, 11900, 12000, 100, NOW() - INTERVAL '27 days' + INTERVAL '8 hours', NOW() - INTERVAL '27 days' + INTERVAL '14 hours', 'cerrado', false, false, false),
  (13, 14, 'Pedro', 'manana', 5000, 12050, 12100, 50, NOW() - INTERVAL '18 days' + INTERVAL '8 hours', NOW() - INTERVAL '18 days' + INTERVAL '14 hours', 'cerrado', false, false, false),
  -- Turnos tarde (ANOMALÍA - brecha negativa creciente + omisiones)
  (13, 14, 'Pedro', 'tarde', 12000, 17700, 18000, 300, NOW() - INTERVAL '13 days' + INTERVAL '14 hours', NOW() - INTERVAL '13 days' + INTERVAL '20 hours', 'cerrado', true, false, false),
  (13, 14, 'Pedro', 'tarde', 11900, 17500, 18000, 500, NOW() - INTERVAL '11 days' + INTERVAL '14 hours', NOW() - INTERVAL '11 days' + INTERVAL '20 hours', 'cerrado', false, true, false),
  (13, 14, 'Pedro', 'tarde', 12050, 17450, 18100, 650, NOW() - INTERVAL '9 days' + INTERVAL '14 hours', NOW() - INTERVAL '9 days' + INTERVAL '20 hours', 'cerrado', true, true, false),
  (13, 14, 'Pedro', 'tarde', 12100, 17400, 18200, 800, NOW() - INTERVAL '7 days' + INTERVAL '14 hours', NOW() - INTERVAL '7 days' + INTERVAL '20 hours', 'cerrado', true, false, false),
  (13, 14, 'Pedro', 'tarde', 12000, 17250, 18100, 850, NOW() - INTERVAL '5 days' + INTERVAL '14 hours', NOW() - INTERVAL '5 days' + INTERVAL '20 hours', 'cerrado', false, true, false),
  (13, 14, 'Pedro', 'tarde', 11950, 17150, 18050, 900, NOW() - INTERVAL '3 days' + INTERVAL '14 hours', NOW() - INTERVAL '3 days' + INTERVAL '20 hours', 'cerrado', true, true, false),
  (13, 14, 'Pedro', 'tarde', 12000, 17100, 18000, 900, NOW() - INTERVAL '1 days' + INTERVAL '14 hours', NOW() - INTERVAL '1 days' + INTERVAL '20 hours', 'cerrado', true, false, false),
  -- Turnos noche (normales)
  (13, 14, 'Pedro', 'noche', 17700, 22800, 22900, 100, NOW() - INTERVAL '24 days' + INTERVAL '20 hours', NOW() - INTERVAL '23 days' + INTERVAL '2 hours', 'cerrado', false, false, false);

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================

\echo '=== Turnos sembrados por empleado ==='
SELECT nombre_empleado, COUNT(*) as n_turnos,
       AVG(brecha) as brecha_promedio,
       SUM(CASE WHEN conteo_aleatorio_omitido OR conteo_aleatorio2_omitido THEN 1 ELSE 0 END) as omisiones
FROM turnos_caja
WHERE negocio_id=13
GROUP BY nombre_empleado
ORDER BY nombre_empleado;

\echo '=== Turnos de Pedro por tipo ==='
SELECT tipo_turno, COUNT(*) as n_turnos,
       AVG(brecha) as brecha_promedio,
       SUM(CASE WHEN conteo_aleatorio_omitido OR conteo_aleatorio2_omitido THEN 1 ELSE 0 END) as omisiones
FROM turnos_caja
WHERE negocio_id=13 AND nombre_empleado='Pedro'
GROUP BY tipo_turno
ORDER BY tipo_turno;

\echo '=== SIEMBRA DE TEST COMPLETADA ==='
