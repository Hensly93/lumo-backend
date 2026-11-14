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
const VENTANA_DIAS = 14;      // período vigilado: los últimos 14 días
const REFERENCIA_DIAS = 60;   // historia previa para saber qué es "normal" (sin mezclarla con lo vigilado)
const ALPHA_BLEND_DIAS = 21;

// ─── Calcular CUSUM para un empleado/turno ────────────────────────────────────

async function calcularCUSUM(usuarioId, tipoTurno, metrica = 'brecha', sucursalId = null) {
  const res = await pool.query(
    `SELECT
       brecha as valor,
       hora_apertura,
       nombre_empleado
     FROM turnos_caja
     WHERE negocio_id=$1 AND LOWER(tipo_turno)=LOWER($2)
       AND estado='cerrado' AND brecha IS NOT NULL
       AND hora_apertura >= NOW() - INTERVAL '${VENTANA_DIAS + REFERENCIA_DIAS} days'
       AND ($3::integer IS NULL OR sucursal_id = $3)
     ORDER BY hora_apertura ASC`,
    [usuarioId, tipoTurno, sucursalId]
  );

  // Referencia (lo normal) = turnos ANTERIORES a los últimos 14 días. Antes la referencia era la primera
  // mitad de esos mismos 14 días: una deriva de más de una semana quedaba adentro de "lo normal" y no se veía.
  const corte = Date.now() - VENTANA_DIAS * 86400000;
  let referencia = res.rows.filter(r => new Date(r.hora_apertura).getTime() < corte);
  let vigilados = res.rows.filter(r => new Date(r.hora_apertura).getTime() >= corte);
  if (referencia.length < 5) {
    // Negocio nuevo: sin historia previa se usa la primera mitad como antes
    const todos = res.rows;
    if (todos.length < 5) return { disponible: false, motivo: 'insuficientes_datos', n: todos.length, turno: tipoTurno };
    const mitad = Math.max(Math.floor(todos.length / 2), 3);
    referencia = todos.slice(0, mitad);
    vigilados = todos.slice(mitad);
  }
  if (vigilados.length === 0) return { disponible: false, motivo: 'sin_turnos_recientes', n: 0, turno: tipoTurno };

  const valores = vigilados.map(r => parseFloat(r.valor));
  const empleados = vigilados.map(r => r.nombre_empleado);
  const n = valores.length;

  // Media y σ robustas de la referencia (mediana y MAD: un par de cierres raros no inflan "lo normal")
  const ref = referencia.map(r => parseFloat(r.valor)).sort((a, b) => a - b);
  const med = (arr) => arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2;
  const mu = med(ref);
  const mad = med(ref.map(v => Math.abs(v - mu)).sort((a, b) => a - b));
  const media = ref.reduce((a, b) => a + b, 0) / ref.length;
  const std = Math.sqrt(ref.reduce((a, b) => a + Math.pow(b - media, 2), 0) / ref.length);
  const sigma = Math.max(1.4826 * mad || std, 50); // piso de $50 para no alarmar por centavos

  const k = K_FACTOR * sigma;
  const h = H_FACTOR * sigma;

  // CUSUM de dos lados (S+ para aumentos, S- para disminuciones)
  let sPos = 0;
  let sNeg = 0;
  let inicioRunPos = 0;
  let inicioRunNeg = 0;
  const serie = [];
  let alarmaDetectada = false;
  let indiceAlarma = -1;

  for (let i = 0; i < n; i++) {
    const x = valores[i];
    const incPos = (x - mu) - k;
    const incNeg = -(x - mu) - k;

    sPos = Math.max(0, sPos + incPos);
    sNeg = Math.max(0, sNeg + incNeg);

    if (sPos === 0) inicioRunPos = i + 1;
    if (sNeg === 0) inicioRunNeg = i + 1;

    serie.push({ valor: x, sPos: Math.round(sPos), sNeg: Math.round(sNeg), incPos, incNeg, empleado: empleados[i] });

    if (!alarmaDetectada && (sPos > h || sNeg > h)) {
      alarmaDetectada = true;
      indiceAlarma = i;
    }
  }

  const ultimoS = serie[serie.length - 1];
  const pctUmbral = Math.max(ultimoS.sPos, ultimoS.sNeg) / h;
  const direccion = ultimoS.sPos > ultimoS.sNeg ? 'creciente' : 'decreciente';

  // Atribución: sumar incrementos positivos por empleado, solo dentro de la racha activa
  const inicioRun = direccion === 'creciente' ? inicioRunPos : inicioRunNeg;
  const campoIncremento = direccion === 'creciente' ? 'incPos' : 'incNeg';

  const contribucionesParciales = {};
  for (let i = inicioRun; i < n; i++) {
    const inc = serie[i][campoIncremento];
    if (inc > 0) {
      const emp = serie[i].empleado;
      contribucionesParciales[emp] = (contribucionesParciales[emp] || 0) + inc;
    }
  }

  const totalPositivo = Object.values(contribucionesParciales).reduce((a, b) => a + b, 0) || 1;
  const contribucionPorEmpleado = {};
  for (const [emp, val] of Object.entries(contribucionesParciales)) {
    contribucionPorEmpleado[emp] = Math.round((val / totalPositivo) * 1000) / 1000;
  }

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
    contribucion_por_empleado: contribucionPorEmpleado,
    alerta: alarmaDetectada ? (() => {
      const turnoTxt = { manana: 'mañana', tarde: 'tarde', noche: 'noche' }[String(tipoTurno).toLowerCase()] || tipoTurno;
      const desde = indiceAlarma >= 0 ? indiceAlarma : 0;
      const diferencia = Math.round(valores.slice(inicioRun).reduce((a, v) => a + (v - mu), 0));
      return {
        tipo: 'CUSUM_CAMBIO_CONDUCTUAL',
        prioridad: pctUmbral > 1.5 ? 'critico' : 'atencion',
        contexto: `${String(tipoTurno).toLowerCase()}_${sucursalId ?? 'todos'}`,
        sucursal_id: sucursalId,
        mensaje: `Cambio sostenido en los cierres del turno ${turnoTxt}: la diferencia de caja viene ${direccion === 'creciente' ? 'faltando' : 'sobrando'} de forma repetida en los últimos ${n - desde} turnos (unos $${Math.abs(diferencia).toLocaleString('es-AR')} por encima de lo normal en total).`,
        accion: `Revisá los últimos ${n - desde} cierres del turno ${turnoTxt}.`,
        impacto_pesos: Math.abs(diferencia),
        contribucion_por_empleado: contribucionPorEmpleado,
        zscore: pctUmbral * H_FACTOR,
      };
    })() : null,
  };
}

// ─── CUSUM para todos los turnos del usuario ──────────────────────────────────

async function calcularCUSUMCompleto(negocioId, sucursalId = null) {
  const TURNOS = ['manana', 'tarde', 'noche'];
  // Cada local tiene su propia caja: con varios locales se vigila cada turno de cada local por separado
  // (mezclarlos diluye la deriva de una caja con los cierres normales de la otra).
  let locales = [sucursalId];
  if (sucursalId == null) {
    try {
      const r = await pool.query(
        `SELECT DISTINCT sucursal_id FROM turnos_caja
         WHERE negocio_id=$1 AND estado='cerrado' AND hora_apertura >= NOW() - INTERVAL '${VENTANA_DIAS + REFERENCIA_DIAS} days'`,
        [negocioId]
      );
      const ids = r.rows.map(x => x.sucursal_id).filter(x => x != null);
      if (ids.length > 1) locales = ids;
    } catch (e) { /* se sigue con el negocio entero */ }
  }
  const tareas = [];
  for (const loc of locales) for (const t of TURNOS) {
    tareas.push(calcularCUSUM(negocioId, t, 'brecha', loc)
      .then(r => ({ ...r, turno: r.turno || t, sucursal_id: loc }))
      .catch(() => ({ disponible: false, turno: t, sucursal_id: loc })));
  }
  const resultados = await Promise.all(tareas);

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

async function resetBaselinePorCambioConfirmado(negocioId) {
  const txRes = await pool.query(
    'SELECT * FROM transacciones WHERE negocio_id=$1 ORDER BY fecha ASC',
    [negocioId]
  );

  if (txRes.rows.length < 10) return { ok: false, motivo: 'insuficientes_transacciones' };

  const ahora = new Date();
  const cutoff = new Date(ahora.getTime() - ALPHA_BLEND_DIAS * 24 * 60 * 60 * 1000);

  const recientes = txRes.rows.filter(t => new Date(t.fecha) >= cutoff);
  const historicas = txRes.rows.filter(t => new Date(t.fecha) < cutoff);

  if (recientes.length < 5) return { ok: false, motivo: 'pocos_datos_recientes' };

  const alpha = 0.7;

  function metricasDesde(rows) {
    if (!rows.length) return null;
    const montos = rows.map(t => parseFloat(t.monto)).filter(m => m > 0);
    const ticket = montos.reduce((a, b) => a + b, 0) / (montos.length || 1);

    const porTurno = {};
    rows.forEach(t => {
      const dia = new Date(t.fecha).toISOString().split('T')[0];
      const clave = `${t.turno || 'SIN_TURNO'}_${dia}`;
      porTurno[clave] = (porTurno[clave] || 0) + parseFloat(t.monto);
    });
    const totalesTurno = Object.values(porTurno);
    const ventasTurno = totalesTurno.reduce((a, b) => a + b, 0) / (totalesTurno.length || 1);

    const conMetodo = rows.filter(t => t.metodo_pago);
    const ratioEf = conMetodo.length > 0
      ? conMetodo.filter(t => t.metodo_pago?.toLowerCase() === 'efectivo').length / conMetodo.length
      : null;

    return { ticket, ventasTurno, ratioEf };
  }

  const mRec = metricasDesde(recientes);
  const mHist = historicas.length >= 5 ? metricasDesde(historicas) : mRec;

  const actualizaciones = [
    ['ticket_promedio',  alpha * mRec.ticket      + (1 - alpha) * mHist.ticket],
    ['ventas_por_turno', alpha * mRec.ventasTurno + (1 - alpha) * mHist.ventasTurno],
  ];
  if (mRec.ratioEf !== null && mHist.ratioEf !== null) {
    actualizaciones.push(['ratio_efectivo', alpha * mRec.ratioEf + (1 - alpha) * mHist.ratioEf]);
  }

  for (const [metrica, valor] of actualizaciones) {
    await pool.query(
      `INSERT INTO baseline_negocio(negocio_id, sucursal_id, metrica, valor, total_transacciones, dia_semana, updated_at)
       VALUES($1,NULL,$2,$3,$4,7,NOW())
       ON CONFLICT (negocio_id, COALESCE(sucursal_id, 0), metrica, dia_semana) DO UPDATE
       SET valor=EXCLUDED.valor, total_transacciones=EXCLUDED.total_transacciones, updated_at=NOW()`,
      [negocioId, metrica, Math.round(valor * 100) / 100, txRes.rows.length]
    );
  }

  return {
    ok: true,
    metricas_actualizadas: actualizaciones.map(([m, v]) => ({ metrica: m, valor_nuevo: Math.round(v) })),
    alpha_usado: alpha,
    dias_ventana: ALPHA_BLEND_DIAS,
    n_recientes: recientes.length,
    n_historicas: historicas.length,
  };
}

module.exports = { calcularCUSUM, calcularCUSUMCompleto, resetBaselinePorCambioConfirmado };
