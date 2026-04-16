const { detectarAnomalias } = require('./deteccion');
const { generarInsight, generarInsightMetrica } = require('./insights');
const { getBenchmarkSector, normalizarTipoNegocio, calcularZScoreSector } = require('./benchmarks_sector');
const { calcularMetricasNegocio, getBaselineNegocio } = require('./baseline_negocio');
const { calcularPesos, calcularScoreHibrido, determinarCapaOrigen, calcularZScorePropio } = require('./benchmark_hibrido');
const pool = require('./db');

const METRICAS = ['ticket_promedio', 'ventas_por_turno', 'ratio_efectivo'];
const UMBRAL_SEÑAL = 2.0;

// ─── Helpers ────────────────────────────────────────────────────────────────

function agregarPorTurno(transacciones) {
  const grupos = {};
  transacciones.forEach(t => {
    const dia = new Date(t.fecha).toISOString().split('T')[0];
    const clave = `${t.turno || 'SIN_TURNO'}_${dia}`;
    if (!grupos[clave]) grupos[clave] = { ...t, monto: 0 };
    grupos[clave].monto = Number(grupos[clave].monto) + Number(t.monto);
  });
  return Object.values(grupos);
}

function filtrarUltimosDias(transacciones, dias) {
  const corte = new Date();
  corte.setDate(corte.getDate() - dias);
  return transacciones.filter(t => new Date(t.fecha) >= corte);
}

// ─── Data Quality Score ──────────────────────────────────────────────────────
// Siempre visible en la respuesta. Componentes:
//   40% volumen      (max en 200 transacciones)
//   30% historial    (max en 30 días)
//   20% cobertura    (turnos distintos cubiertos, max en 3)
//   10% completitud  (% de txs con metodo_pago informado)

function calcularDataQualityScore(transacciones) {
  if (!transacciones || transacciones.length === 0) {
    return { score: 0, detalle: { volumen: 0, historial: 0, cobertura: 0, completitud: 0 } };
  }

  const n = transacciones.length;
  const fechas = transacciones.map(t => new Date(t.fecha).getTime());
  const diasHistorial = (Math.max(...fechas) - Math.min(...fechas)) / (1000 * 60 * 60 * 24);
  const turnos = new Set(transacciones.map(t => t.turno).filter(Boolean));
  const conMetodo = transacciones.filter(t => t.metodo_pago).length;

  const volumen     = Math.min(n / 200, 1.0);
  const historial   = Math.min(diasHistorial / 30, 1.0);
  const cobertura   = Math.min(turnos.size / 3, 1.0);
  const completitud = conMetodo / n;

  const score = Math.round((volumen * 0.4 + historial * 0.3 + cobertura * 0.2 + completitud * 0.1) * 100);

  return {
    score,
    detalle: {
      volumen:     Math.round(volumen * 100),
      historial:   Math.round(historial * 100),
      cobertura:   Math.round(cobertura * 100),
      completitud: Math.round(completitud * 100),
    }
  };
}

// ─── Señales de métricas ─────────────────────────────────────────────────────
// Devuelve sólo las métricas que superan el umbral de anomalía.
// Motor de Capa 3: blends Capa1 + Capa2 según pesos por volumen.

function evaluarSeñalesMetricas(metricasRecientes, benchmarkSector, baselineNegocio, pesos) {
  const señales = {};
  if (!metricasRecientes) return señales;

  for (const metrica of METRICAS) {
    const valor = metricasRecientes[metrica];
    if (valor === null || valor === undefined || valor === 0) continue;

    const bSector = benchmarkSector[metrica];
    const bPropio = baselineNegocio[metrica];
    if (!bSector && !bPropio) continue;

    const zCapa1 = bSector ? calcularZScoreSector(valor, bSector) : 0;
    const zCapa2 = bPropio ? calcularZScorePropio(valor, baselineNegocio, metrica) : 0;
    const scoreHibrido = calcularScoreHibrido({ scoreCapa1: zCapa1, scoreCapa2: zCapa2, pesos });

    if (Math.abs(scoreHibrido) >= UMBRAL_SEÑAL) {
      señales[metrica] = { scoreHibrido, zCapa1, zCapa2, valor };
    }
  }
  return señales;
}

// ─── Señales de sector por turno+día ─────────────────────────────────────────

function evaluarSeñalesSectorPorTurno(agregados, benchmarkSector) {
  const señales = new Set();
  const bVentas = benchmarkSector.ventas_por_turno;
  if (!bVentas) return señales;

  agregados.forEach(ag => {
    const dia = new Date(ag.fecha).toISOString().split('T')[0];
    const key = `${ag.turno || 'SIN_TURNO'}_${dia}`;
    const z = calcularZScoreSector(Number(ag.monto), bVentas);
    if (Math.abs(z) >= UMBRAL_SEÑAL) señales.add(key);
  });
  return señales;
}

// ─── Construcción de alertas de métricas ─────────────────────────────────────
// REGLA: sólo emite si ≥2 métricas son anómalas simultáneamente.

function construirAlertasMetricas(señalesMetricas, metricasRecientes, benchmarkSector, baselineNegocio, pesos, tipoNegocio) {
  const metricasAnomalas = Object.keys(señalesMetricas);
  if (metricasAnomalas.length < 2) return []; // menos de 2 señales → silencio

  return metricasAnomalas.map(metrica => {
    const { scoreHibrido } = señalesMetricas[metrica];
    const valor = metricasRecientes[metrica];
    const bSector = benchmarkSector[metrica];
    const bPropio = baselineNegocio[metrica];
    const referencia = bSector ? Number(bSector.valor_promedio) : Number(bPropio.valor);
    const desvio = referencia > 0 ? Math.round(((valor - referencia) / referencia) * 100) : 0;
    const impacto = Math.round(Math.abs(valor - referencia));
    const confianza_pct = Math.min(Math.round((Math.abs(scoreHibrido) / 4) * 100), 100);
    const nivelConfianza = confianza_pct > 80 ? 'ALTA' : confianza_pct > 50 ? 'MEDIA' : 'BAJA';
    const capaOrigen = determinarCapaOrigen(pesos);
    const tipo = scoreHibrido < 0 ? 'METRICA_BAJA' : 'METRICA_ALTA';

    const alerta = {
      tipo,
      metrica,
      valor_actual: Math.round(valor * 100) / 100,
      valor_esperado: Math.round(referencia),
      desvio_porcentaje: desvio,
      zscore: Math.round(scoreHibrido * 100) / 100,
      capa_origen: capaOrigen,
      señales_corroboradoras: metricasAnomalas.filter(m => m !== metrica),
      peso_usado: { capa1: Math.round(pesos.peso_capa1 * 100), capa2: Math.round(pesos.peso_capa2 * 100) },
      confianza: { nivel: nivelConfianza, score: confianza_pct },
      confianza_porcentaje: confianza_pct,
      impacto_pesos: impacto,
      tipo_negocio: tipoNegocio,
    };
    alerta.insight = generarInsightMetrica(alerta);
    return alerta;
  });
}

// ─── Construcción de alertas de segmento ─────────────────────────────────────
// REGLA: sólo emite si la anomalía de segmento tiene ≥1 señal de corroboración
// (sector benchmark para ese turno+día, o al menos 1 métrica global anómala).

function construirAlertasSegmento(anomalias, señalesSectorPorTurno, señalesMetricas, pesos) {
  const numSeñalesMetrica = Object.keys(señalesMetricas).length;
  const capaOrigen = determinarCapaOrigen(pesos);

  return anomalias
    .filter(a => {
      const dia = new Date(a.fecha).toISOString().split('T')[0];
      const key = `${a.turno || 'SIN_TURNO'}_${dia}`;
      const tieneSectorSignal = señalesSectorPorTurno.has(key);
      const tieneMetricaSignal = numSeñalesMetrica >= 1;
      // señal 1 = ZSCORE_SEGMENTO (el propio z-score ya pasó el umbral)
      // señal 2 = sector benchmark o métrica global
      return tieneSectorSignal || tieneMetricaSignal;
    })
    .map(a => {
      const dia = new Date(a.fecha).toISOString().split('T')[0];
      const key = `${a.turno || 'SIN_TURNO'}_${dia}`;
      const corroboradoras = [];
      if (señalesSectorPorTurno.has(key)) corroboradoras.push('SECTOR_BENCHMARK');
      if (numSeñalesMetrica >= 1) corroboradoras.push('METRICA_GLOBAL');

      return {
        ...a,
        capa_origen: capaOrigen,
        señales_corroboradoras: corroboradoras,
        peso_usado: { capa1: Math.round(pesos.peso_capa1 * 100), capa2: Math.round(pesos.peso_capa2 * 100) },
        confianza_porcentaje: a.confianza.score,
        impacto_pesos: Math.abs(Number(a.monto) - Number(a.monto_esperado)),
        insight: generarInsight(a),
      };
    });
}

// ─── Análisis principal ───────────────────────────────────────────────────────

async function analizarNegocio(usuarioId) {
  try {
    const userResult = await pool.query('SELECT negocio, tipo_negocio FROM usuarios WHERE id = $1', [usuarioId]);
    const { negocio = '', tipo_negocio } = userResult.rows[0] || {};
    // tipo_negocio (columna estructurada) tiene prioridad; fallback al campo libre negocio
    const tipoNegocio = normalizarTipoNegocio(tipo_negocio || negocio);

    const result = await pool.query(
      'SELECT * FROM transacciones WHERE usuario_id = $1 ORDER BY fecha ASC',
      [usuarioId]
    );
    const transacciones = result.rows;

    const data_quality = calcularDataQualityScore(transacciones);

    if (transacciones.length === 0) {
      return {
        alertas: [],
        mensaje: 'Sin transacciones para analizar',
        data_quality_score: data_quality
      };
    }

    const pesos = calcularPesos(transacciones.length);
    const benchmarkSector = tipoNegocio ? await getBenchmarkSector(tipoNegocio) : {};
    const baselineNegocio = await getBaselineNegocio(usuarioId);

    // Métricas recientes (últimos 7 días) vs baseline histórico
    const recientes = filtrarUltimosDias(transacciones, 7);
    const metricasRecientes = calcularMetricasNegocio(recientes.length > 0 ? recientes : transacciones);

    // Evaluar todas las señales
    const señalesMetricas = evaluarSeñalesMetricas(metricasRecientes, benchmarkSector, baselineNegocio, pesos);
    const agregados = agregarPorTurno(transacciones);
    const señalesSectorPorTurno = evaluarSeñalesSectorPorTurno(agregados, benchmarkSector);

    // Detección de segmento (Capa 2 - z-score robusto por turno+franja+quincena)
    const anomalias = detectarAnomalias(agregados);

    // Construir alertas finales con regla de ≥2 señales
    const alertasMetricas = construirAlertasMetricas(
      señalesMetricas, metricasRecientes, benchmarkSector, baselineNegocio, pesos, tipoNegocio
    );
    const alertasSegmento = construirAlertasSegmento(
      anomalias, señalesSectorPorTurno, señalesMetricas, pesos
    );

    const todasAlertas = [...alertasMetricas, ...alertasSegmento];
    const criticas = todasAlertas.filter(a => a.confianza?.nivel === 'ALTA');
    const medias   = todasAlertas.filter(a => a.confianza?.nivel === 'MEDIA');
    const bajas    = todasAlertas.filter(a => a.confianza?.nivel === 'BAJA');

    return {
      total_transacciones: transacciones.length,
      total_alertas: todasAlertas.length,
      criticas: criticas.length,
      medias: medias.length,
      bajas: bajas.length,
      data_quality_score: data_quality,
      capas: {
        tipo_negocio: tipoNegocio,
        pesos: { capa1: Math.round(pesos.peso_capa1 * 100), capa2: Math.round(pesos.peso_capa2 * 100) },
        transacciones_para_capa2_completa: 500
      },
      alertas: todasAlertas.slice(0, 20),
    };
  } catch(e) {
    console.error(e);
    return { error: e.message };
  }
}

module.exports = { analizarNegocio };
