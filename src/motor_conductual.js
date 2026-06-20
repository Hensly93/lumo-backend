// motor_conductual.js — Lumo S8
// NICOLE P6 + P7: umbral dinámico por celda + EWTA (Error-Weighted Threshold Adaptation)
//
// P6: El umbral z-score no es fijo (2.5). Cada celda (turno × día × condición) tiene
//     su propio umbral calculado desde la varianza histórica de esa celda.
//     Celdas con poca historia heredan el umbral global.
//
// P7: EWTA — cada vez que el dueño confirma o descarta una alerta, el umbral de esa
//     celda se ajusta:
//       FP confirmada como falsa → umbral × (1 + 0.15 × FP_rate) — sube, menos sensible
//       TP confirmada como real  → umbral × (1 - 0.08 × conf_rate) — baja, más sensible
//     Rango: [0.5, 3.0]
//     Activa con ≥ 5 feedbacks en esa celda.

const pool = require('./db');

const UMBRAL_GLOBAL_DEFAULT = 2.5;
const UMBRAL_MIN = 0.5;
const UMBRAL_MAX = 3.0;
const MIN_FEEDBACKS_EWTA = 5;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function celdaKey(tipoTurno, diaSemana, condicion = 'normal') {
  // diaSemana: 0=dom ... 6=sab | condicion: normal, feriado, lluvia, quincena
  return `${tipoTurno}|${diaSemana}|${condicion}`;
}

function condicionDesdeContexto(ctx) {
  if (!ctx) return 'normal';
  if (ctx.esFeriado) return 'feriado';
  if (ctx.clima?.lluvia) return 'lluvia';
  if (ctx.esDiaCobro || ctx.esFinQuincena) return 'quincena';
  return 'normal';
}

// ─── P6: Calcular umbral de una celda ────────────────────────────────────────
// Usa las brechas históricas de esa celda para calibrar el umbral.
// Si hay pocos datos (<5 turnos en la celda), hereda el umbral global.

async function calcularUmbralCelda(negocioId, tipoTurno, diaSemana, condicion = 'normal') {
  // Primero: ver si hay umbral P7 guardado para esta celda
  const umbrales = await pool.query(
    `SELECT umbral_actual FROM umbrales_celda
     WHERE negocio_id=$1 AND tipo_turno=$2 AND dia_semana=$3 AND condicion=$4`,
    [negocioId, tipoTurno, diaSemana, condicion]
  );
  if (umbrales.rows.length > 0) {
    return parseFloat(umbrales.rows[0].umbral_actual);
  }

  // Sin umbral guardado: calcular desde historial de la celda
  const hist = await pool.query(
    `SELECT ABS(brecha) as brecha_abs
     FROM turnos_caja
     WHERE negocio_id=$1 AND tipo_turno=$2
       AND EXTRACT(DOW FROM hora_apertura) = $3
       AND estado='cerrado' AND brecha IS NOT NULL
       AND hora_apertura >= NOW() - INTERVAL '90 days'`,
    [negocioId, tipoTurno, diaSemana]
  );

  if (hist.rows.length < 5) {
    // Sin historia suficiente → umbral global
    return UMBRAL_GLOBAL_DEFAULT;
  }

  const valores = hist.rows.map(r => parseFloat(r.brecha_abs));
  const media = valores.reduce((a, b) => a + b, 0) / valores.length;
  const std = Math.sqrt(valores.reduce((a, b) => a + Math.pow(b - media, 2), 0) / valores.length);

  // Umbral = media + 2.5 × std, normalizado
  // Si std es muy bajo (negocio muy estable) → umbral más bajo
  // Si std es muy alto (negocio variable)    → umbral más alto
  const umbralCalculado = std > 0 ? Math.min(Math.max(2.0, 2.5 * (1 + std / (media || 1))), UMBRAL_MAX) : UMBRAL_GLOBAL_DEFAULT;

  return umbralCalculado;
}

// ─── P7: Registrar feedback y adaptar umbral ─────────────────────────────────

async function adaptarUmbralPorFeedback(negocioId, alertaId) {
  // Leer la alerta y su feedback
  const alerta = await pool.query(
    `SELECT tipo_alerta, contexto, prioridad, feedback_confirmada
     FROM alertas_gestionadas
     WHERE id=$1 AND negocio_id=$2 AND feedback_confirmada IS NOT NULL`,
    [alertaId, negocioId]
  );
  if (alerta.rows.length === 0) return { ok: false, motivo: 'alerta_sin_feedback' };

  const { tipo_alerta, contexto, feedback_confirmada } = alerta.rows[0];

  // Extraer celda del contexto (formato: "TURNO|DIA|CONDICION" o solo turno)
  const partes = (contexto || '').split('|');
  const tipoTurno = partes[0] || 'GENERAL';
  const diaSemana = parseInt(partes[1]) || new Date().getDay();
  const condicion = partes[2] || 'normal';

  // Contar feedbacks anteriores en esta celda
  const stats = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE feedback_confirmada = false) as falsos_positivos,
       COUNT(*) FILTER (WHERE feedback_confirmada = true)  as verdaderos_positivos,
       COUNT(*) as total
     FROM alertas_gestionadas
     WHERE negocio_id=$1 AND tipo_alerta=$2
       AND contexto LIKE $3
       AND feedback_confirmada IS NOT NULL`,
    [negocioId, tipo_alerta, `${tipoTurno}%`]
  );

  const { falsos_positivos, verdaderos_positivos, total } = stats.rows[0];
  const totalN = parseInt(total);

  if (totalN < MIN_FEEDBACKS_EWTA) {
    return { ok: true, adaptado: false, motivo: `insuficientes_feedbacks (${totalN}/${MIN_FEEDBACKS_EWTA})` };
  }

  // Calcular umbral actual
  const umbralActual = await calcularUmbralCelda(negocioId, tipoTurno, diaSemana, condicion);

  const fpRate = parseInt(falsos_positivos) / totalN;
  const confRate = parseInt(verdaderos_positivos) / totalN;

  let nuevoUmbral;
  if (!feedback_confirmada) {
    // Falso positivo: subir umbral (menos sensible)
    nuevoUmbral = umbralActual * (1 + 0.15 * fpRate);
  } else {
    // Verdadero positivo: bajar umbral (más sensible)
    nuevoUmbral = umbralActual * (1 - 0.08 * confRate);
  }

  // Clamping al rango permitido
  nuevoUmbral = Math.min(Math.max(nuevoUmbral, UMBRAL_MIN), UMBRAL_MAX);
  nuevoUmbral = Math.round(nuevoUmbral * 100) / 100;

  // Persistir
  await pool.query(
    `INSERT INTO umbrales_celda(negocio_id, tipo_turno, dia_semana, condicion, umbral_actual, n_feedbacks, updated_at)
     VALUES($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (negocio_id, tipo_turno, dia_semana, condicion)
     DO UPDATE SET umbral_actual=$5, n_feedbacks=$6, updated_at=NOW()`,
    [negocioId, tipoTurno, diaSemana, condicion, nuevoUmbral, totalN]
  );

  return {
    ok: true,
    adaptado: true,
    celda: celdaKey(tipoTurno, diaSemana, condicion),
    umbral_anterior: umbralActual,
    umbral_nuevo: nuevoUmbral,
    fp_rate: Math.round(fpRate * 100),
    conf_rate: Math.round(confRate * 100),
    n_feedbacks: totalN,
  };
}

// ─── GET umbrales actuales del usuario ───────────────────────────────────────

async function getUmbralesUsuario(negocioId) {
  const res = await pool.query(
    `SELECT tipo_turno, dia_semana, condicion, umbral_actual, n_feedbacks, updated_at
     FROM umbrales_celda
     WHERE negocio_id=$1
     ORDER BY tipo_turno, dia_semana`,
    [negocioId]
  );
  return res.rows.map(r => ({
    celda: celdaKey(r.tipo_turno, r.dia_semana, r.condicion),
    tipo_turno: r.tipo_turno,
    dia_semana: r.dia_semana,
    condicion: r.condicion,
    umbral_actual: parseFloat(r.umbral_actual),
    n_feedbacks: r.n_feedbacks,
    updated_at: r.updated_at,
  }));
}

// ─── Evaluar z-score con umbral dinámico ─────────────────────────────────────
// Reemplaza el z-score fijo del motor. Recibe valor observado + contexto.

async function evaluarConUmbralDinamico(negocioId, valor, baseline, tipoTurno, ctx) {
  const diaSemana = ctx?.diaSemana ?? new Date().getDay();
  const condicion = condicionDesdeContexto(ctx);
  const umbral = await calcularUmbralCelda(negocioId, tipoTurno, diaSemana, condicion);

  if (!baseline || !baseline.valor || baseline.total_transacciones < 10) {
    return { zscore: null, supera_umbral: false, umbral, confianza: 0 };
  }

  const media = parseFloat(baseline.valor);
  const mad = parseFloat(baseline.mad || baseline.std || media * 0.3);

  // Z-score robusto (MAD-based)
  const zscore = mad > 0 ? (valor - media) / (1.4826 * mad) : 0;
  const superaUmbral = Math.abs(zscore) > umbral;

  const n = baseline.total_transacciones;
  const confianza = n < 20 ? 65 : n < 40 ? 80 : 95;

  return {
    zscore: Math.round(zscore * 100) / 100,
    supera_umbral: superaUmbral,
    umbral,
    condicion,
    confianza,
    celda: celdaKey(tipoTurno, diaSemana, condicion),
  };
}

module.exports = {
  calcularUmbralCelda,
  adaptarUmbralPorFeedback,
  getUmbralesUsuario,
  evaluarConUmbralDinamico,
  condicionDesdeContexto,
};
