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
const { calcularERMNegocio, calcularRiesgoEmpleado } = require('./erm');
const { analizarCruceTurno }                 = require('./cruce_variables');
const { atribuirAnomaliaSucursal }           = require('./perfil_sucursal');

const TOTAL_MODULOS = 6;

// ─── Risk score desde detección ───────────────────────────────────────────────
// 60 pts por cobertura de métricas anómalas (0-3 métricas distintas),
// 40 pts por magnitud del z-score más alto (normalizado a z=4 como techo).

// Solo se mira lo reciente (hoy y los 2 días anteriores, hora Argentina): un desvío de hace 3 semanas
// no puede seguir abriendo la puerta de las alertas.
const DIAS_RECIENTES = 3;

function soloRecientes(deteccion) {
  const hoy = new Date(Date.now() - 3 * 3600 * 1000);
  const corte = new Date(hoy.getTime() - (DIAS_RECIENTES - 1) * 86400000).toISOString().slice(0, 10);
  return (deteccion || []).filter(d => d.fecha && d.fecha !== 'sin_fecha' && d.fecha >= corte);
}

// Una señal "de pérdida": ventas o ticket que BAJAN (una venta alta no es una fuga) o efectivo que se desvía.
function esSeñalDePerdida(d) {
  return !!d.es_anomalia && (d.metrica === 'ratio_efectivo' || d.direccion === 'bajo');
}

// true si en un mismo turno hay al menos 2 métricas distintas con señal de pérdida
function hayTurnoConDosSeñales(lista) {
  const porTurno = {};
  for (const d of (lista || []).filter(esSeñalDePerdida)) {
    (porTurno[d.clave] = porTurno[d.clave] || new Set()).add(d.metrica);
  }
  return Object.values(porTurno).some(s => s.size >= 2);
}

function calcularRiskScoreMotor(deteccion) {
  const recientes = soloRecientes(deteccion);
  if (recientes.length === 0) return 0;

  // Mayor desvío reciente por métrica, solo si pasó el umbral de anomalía. Ventas y ticket solo cuentan si bajan.
  const getZ = (metrica, soloBajas) => {
    const zs = recientes
      .filter(d => d.es_anomalia && d.metrica === metrica && (!soloBajas || d.direccion === 'bajo'))
      .map(d => Math.abs(d.zscore || 0));
    return zs.length ? Math.max(...zs) : 0;
  };

  const z_ticket = getZ('ticket_promedio', true);
  const z_ratio  = getZ('ratio_efectivo', false);
  const z_ventas = getZ('ventas_por_turno', true);

  // Consistencia: 1 si en un mismo turno hay al menos 2 señales distintas, 0 si no
  const consistencia = hayTurnoConDosSeñales(recientes) ? 1 : 0;

  // Fórmula inamovible Lumo
  const loss_score = (z_ticket * 0.3) + (z_ratio * 0.4) + (z_ventas * 0.2) + (consistencia * 0.1);

  // Normalizar a 0-100 (z-score típico máximo ~4.0)
  return Math.min(Math.round((loss_score / 4.0) * 100), 100);
}

// ─── Score de contexto (ERM + CUSUM) ─────────────────────────────────────────
// ERM refleja riesgo acumulado por empleado (historial de 30 días).
// CUSUM refleja deriva conductual sostenida en la brecha del turno.
// Ponderación: ERM 60 % + CUSUM 40 %.

function calcularContextoScore(erm, cusum) {
  const erm_score  = erm?.empleados?.[0]?.score ?? 0;
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
//   negocio_id   — id del negocio
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
      'SELECT * FROM transacciones WHERE negocio_id = $1 ORDER BY fecha ASC',
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
    calcularERMNegocio(negocio_id),
    turno_actual ? analizarCruceTurno(turno_actual)        : Promise.resolve(null),
  ]);

  const deteccion = rDeteccion.status === 'fulfilled' ? rDeteccion.value : null;
  const cusum     = rCusum.status     === 'fulfilled' ? rCusum.value     : null;
  const patrones  = rPatrones.status  === 'fulfilled' ? rPatrones.value  : null;
  const catalogo  = rCatalogo.status  === 'fulfilled' ? rCatalogo.value  : null;
  const erm       = rERM.status       === 'fulfilled' ? rERM.value       : null;
  const cruce     = rCruce.status     === 'fulfilled' ? rCruce.value     : null;

  // ── Atribución de anomalías por sucursal ───────────────────────────────────
  const sucursalesPorTurno = {};
  if (cusum?.turnos) {
    for (const t of cusum.turnos) {
      if (t.disponible && t.alerta) {
        const atribucion = await atribuirAnomaliaSucursal(negocio_id, t.turno).catch(() => null);
        if (atribucion?.sucursales_atribuidas?.length > 0) {
          sucursalesPorTurno[t.turno] = atribucion.sucursales_atribuidas;
        }
      }
    }
  }

  const modulos_fallidos = [deteccion, cusum, patrones, catalogo, erm, cruce]
    .filter(v => v === null).length;

  // ── PASO 2: Cruces ────────────────────────────────────────────────────────

  // Cruce 1 — CUSUM + Detección
  // Confirma cuando la deriva sostenida (CUSUM) coincide con anomalías
  // simultáneas en al menos 2 métricas distintas de deteccion.js.
  const anomalias            = soloRecientes(deteccion).filter(esSeñalDePerdida);
  const cusum_en_alarma      = cusum?.tiene_alarma ?? false;
  const confirmacion_cruzada = cusum_en_alarma && hayTurnoConDosSeñales(anomalias);

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
    sucursales_atribuidas: sucursalesPorTurno,
    patrones:       patrones             ?? [],
    catalogo_señal: catalogo?.señal      ?? null,
    cruce_señales:  cruce?.señales       ?? [],
    erm_nivel:      erm?.empleados?.[0]?.nivel ?? null,
    erm_score:      erm?.empleados?.[0]?.score ?? null,
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
      sucursales_atribuidas: sucursalesPorTurno,
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
