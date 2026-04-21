// cusum.js — Lumo S8
// NICOLE P8: CUSUM + Baseline Reset Protocol
//
// CUSUM detecta cambio conductual sostenido — no un spike aislado
// sino una deriva acumulada que el z-score solo no detecta.
//
// Parámetros:
//   k = 0.5σ  (slack — umbral de detección)
//   h = 4-5σ  (umbral de alarma acumulada)
//   ventana = 14 días de historial para estimar σ
//
// Baseline Reset Protocol:
//   Cuando el CUSUM detecta un cambio confirmado (feedback TP),
//   el baseline se resetea con alpha-blending de 21 días
//   para incorporar el nuevo nivel sin perder memoria larga.

const pool = require('./db');

const K_FACTOR = 0.5;   // slack como fracción de σ
const H_FACTOR = 4.5;   // umbral alarma como múltiplo de σ
const VENTANA_DIAS = 14;
const ALPHA_BLEND_DIAS = 21;

// ─── Calcular CUSUM para un empleado/turno ────────────────────────────────────

async function calcularCUSUM(usuarioId, tipoTurno, metrica = 'brecha') {
  // Obtener serie temporal de la métrica en el turno
  const res = await pool.query(
    `SELECT
       ABS(brecha) as valor,
       hora_apertura
     FROM turnos_caja
     WHERE usuario_id=$1 AND tipo_turno=$2
       AND estado='cerrado' AND brecha IS NOT NULL
       AND hora_apertura >= NOW() - INTERVAL '${VENTANA_DIAS} days'
     ORDER BY hora_apertura ASC`,
    [usuarioId, tipoTurno]
  );

  if (res.rows.length < 5) {
    return { disponible: false, motivo: 'insuficientes_datos', n: res.rows.length };
  }

  const valores = res.rows.map(r => parseFloat(r.valor));
  const n = valores.length;

  // Estimar media y σ de la primera mitad (baseline de referencia)
  const mitad = Math.max(Math.floor(n / 2), 3);
  const baseline = valores.slice(0, mitad);
  const mu = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const sigma = Math.sqrt(baseline.reduce((a, b) => a + Math.pow(b - mu, 2), 0) / baseline.length) || mu * 0.3;

  const k = K_FACTOR * sigma;
  const h = H_FACTOR * sigma;

  // CUSUM de dos lados (S+ para aumentos, S- para disminuciones)
  let sPos = 0;
  let sNeg = 0;
  const serie = [];
  let alarmaDetectada = false;
  let indiceAlarma = -1;

  for (let i = 0; i < n; i++) {
    const x = valores[i];
    sPos = Math.max(0, sPos + (x - mu) - k);
    sNeg = Math.max(0, sNeg - (x - mu) - k);

    serie.push({ valor: x, sPos: Math.round(sPos), sNeg: Math.round(sNeg) });

    if (!alarmaDetectada && (sPos > h || sNeg > h)) {
      alarmaDetectada = true;
      indiceAlarma = i;
    }
  }

  const ultimoS = serie[serie.length - 1];
  const pctUmbral = Math.max(ultimoS.sPos, ultimoS.sNeg) / h;
  const direccion = ultimoS.sPos > ultimoS.sNeg ? 'creciente' : 'decreciente';

  return {
    disponible: true,
    turno: tipoTurno,
    metrica,
    n_observaciones: n,
    mu: Math.round(mu),
    sigma: Math.round(sigma),
    k: Math.round(k),
    h: Math.round(h),
    cusum_actual: { sPos: ultimoS.sPos, sNeg: ultimoS.sNeg },
    alarma: alarmaDetectada,
    pct_umbral: Math.min(Math.round(pctUmbral * 100), 200),
    direccion,
    indice_alarma: indiceAlarma,
    alerta: alarmaDetectada ? {
      tipo: 'CUSUM_CAMBIO_CONDUCTUAL',
      prioridad: pctUmbral > 1.5 ? 'critico' : 'atencion',
      mensaje: `Cambio conductual sostenido en turno ${tipoTurno}: brecha ${direccion} por ${n - indiceAlarma} turnos consecutivos.`,
      accion: `Revisá los últimos ${n - indiceAlarma} cierres del turno ${tipoTurno}. Este patrón sostenido supera el umbral estadístico.`,
      zscore: pctUmbral * H_FACTOR,
    } : null,
  };
}

// ─── CUSUM para todos los turnos del usuario ──────────────────────────────────

async function calcularCUSUMCompleto(usuarioId) {
  const TURNOS = ['MANANA', 'TARDE', 'NOCHE'];
  const resultados = await Promise.all(
    TURNOS.map(t => calcularCUSUM(usuarioId, t).catch(() => ({ disponible: false, turno: t })))
  );

  const alertas = resultados
    .filter(r => r.disponible && r.alarma && r.alerta)
    .map(r => r.alerta);

  return {
    turnos: resultados,
    alertas_cusum: alertas,
    tiene_alarma: alertas.length > 0,
  };
}

// ─── Baseline Reset Protocol ──────────────────────────────────────────────────
// Cuando un cambio es confirmado como real (feedback TP),
// recalcula el baseline con alpha-blending para incorporar el nuevo nivel.

async function resetBaselinePorCambioConfirmado(usuarioId) {
  // Obtener todas las transacciones recientes
  const txRes = await pool.query(
    'SELECT * FROM transacciones WHERE usuario_id=$1 ORDER BY fecha ASC',
    [usuarioId]
  );

  if (txRes.rows.length < 10) return { ok: false, motivo: 'insuficientes_transacciones' };

  // Alpha-blending: peso mayor a los últimos ALPHA_BLEND_DIAS días
  const ahora = new Date();
  const cutoff = new Date(ahora.getTime() - ALPHA_BLEND_DIAS * 24 * 60 * 60 * 1000);

  const recientes = txRes.rows.filter(t => new Date(t.fecha) >= cutoff);
  const historicas = txRes.rows.filter(t => new Date(t.fecha) < cutoff);

  if (recientes.length < 5) return { ok: false, motivo: 'pocos_datos_recientes' };

  // Recalcular baseline pesando más los datos recientes (alpha = 0.7)
  const alpha = 0.7;
  const montoReciente = recientes.reduce((a, b) => a + parseFloat(b.monto), 0) / recientes.length;
  const montoHistorico = historicas.length > 0
    ? historicas.reduce((a, b) => a + parseFloat(b.monto), 0) / historicas.length
    : montoReciente;

  const nuevoBaseline = alpha * montoReciente + (1 - alpha) * montoHistorico;

  // Actualizar baseline_negocio
  await pool.query(
    `INSERT INTO baseline_negocio(usuario_id, metrica, valor, total_transacciones, updated_at)
     VALUES($1,'ticket_promedio',$2,$3,NOW())
     ON CONFLICT (usuario_id, metrica) DO UPDATE
     SET valor=$2, total_transacciones=$3, updated_at=NOW()`,
    [usuarioId, Math.round(nuevoBaseline * 100) / 100, txRes.rows.length]
  );

  return {
    ok: true,
    baseline_anterior: Math.round(montoHistorico),
    baseline_nuevo: Math.round(nuevoBaseline),
    alpha_usado: alpha,
    dias_ventana: ALPHA_BLEND_DIAS,
    n_recientes: recientes.length,
    n_historicas: historicas.length,
  };
}

module.exports = { calcularCUSUM, calcularCUSUMCompleto, resetBaselinePorCambioConfirmado };
