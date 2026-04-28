// orchestrator.js — NICOLE Central Orchestrator
// Recolecta los outputs de todos los módulos de detección y los cruza
// antes de que motor.js emita cualquier señal.
// No modifica ningún archivo existente. Solo los llama y decide.

'use strict';

const pool = require('./db');
const { agregarPorTurno, detectarAnomalias } = require('./deteccion');
const { calcularCUSUMCompleto }              = require('./cusum');
const { detectarPatronesSemana }             = require('./patron_semanal');
const { cruzarCatalogoConTicket }            = require('./cruce_catalogo');
const { calcularRiesgoEmpleado }             = require('./erm');
const { analizarCruceTurno }                 = require('./cruce_variables');

const TOTAL_MODULOS = 6;

// ─── Risk score desde detección ───────────────────────────────────────────────
// 60 pts por cobertura de métricas anómalas (0-3 métricas distintas),
// 40 pts por magnitud del z-score más alto (normalizado a z=4 como techo).

function calcularRiskScoreMotor(deteccion) {
  if (!deteccion || deteccion.length === 0) return 0;
  const anomalias = deteccion.filter(a => a.es_anomalia);
  if (anomalias.length === 0) return 0;

  const metricas_unicas = new Set(anomalias.map(a => a.metrica)).size; // 0-3
  const max_z = Math.max(...anomalias.map(a => Math.abs(a.zscore)));

  return Math.min(
    Math.round((metricas_unicas / 3) * 60 + Math.min(max_z / 4, 1.0) * 40),
    100
  );
}

// ─── Score de contexto (ERM + CUSUM) ─────────────────────────────────────────
// ERM refleja riesgo acumulado por empleado (historial de 30 días).
// CUSUM refleja deriva conductual sostenida en la brecha del turno.
// Ponderación: ERM 60 % + CUSUM 40 %.

function calcularContextoScore(erm, cusum) {
  const erm_score  = erm?.score ?? 0;
  const cusum_pcts = (cusum?.turnos || [])
    .filter(t => t.disponible)
    .map(t => t.pct_umbral ?? 0);
  const cusum_score = cusum_pcts.length > 0
    ? Math.min(Math.max(...cusum_pcts), 100)
    : 0;

  return {
    erm_score,
    cusum_score,
    score_final: Math.round(erm_score * 0.6 + cusum_score * 0.4),
  };
}

// ─── Orquestador ─────────────────────────────────────────────────────────────
//
// Parámetros:
//   negocio_id   — usuario_id del dueño del negocio
//   uid          — nombre del empleado activo (string). null → ERM omitido.
//   turno_actual — turno_id del turno cerrado. null → cruce_variables omitido.
//
// Devuelve:
//   debe_emitir         — boolean: si motor.js puede emitir señales
//   confirmacion_cruzada — boolean: CUSUM en alarma + ≥2 métricas anómalas
//   risk_score_final    — 0-100: score compuesto para el dueño
//   señales_consolidadas — inputs listos para alert_manager
//   data_quality        — disponibilidad de módulos (incluye fallidos/6)

async function orchestrate({ negocio_id, uid = null, turno_actual = null }) {

  // detectarAnomalias recibe datos ya agregados, no un ID —
  // el orquestador hace el fetch propio para no depender de motor.js.
  let agregados = [];
  try {
    const txRes = await pool.query(
      'SELECT * FROM transacciones WHERE usuario_id = $1 ORDER BY fecha ASC',
      [negocio_id]
    );
    agregados = agregarPorTurno(txRes.rows);
  } catch { /* si falla, deteccion quedará null */ }

  // ── PASO 1: Recolección en paralelo ─────────────────────────────────────────

  const [
    rDeteccion,
    rCusum,
    rPatrones,
    rCatalogo,
    rERM,
    rCruce,
  ] = await Promise.allSettled([
    Promise.resolve(detectarAnomalias(agregados)),
    calcularCUSUMCompleto(negocio_id),
    detectarPatronesSemana(negocio_id),
    cruzarCatalogoConTicket(negocio_id),
    uid          ? calcularRiesgoEmpleado(negocio_id, uid) : Promise.resolve(null),
    turno_actual ? analizarCruceTurno(turno_actual)        : Promise.resolve(null),
  ]);

  const deteccion = rDeteccion.status === 'fulfilled' ? rDeteccion.value : null;
  const cusum     = rCusum.status     === 'fulfilled' ? rCusum.value     : null;
  const patrones  = rPatrones.status  === 'fulfilled' ? rPatrones.value  : null;
  const catalogo  = rCatalogo.status  === 'fulfilled' ? rCatalogo.value  : null;
  const erm       = rERM.status       === 'fulfilled' ? rERM.value       : null;
  const cruce     = rCruce.status     === 'fulfilled' ? rCruce.value     : null;

  const modulos_fallidos = [deteccion, cusum, patrones, catalogo, erm, cruce]
    .filter(v => v === null).length;

  // ── PASO 2: Cruces ────────────────────────────────────────────────────────

  // Cruce 1 — CUSUM + Detección
  // Confirma cuando la deriva sostenida (CUSUM) coincide con anomalías
  // simultáneas en al menos 2 métricas distintas de deteccion.js.
  const anomalias            = (deteccion || []).filter(a => a.es_anomalia);
  const cusum_en_alarma      = cusum?.tiene_alarma ?? false;
  const confirmacion_cruzada = cusum_en_alarma && anomalias.length >= 2;

  // Scores parciales y final
  const risk_score_motor = calcularRiskScoreMotor(deteccion);
  const contexto         = calcularContextoScore(erm, cusum);
  const risk_score_final = Math.round(risk_score_motor * 0.6 + contexto.score_final * 0.4);

  // Reglas de emisión:
  //   confirmacion_cruzada = true → emitir siempre, ignorar gate de ≥2 señales de motor.js
  //   risk_score_final < 30 sin cruce activo → silencio, aunque motor.js haya detectado
  const debe_emitir = confirmacion_cruzada || risk_score_final >= 30;

  // Señales consolidadas — input directo para alert_manager en motor.js
  const señales_consolidadas = {
    anomalias,
    cusum_alertas:  cusum?.alertas_cusum ?? [],
    patrones:       patrones             ?? [],
    catalogo_señal: catalogo?.señal      ?? null,
    cruce_señales:  cruce?.señales       ?? [],
    erm_nivel:      erm?.nivel           ?? null,
    erm_score:      erm?.score           ?? null,
  };

  return {
    negocio_id,
    uid,
    turno_actual,

    // Outputs crudos por módulo (null si el módulo falló)
    outputs: { deteccion, cusum, patrones, catalogo, erm, cruce },

    // Señales individuales — formato para motor.js
    señales_individuales: {
      cusum: cusum ?? { alertas_cusum: [], turnos: [] },
      patron_semanal: patrones ?? [],
      cruce_catalogo: catalogo ?? { disponible: false },
    },

    // Scoring
    risk_score_motor,
    contexto,
    risk_score_final,
    confirmacion_cruzada,
    debe_emitir,

    // Señales listas para motor.js / alert_manager
    señales_consolidadas,

    // Calidad de datos — tasa de módulos que respondieron (modulos_fallidos / 6)
    data_quality: {
      modulos_ok:          TOTAL_MODULOS - modulos_fallidos,
      modulos_fallidos,
      tasa_disponibilidad: Math.round(((TOTAL_MODULOS - modulos_fallidos) / TOTAL_MODULOS) * 100),
    },
  };
}

module.exports = { orchestrate };
