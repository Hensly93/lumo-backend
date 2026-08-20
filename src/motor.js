const { detectarAnomalias } = require('./deteccion');
const { generarInsight, generarInsightMetrica } = require('./insights');
const { getBenchmarkSector, normalizarTipoNegocio, calcularZScoreSector } = require('./benchmarks_sector');
const { calcularMetricasNegocio, getBaselineNegocio } = require('./baseline_negocio');
const { calcularPesos, calcularScoreHibrido, determinarCapaOrigen, calcularZScorePropio } = require('./benchmark_hibrido');
const { getContextoTemporal, resolverCoordenadasSucursal, fetchClima, factoresAjuste } = require('./zscore_contextual');
const { calcularUmbralCelda, condicionDesdeContexto } = require('./motor_conductual');
const { orchestrate } = require('./orchestrator');
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

function construirAlertasMetricas(señalesMetricas, metricasRecientes, benchmarkSector, baselineNegocio, pesos, tipoNegocio, saltarGate = false) {
  const metricasAnomalas = Object.keys(señalesMetricas);
  if (!saltarGate && metricasAnomalas.length < 2) return []; // menos de 2 señales → silencio

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

async function analizarNegocio(usuarioId, sucursalId = null) {
  try {
    // Obtener negocio_id y tipo_negocio desde tabla negocios
    const negocioResult = await pool.query(
      `SELECT id, tipo_negocio FROM negocios WHERE id = $1 LIMIT 1`,
      [usuarioId]
    );
    const { id: negocioId, tipo_negocio } = negocioResult.rows[0] || {};
    const tipoNegocio = normalizarTipoNegocio(tipo_negocio);

    const result = await pool.query(
      `SELECT * FROM transacciones WHERE negocio_id = $1
       AND ($2::integer IS NULL OR sucursal_id = $2)
       ORDER BY fecha ASC`,
      [negocioId, sucursalId]
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

    // Llamar a orchestrator para obtener contexto
    const contexto = await orchestrate({ negocio_id: usuarioId, uid: null, turno_actual: null });

    const debe_emitir          = contexto?.debe_emitir          ?? true;
    const confirmacion_cruzada = contexto?.confirmacion_cruzada ?? false;
    const risk_score_final     = contexto?.risk_score_final     ?? 0;
    const orchQuality          = contexto?.data_quality         ?? { modulos_ok: 0, modulos_fallidos: 0, tasa_disponibilidad: 100 };

    if (!debe_emitir) {
      return {
        alertas:            [],
        señales:            [],
        mensaje:            'Orquestador: score insuficiente para emitir señales',
        risk_score_final,
        data_quality_score: { ...data_quality, ...orchQuality },
      };
    }

    // Outputs del orquestador — ya procesados, no se re-ejecutan los módulos
    const cusumResult    = contexto?.señales_individuales?.cusum    ?? { alertas_cusum: [], turnos: [] };
    const patronesSemana = contexto?.señales_individuales?.patron_semanal ?? [];
    const cruceCatalogo  = contexto?.señales_individuales?.cruce_catalogo ?? { disponible: false };

    const pesos = calcularPesos(transacciones.length);
    const benchmarkSector = tipoNegocio ? await getBenchmarkSector(tipoNegocio) : {};
    const diaSemana = new Date().getDay(); // 0=domingo, 6=sábado
    const baselineNegocio = await getBaselineNegocio(negocioId, sucursalId, diaSemana);

    // Contexto temporal actual + clima
    const ctx = getContextoTemporal(new Date());
    const coords = await resolverCoordenadasSucursal(negocioId, sucursalId);
    const clima = await fetchClima(ctx.fecha_str, coords?.lat, coords?.lon, coords?.sucursal_id);
    const { factor: factorContexto, componentes: componentesContexto } = factoresAjuste(ctx, clima);

    // Métricas recientes (últimos 7 días) vs baseline histórico
    // El baseline se ajusta por el factor de contexto antes de calcular z-score
    const recientes = filtrarUltimosDias(transacciones, 7);
    const metricasRecientes = calcularMetricasNegocio(recientes.length > 0 ? recientes : transacciones);

    // Ajustar baseline de ventas_por_turno por contexto
    const baselineAjustado = { ...baselineNegocio };
    if (baselineAjustado.ventas_por_turno && factorContexto !== 1.0) {
      baselineAjustado.ventas_por_turno = {
        ...baselineAjustado.ventas_por_turno,
        valor: parseFloat(baselineAjustado.ventas_por_turno.valor) * factorContexto,
      };
    }

    // Evaluar todas las señales (con baseline ajustado por contexto)
    const señalesMetricas = evaluarSeñalesMetricas(metricasRecientes, benchmarkSector, baselineAjustado, pesos);
    const agregados = agregarPorTurno(transacciones);
    const señalesSectorPorTurno = evaluarSeñalesSectorPorTurno(agregados, benchmarkSector);

    // P6: umbral dinámico para la celda del contexto actual
    const turnoActual = ctx.hora < 14 ? 'MANANA' : ctx.hora < 20 ? 'TARDE' : 'NOCHE';
    const umbralDinamico = await calcularUmbralCelda(
      negocioId, turnoActual, ctx.diaSemana, condicionDesdeContexto({ ...ctx, clima })
    ).catch(() => UMBRAL_SEÑAL);

    // Detección de segmento (Capa 2 - z-score robusto por turno+franja+quincena)
    const anomalias = detectarAnomalias(agregados, umbralDinamico);

    // CUSUM, patrones y catálogo ya vienen del orquestador — no se re-ejecutan aquí
    const [alertasMetricas, alertasSegmento] = await Promise.all([
      Promise.resolve(construirAlertasMetricas(
        señalesMetricas, metricasRecientes, benchmarkSector, baselineNegocio, pesos, tipoNegocio, confirmacion_cruzada
      )),
      Promise.resolve(construirAlertasSegmento(
        anomalias, señalesSectorPorTurno, señalesMetricas, pesos
      )),
    ]);

    const todasAlertas = [...alertasMetricas, ...alertasSegmento];
    const criticas = todasAlertas.filter(a => a.confianza?.nivel === 'ALTA');
    const medias   = todasAlertas.filter(a => a.confianza?.nivel === 'MEDIA');
    const bajas    = todasAlertas.filter(a => a.confianza?.nivel === 'BAJA');

    // señales: motor + CUSUM, formateadas para gestionarAlertas
    // Las alertas del motor necesitan prioridad/mensaje normalizados
    const señalesMotor = todasAlertas.map(a => ({
      ...a,
      prioridad: a.confianza?.nivel === 'ALTA' ? 'critico'
                 : a.confianza?.nivel === 'MEDIA' ? 'atencion'
                 : 'info',
      mensaje: a.insight || '',
      accion:  a.accion  || '',
      contexto: a.turno || a.metrica || '',
    }));
    // Señales del catálogo
    const señalesCatalogo = [];
    if (cruceCatalogo.señal) señalesCatalogo.push(cruceCatalogo.señal);

    const señales = [
      ...señalesMotor,
      ...(cusumResult.alertas_cusum || []),
      ...(patronesSemana || []),
      ...señalesCatalogo,
    ];

    return {
      total_transacciones: transacciones.length,
      total_alertas: todasAlertas.length,
      criticas: criticas.length,
      medias: medias.length,
      bajas: bajas.length,
      risk_score_final,
      confirmacion_cruzada,
      data_quality_score: { ...data_quality, ...orchQuality },
      contexto_temporal: {
        ...ctx,
        clima,
        factor_ajuste: factorContexto,
        componentes_ajuste: componentesContexto,
        nota: componentesContexto.length > 0
          ? `Baseline ajustado por: ${componentesContexto.map(c => c.causa).join(', ')}`
          : 'Sin ajustes por contexto',
        umbral_dinamico: umbralDinamico,
        turno_detectado: turnoActual,
      },
      capas: {
        tipo_negocio: tipoNegocio,
        pesos: { capa1: Math.round(pesos.peso_capa1 * 100), capa2: Math.round(pesos.peso_capa2 * 100) },
        transacciones_para_capa2_completa: 500
      },
      alertas:          todasAlertas.slice(0, 20), // backward compat — análisis raw
      señales,                                    // para gestionarAlertas en /alertas
      cusum:            cusumResult.turnos,        // estado CUSUM por turno
      patrones_semana:  patronesSemana,            // patrones estructurales detectados
    };
  } catch(e) {
    console.error(e);
    return { error: e.message };
  }
}

module.exports = { analizarNegocio };
