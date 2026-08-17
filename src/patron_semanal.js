// patron_semanal.js — Lumo P6-4
// Detecta patrones estables por celda (dia_semana × turno) que se mantienen
// consistentemente fuera del promedio global sin cruzar el umbral de anomalía.
//
// Diferencia con CUSUM: CUSUM detecta CAMBIO en el tiempo (deriva).
// Este módulo detecta ESTADO ESTABLE que el dueño debería conocer.
// Ejemplo: "los martes a la tarde siempre renden 18% menos — no es una brecha, es un patrón."
//
// Requisitos para disparar:
//   - N_MIN_OCURRENCIAS: al menos 10 días de datos para esa celda
//   - UMBRAL_DESVIACION_PCT: desvío promedio ≥10% respecto al global del turno
//   - CONSISTENCIA_MIN: ≥75% de los días deben ir en la misma dirección

const pool = require('./db');

const N_MIN_OCURRENCIAS  = 10;
const UMBRAL_DESVIACION_PCT = 0.10; // 10%
const CONSISTENCIA_MIN      = 0.75; // 75%

const DIAS_ES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

async function detectarPatronesSemana(usuarioId, sucursalId = null) {
  // Ventas agrupadas por (dia_semana, turno, día calendario) — últimos 60 días
  const res = await pool.query(
    `SELECT
       EXTRACT(DOW FROM fecha)::integer AS dia_semana,
       COALESCE(turno, 'sin_turno') AS turno,
       DATE(fecha) AS dia,
       SUM(monto) AS total_ventas
     FROM transacciones
     WHERE negocio_id = $1
       AND ($2::integer IS NULL OR sucursal_id = $2)
       AND fecha >= NOW() - INTERVAL '60 days'
       AND monto > 0
     GROUP BY EXTRACT(DOW FROM fecha)::integer, COALESCE(turno, 'sin_turno'), DATE(fecha)`,
    [usuarioId, sucursalId]
  );
  if (res.rows.length < N_MIN_OCURRENCIAS) return [];

  // Promedio global de ventas por turno (referencia para comparar cada celda)
  const globalPorTurno = {};
  const countPorTurno = {};
  for (const row of res.rows) {
    const t = row.turno;
    globalPorTurno[t] = (globalPorTurno[t] || 0) + parseFloat(row.total_ventas);
    countPorTurno[t]  = (countPorTurno[t]  || 0) + 1;
  }
  for (const t of Object.keys(globalPorTurno)) {
    globalPorTurno[t] /= countPorTurno[t];
  }

  // Agrupar por celda
  const celdas = {};
  for (const row of res.rows) {
    const clave = `${row.dia_semana}_${row.turno}`;
    if (!celdas[clave]) celdas[clave] = { dia_semana: parseInt(row.dia_semana), turno: row.turno, totales: [] };
    celdas[clave].totales.push(parseFloat(row.total_ventas));
  }

  const patrones = [];

  for (const celda of Object.values(celdas)) {
    const { dia_semana, turno, totales } = celda;
    if (totales.length < N_MIN_OCURRENCIAS) continue;

    const global = globalPorTurno[turno];
    if (!global || global === 0) continue;

    const promedioCelda = totales.reduce((a, b) => a + b, 0) / totales.length;
    const desvioPct = (promedioCelda - global) / global;

    if (Math.abs(desvioPct) < UMBRAL_DESVIACION_PCT) continue;

    const esBaja = desvioPct < 0;
    // Consistencia: fracción de días que van en la misma dirección que el patrón
    const diasConPatron = esBaja
      ? totales.filter(t => t < global * (1 - UMBRAL_DESVIACION_PCT / 2)).length
      : totales.filter(t => t > global * (1 + UMBRAL_DESVIACION_PCT / 2)).length;
    const consistencia = diasConPatron / totales.length;

    if (consistencia < CONSISTENCIA_MIN) continue;

    const diaStr  = DIAS_ES[dia_semana] ?? `día ${dia_semana}`;
    const pct     = Math.abs(Math.round(desvioPct * 100));
    const n       = totales.length;

    patrones.push({
      tipo:      'PATRON_SEMANAL',
      prioridad: 'ineficiencia',
      dia_semana,
      turno,
      contexto:  `${diaStr}_${turno}`,
      mensaje: esBaja
        ? `Los ${diaStr} a la ${turno} las ventas son ${pct}% menores que tu promedio habitual (${n} semanas de datos)`
        : `Los ${diaStr} a la ${turno} las ventas son ${pct}% mayores que tu promedio habitual (${n} semanas de datos)`,
      accion: esBaja
        ? `Revisá personal, stock y horario de apertura para ese turno.`
        : `Este turno tiene alto potencial — asegurate de estar bien abastecido los ${diaStr}.`,
      datos: {
        promedio_celda:     Math.round(promedioCelda),
        promedio_global:    Math.round(global),
        desvio_pct:         Math.round(desvioPct * 100),
        n_observaciones:    n,
        consistencia_pct:   Math.round(consistencia * 100),
      },
    });
  }

  // Ordenar por magnitud de desvío (los más significativos primero)
  return patrones.sort((a, b) => Math.abs(b.datos.desvio_pct) - Math.abs(a.datos.desvio_pct));
}

module.exports = { detectarPatronesSemana };
