// erm.js — Lumo S8
// Employee Risk Model (ERM)
//
// Agrega múltiples señales por empleado en un score de riesgo 0–100:
//   - CUSUM: deriva conductual sostenida (P8)
//   - Zscore propio: brecha vs su propio historial (zscore_contextual)
//   - Brecha promedio: inconsistencias acumuladas (cruce_variables)
//   - Comportamiento vs peers: desvío respecto al mismo turno
//   - Omisión de conteos: tasa de conteos aleatorios no respondidos
//   - Racha limpia: turnos consecutivos sin brecha (señal positiva)
//
// Score ponderado → nivel: verde (<30) | amarillo (30-60) | rojo (>60)
// Los empleados NO son nombrados en alertas automáticas.

const pool = require('./db');
const { calcularCUSUM } = require('./cusum');
const { calcularZScoreEmpleado, detectarCambioComportamiento } = require('./zscore_contextual');
const { calcularMediana } = require('./deteccion');

const TURNOS = ['manana', 'tarde', 'noche'];

// ─── Score por señal ─────────────────────────────────────────────────────────
// Cada señal suma puntos al riesgo (0 = limpio, 100 = crítico)

function puntajesCUSUM(cusumTurnos) {
  // Toma el peor CUSUM de todos los turnos del empleado
  let maxPct = 0;
  for (const c of cusumTurnos) {
    if (c?.disponible && c.pct_umbral > maxPct) maxPct = c.pct_umbral;
  }
  if (maxPct >= 100) return 35;  // alarma activa
  if (maxPct >= 70)  return 20;  // acercándose al umbral
  if (maxPct >= 40)  return 8;
  return 0;
}

function puntajesZScore(zEmpleado) {
  if (!zEmpleado || zEmpleado.zscore === null) return 0;
  const z = Math.abs(zEmpleado.zscore);
  if (z >= 4.0) return 30;
  if (z >= 2.5) return 18;
  if (z >= 1.5) return 8;
  return 0;
}

function puntajesBrechaPromedio(brechaPromAbs, tasaInconsistencia) {
  let pts = 0;
  if (brechaPromAbs > 3000) pts += 15;
  else if (brechaPromAbs > 1000) pts += 8;
  else if (brechaPromAbs > 500) pts += 3;
  if (tasaInconsistencia > 50) pts += 10;
  else if (tasaInconsistencia > 25) pts += 5;
  return pts;
}

function puntajesComportamiento(cambio) {
  if (!cambio?.detectado) return 0;
  const z = Math.abs(cambio.zscore_vs_peers || 0);
  if (z >= 3.0) return 15;
  if (z >= 2.0) return 8;
  return 0;
}

function puntajesOmision(tasaOmision) {
  if (tasaOmision > 0.5) return 15;
  if (tasaOmision > 0.25) return 8;
  if (tasaOmision > 0.1) return 3;
  return 0;
}

// ─── Score final ─────────────────────────────────────────────────────────────

function calcularScore(partes) {
  const raw = partes.cusum + partes.zscore + partes.brecha + partes.comportamiento + partes.omision;
  return Math.min(raw, 100);
}

function nivel(score) {
  if (score >= 61) return 'rojo';
  if (score >= 30) return 'amarillo';
  return 'verde';
}

// ─── ERM de un empleado ───────────────────────────────────────────────────────

async function calcularRiesgoEmpleado(usuarioId, nombreEmpleado) {
  // 1. Historial del empleado: brechas, omisiones, racha limpia
  const histRes = await pool.query(
    `SELECT
       COUNT(*) as n_turnos,
       AVG(ABS(COALESCE(brecha, 0))) as brecha_prom_abs,
       AVG(COALESCE(brecha, 0)) as brecha_prom,
       SUM(CASE WHEN ABS(COALESCE(brecha,0)) > 500 THEN 1 ELSE 0 END) as turnos_con_brecha,
       SUM(CASE WHEN conteo_aleatorio_omitido = true THEN 1 ELSE 0 END) as omisiones_c1,
       SUM(CASE WHEN conteo_aleatorio2_omitido = true THEN 1 ELSE 0 END) as omisiones_c2,
       MAX(tipo_turno) as ultimo_turno_tipo,
       MAX(hora_apertura) as ultimo_turno_fecha
     FROM turnos_caja
     WHERE usuario_id=$1 AND nombre_empleado=$2
       AND estado='cerrado'
       AND (gasto_inesperado IS NOT TRUE)
       AND hora_apertura >= NOW() - INTERVAL '30 days'`,
    [usuarioId, nombreEmpleado]
  );

  const hist = histRes.rows[0];
  const nTurnos = parseInt(hist.n_turnos);

  if (nTurnos < 3) {
    return {
      empleado: nombreEmpleado,
      score: null,
      nivel: 'sin_datos',
      motivo: `Solo ${nTurnos} turno(s) en los últimos 30 días`,
      señales: [],
    };
  }

  const brechaPromAbs = parseFloat(hist.brecha_prom_abs);
  const tasaInconsistencia = (parseInt(hist.turnos_con_brecha) / nTurnos) * 100;
  const totalOmisiones = parseInt(hist.omisiones_c1) + parseInt(hist.omisiones_c2);
  const tasaOmision = totalOmisiones / (nTurnos * 2); // dos conteos posibles por turno
  const ultimoTurnoTipo = hist.ultimo_turno_tipo || 'manana';

  // 2. CUSUM por todos los turnos donde este empleado trabajó
  const turnosRes = await pool.query(
    `SELECT DISTINCT tipo_turno FROM turnos_caja
     WHERE usuario_id=$1 AND nombre_empleado=$2 AND estado='cerrado'
       AND (gasto_inesperado IS NOT TRUE)
       AND hora_apertura >= NOW() - INTERVAL '30 days'`,
    [usuarioId, nombreEmpleado]
  );
  const turnosEmpleado = turnosRes.rows.map(r => r.tipo_turno);

  // CUSUM usa series del usuario completo por turno (no filtra por empleado)
  // porque la brecha absoluta es lo que importa, no quién la generó
  const cusumTurnos = await Promise.all(
    turnosEmpleado.map(t => calcularCUSUM(usuarioId, t).catch(() => ({ disponible: false, turno: t })))
  );

  // 3. Z-score propio del empleado (vs su propio historial en el último turno tipo)
  const zEmpleado = await calcularZScoreEmpleado(
    usuarioId, nombreEmpleado, ultimoTurnoTipo, brechaPromAbs
  ).catch(() => null);

  // 4. Comportamiento vs peers (en el turno más frecuente)
  const cambioComp = await detectarCambioComportamiento(
    usuarioId, nombreEmpleado, ultimoTurnoTipo
  ).catch(() => null);

  // 5. Racha limpia actual
  const rachaRes = await pool.query(
    `SELECT ABS(COALESCE(brecha,0)) as brecha_abs
     FROM turnos_caja
     WHERE usuario_id=$1 AND nombre_empleado=$2 AND estado='cerrado'
       AND (gasto_inesperado IS NOT TRUE)
     ORDER BY hora_apertura DESC LIMIT 15`,
    [usuarioId, nombreEmpleado]
  );
  let rachaLimpia = 0;
  for (const r of rachaRes.rows) {
    if (parseFloat(r.brecha_abs) <= 500) rachaLimpia++;
    else break;
  }

  // 6. Calcular puntajes parciales
  const partes = {
    cusum:          puntajesCUSUM(cusumTurnos),
    zscore:         puntajesZScore(zEmpleado),
    brecha:         puntajesBrechaPromedio(brechaPromAbs, tasaInconsistencia),
    comportamiento: puntajesComportamiento(cambioComp),
    omision:        puntajesOmision(tasaOmision),
  };

  const score = calcularScore(partes);
  const nivelRiesgo = nivel(score);

  // 7. Señales activas (para el frontend — descripción sin nombrar al empleado)
  const señales = [];

  if (partes.cusum >= 20) {
    const turnoConAlarma = cusumTurnos.find(c => c?.pct_umbral >= 70);
    señales.push({
      tipo: 'CUSUM',
      descripcion: `Deriva conductual sostenida en turno ${turnoConAlarma?.turno || 'detectado'} (${turnoConAlarma?.pct_umbral ?? '?'}% del umbral)`,
      peso: partes.cusum,
    });
  }

  if (partes.zscore >= 18) {
    señales.push({
      tipo: 'ZSCORE_PROPIO',
      descripcion: `Brecha ${Math.abs(zEmpleado.zscore).toFixed(1)} desvíos fuera de su propio patrón histórico`,
      peso: partes.zscore,
    });
  }

  if (partes.brecha >= 8) {
    señales.push({
      tipo: 'BRECHA_PROMEDIO',
      descripcion: `Brecha promedio de $${Math.round(brechaPromAbs).toLocaleString('es-AR')} — ${tasaInconsistencia.toFixed(0)}% de los turnos con desvío`,
      peso: partes.brecha,
    });
  }

  if (partes.comportamiento >= 8) {
    señales.push({
      tipo: 'COMPORTAMIENTO_PEERS',
      descripcion: `Comportamiento estadísticamente diferente al resto del equipo en el mismo turno`,
      peso: partes.comportamiento,
    });
  }

  if (partes.omision >= 3) {
    señales.push({
      tipo: 'OMISION_CONTEOS',
      descripcion: `${(tasaOmision * 100).toFixed(0)}% de los conteos aleatorios no respondidos`,
      peso: partes.omision,
    });
  }

  if (rachaLimpia >= 7) {
    señales.push({
      tipo: 'RACHA_POSITIVA',
      descripcion: `${rachaLimpia} turnos consecutivos sin brecha significativa`,
      peso: -10, // señal positiva
    });
  }

  return {
    empleado: nombreEmpleado,
    score,
    nivel: nivelRiesgo,
    señales,
    detalle: {
      n_turnos: nTurnos,
      brecha_promedio_abs: Math.round(brechaPromAbs),
      tasa_inconsistencia: Math.round(tasaInconsistencia),
      tasa_omision_conteos: Math.round(tasaOmision * 100),
      racha_limpia: rachaLimpia,
      ultimo_turno: hist.ultimo_turno_fecha,
    },
    puntajes_parciales: partes,
    cusum_turnos: cusumTurnos.map(c => ({
      turno: c.turno,
      disponible: c.disponible,
      pct_umbral: c.pct_umbral ?? null,
      alarma: c.alarma ?? false,
    })),
  };
}

// ─── ERM completo del negocio ─────────────────────────────────────────────────

async function calcularERMNegocio(usuarioId) {
  // Todos los empleados activos con turnos en los últimos 30 días
  const empRes = await pool.query(
    `SELECT DISTINCT nombre_empleado
     FROM turnos_caja
     WHERE usuario_id=$1 AND estado='cerrado'
       AND hora_apertura >= NOW() - INTERVAL '30 days'
     ORDER BY nombre_empleado`,
    [usuarioId]
  );

  if (empRes.rows.length === 0) {
    return {
      empleados: [],
      resumen: { total: 0, rojos: 0, amarillos: 0, verdes: 0, sin_datos: 0 },
    };
  }

  const empleados = await Promise.all(
    empRes.rows.map(r => calcularRiesgoEmpleado(usuarioId, r.nombre_empleado))
  );

  // Ordenar: rojo primero, luego amarillo, luego verde
  const orden = { rojo: 0, amarillo: 1, verde: 2, sin_datos: 3 };
  empleados.sort((a, b) => {
    const oa = orden[a.nivel] ?? 4;
    const ob = orden[b.nivel] ?? 4;
    if (oa !== ob) return oa - ob;
    return (b.score ?? -1) - (a.score ?? -1);
  });

  const resumen = {
    total: empleados.length,
    rojos: empleados.filter(e => e.nivel === 'rojo').length,
    amarillos: empleados.filter(e => e.nivel === 'amarillo').length,
    verdes: empleados.filter(e => e.nivel === 'verde').length,
    sin_datos: empleados.filter(e => e.nivel === 'sin_datos').length,
  };

  // Alerta de equipo: si >50% están en rojo/amarillo
  const pctRiesgo = (resumen.rojos + resumen.amarillos) / (empleados.length || 1);
  const alertaEquipo = pctRiesgo >= 0.5
    ? `${Math.round(pctRiesgo * 100)}% del equipo tiene señales activas — revisar operación general`
    : null;

  return {
    empleados,
    resumen,
    alerta_equipo: alertaEquipo,
  };
}

module.exports = { calcularERMNegocio, calcularRiesgoEmpleado };
