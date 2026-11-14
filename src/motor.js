const { detectarAnomalias, agregarPorTurno } = require('./deteccion');
const { generarInsight, generarInsightMetrica } = require('./insights');
const { getBenchmarkSector, normalizarTipoNegocio, calcularZScoreSector } = require('./benchmarks_sector');
const { calcularMetricasNegocio, getBaselineNegocio } = require('./baseline_negocio');
const { calcularPesos, calcularScoreHibrido, determinarCapaOrigen, calcularZScorePropio } = require('./benchmark_hibrido');
const { getContextoTemporal, resolverCoordenadasSucursal, fetchClima, factoresAjuste } = require('./zscore_contextual');
const { calcularUmbralCelda, condicionDesdeContexto } = require('./motor_conductual');
const { orchestrate } = require('./orchestrator');
const { calcularIndiceInflacion } = require('./indice_inflacion');
const pool = require('./db');

const METRICAS = ['ticket_promedio', 'ventas_por_turno', 'ratio_efectivo'];
const UMBRAL_SEÑAL = 2.0;

// ─── Helpers ────────────────────────────────────────────────────────────────

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
    const z = calcularZScoreSector(Number(ag.ventas_por_turno), bVentas);
    if (Math.abs(z) >= UMBRAL_SEÑAL) señales.add(ag.clave);
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
    // El valor esperado sale de la misma capa que más pesa en el score (propia si ya hay datos propios)
    const usaPropio = bPropio && (!bSector || pesos.peso_capa2 >= 0.5);
    const referencia = usaPropio ? Number(bPropio.valor) : Number(bSector.valor_promedio);
    const desvio = referencia > 0 ? Math.round(((valor - referencia) / referencia) * 100) : 0;
    // Impacto en pesos: el ratio de efectivo se pasa a plata con las ventas por turno
    const impacto = metrica === 'ratio_efectivo'
      ? Math.round(Math.abs(valor - referencia) * (Number(metricasRecientes.ventas_por_turno) || 0))
      : Math.round(Math.abs(valor - referencia));
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
// Entrada: resultados de detectarAnomalias (una fila por turno+día+métrica, hora Argentina).
// Solo se miran los últimos DIAS_RECIENTES días: un desvío de hace semanas no es una alerta de hoy.
// REGLA: la anomalía necesita ≥1 señal de corroboración: otra métrica anómala en el mismo turno,
// el benchmark del sector para ese turno, o al menos 1 métrica global anómala.

const DIAS_RECIENTES = 3;
const NOMBRE_METRICA = { ventas_por_turno: 'las ventas', ticket_promedio: 'el ticket promedio', ratio_efectivo: 'la parte cobrada en efectivo' };
const NOMBRE_TURNO = { manana: 'mañana', tarde: 'tarde', noche: 'noche' };

function construirAlertasSegmento(resultados, agregados, señalesSectorPorTurno, señalesMetricas, pesos, nombresLocal = {}) {
  const numSeñalesMetrica = Object.keys(señalesMetricas).length;
  const capaOrigen = determinarCapaOrigen(pesos);
  const hoyAR = new Date(Date.now() - 3 * 3600 * 1000);
  const corte = new Date(hoyAR.getTime() - (DIAS_RECIENTES - 1) * 86400000).toISOString().slice(0, 10);
  const porClave = {};
  for (const ag of agregados) porClave[ag.clave] = ag;

  const anomalias = (resultados || []).filter(r => r.es_anomalia && r.fecha >= corte);
  const metricasPorClave = {};
  for (const a of anomalias) (metricasPorClave[a.clave] = metricasPorClave[a.clave] || new Set()).add(a.metrica);

  return anomalias
    .filter(a => metricasPorClave[a.clave].size >= 2 || señalesSectorPorTurno.has(a.clave) || numSeñalesMetrica >= 1)
    .map(a => {
      const ag = porClave[a.clave] || {};
      const corroboradoras = [];
      if (metricasPorClave[a.clave].size >= 2) corroboradoras.push('OTRA_METRICA_MISMO_TURNO');
      if (señalesSectorPorTurno.has(a.clave)) corroboradoras.push('SECTOR_BENCHMARK');
      if (numSeñalesMetrica >= 1) corroboradoras.push('METRICA_GLOBAL');

      // Plata estimada en juego, siempre en pesos
      let impacto = 0;
      if (a.metrica === 'ventas_por_turno') impacto = Math.abs(a.valor - a.mediana);
      else if (a.metrica === 'ticket_promedio') impacto = Math.abs(a.valor - a.mediana) * (ag.cantidad || 0);
      else if (a.metrica === 'ratio_efectivo') impacto = Math.abs(a.valor - a.mediana) * (ag.total_ventas || 0);
      impacto = Math.round(impacto);

      const z = Math.abs(a.zscore);
      const confianza_pct = Math.min(Math.round((z / 4) * 100), 100);
      const nivel = confianza_pct > 80 ? 'ALTA' : confianza_pct > 50 ? 'MEDIA' : 'BAJA';
      const subeVenta = a.metrica === 'ventas_por_turno' && a.direccion === 'alto';
      const desvio = a.mediana ? Math.round(((a.valor - a.mediana) / a.mediana) * 100) : 0;
      const turnoTxt = (NOMBRE_TURNO[a.turno] || a.turno) + (a.sucursal_id != null && nombresLocal[a.sucursal_id] ? ` (${nombresLocal[a.sucursal_id]})` : '');
      const insight = subeVenta
        ? `Turno ${turnoTxt} del ${a.fecha}: las ventas estuvieron ${Math.abs(desvio)}% por encima de lo normal para ese turno (unos $${impacto.toLocaleString('es-AR')} más).`
        : `Posible inconsistencia operativa en el turno ${turnoTxt} del ${a.fecha}: ${NOMBRE_METRICA[a.metrica]} ${a.direccion === 'bajo' ? (a.metrica === 'ventas_por_turno' ? 'bajaron' : 'bajó') : (a.metrica === 'ventas_por_turno' ? 'subieron' : 'subió')} ${Math.abs(desvio)}% contra lo normal de ese turno. Impacto estimado: $${impacto.toLocaleString('es-AR')}.`;

      return {
        tipo: subeVenta ? 'TURNO_VENTAS_ALTAS' : 'ANOMALIA_TURNO',
        metrica: a.metrica,
        turno: a.turno,
        sucursal_id: a.sucursal_id ?? null,
        fecha: a.fecha,
        contexto: `${a.clave}_${a.metrica}`,
        valor_actual: Math.round(a.valor * 100) / 100,
        valor_esperado: Math.round(a.mediana * 100) / 100,
        desvio_porcentaje: desvio,
        zscore: a.zscore,
        capa_origen: capaOrigen,
        señales_corroboradoras: corroboradoras,
        peso_usado: { capa1: Math.round(pesos.peso_capa1 * 100), capa2: Math.round(pesos.peso_capa2 * 100) },
        confianza: { nivel, score: confianza_pct },
        confianza_porcentaje: confianza_pct,
        impacto_pesos: impacto,
        cantidad_transacciones: a.cantidad_transacciones,
        es_positiva: subeVenta,
        insight,
        accion: subeVenta ? '' : `Revisá el cierre y los tickets del turno ${turnoTxt} del ${a.fecha}.`,
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

    if (!negocioId) return { alertas: [], señales: [], error: 'negocio_no_encontrado', data_quality_score: calcularDataQualityScore([]) };
    // Últimos 120 días: alcanza para baseline y detección sin cargar años de ventas en cada pantalla
    const result = await pool.query(
      `SELECT * FROM transacciones WHERE negocio_id = $1
       AND ($2::integer IS NULL OR sucursal_id = $2)
       AND fecha >= NOW() - INTERVAL '120 days'
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
    const contexto = await orchestrate({ negocio_id: negocioId, uid: null, turno_actual: null, sucursal_id: sucursalId });

    const debe_emitir          = contexto?.debe_emitir          ?? true;
    const confirmacion_cruzada = contexto?.confirmacion_cruzada ?? false;
    const risk_score_final     = contexto?.risk_score_final     ?? 0;
    const orchQuality          = contexto?.data_quality         ?? { modulos_ok: 0, modulos_fallidos: 0, tasa_disponibilidad: 100 };

    if (!debe_emitir) {
      return {
        alertas:            [],
        señales:            [],
        mensaje:            'Orquestador: score insuficiente para emitir señales',
        total_transacciones: transacciones.length,
        risk_score_final,
        data_quality_score: { ...data_quality, ...orchQuality },
      };
    }

    // Outputs del orquestador — ya procesados, no se re-ejecutan los módulos
    const cusumResult    = contexto?.señales_individuales?.cusum    ?? { alertas_cusum: [], turnos: [] };
    const patronesSemana = contexto?.señales_individuales?.patron_semanal ?? [];
    const cruceCatalogo  = contexto?.señales_individuales?.cruce_catalogo ?? { disponible: false };
    const sucursalesAtribuidas = contexto?.señales_individuales?.sucursales_atribuidas ?? {};

    const pesos = calcularPesos(transacciones.length);
    const benchmarkSector = tipoNegocio ? await getBenchmarkSector(tipoNegocio) : {};
    const diaSemana = new Date(Date.now() - 3 * 3600 * 1000).getUTCDay(); // 0=domingo, 6=sábado (hora Argentina)
    const baselineNegocio = await getBaselineNegocio(negocioId, sucursalId, diaSemana);

    // Contexto temporal actual + clima
    const ctx = getContextoTemporal(new Date());
    const coords = await resolverCoordenadasSucursal(negocioId, sucursalId);
    const clima = await fetchClima(ctx.fecha_str, coords?.lat, coords?.lon, coords?.sucursal_id);

    // Índice de inflación (sistema híbrido 2 capas)
    const inflacionResult = await calcularIndiceInflacion(negocioId, tipoNegocio).catch(() => ({ disponible: false }));
    const indiceInflacion = inflacionResult.disponible ? inflacionResult.indice_mensual : null;

    const { factor: factorContexto, componentes: componentesContexto } = factoresAjuste(ctx, clima, indiceInflacion);

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
    const agregados = agregarPorTurno(transacciones); // deteccion.js: por turno y día en hora Argentina, con métricas
    const señalesSectorPorTurno = evaluarSeñalesSectorPorTurno(agregados, benchmarkSector);

    // P6: umbral dinámico para la celda del contexto actual
    const turnoActual = ctx.turno; // en minúsculas, como se guarda en turnos_caja
    const umbralDinamico = await calcularUmbralCelda(
      negocioId, turnoActual, ctx.dia_semana, condicionDesdeContexto(ctx)
    ).catch(() => UMBRAL_SEÑAL);

    // Detección de segmento (Capa 2 - z-score robusto de cada turno contra su propio historial)
    const anomalias = detectarAnomalias(agregados, umbralDinamico);

    const nombresLocal = {};
    try {
      const rl = await pool.query('SELECT id, nombre FROM mis_sucursales WHERE negocio_id=$1', [negocioId]);
      for (const r of rl.rows) nombresLocal[r.id] = r.nombre;
    } catch (e) { /* sin nombres de local */ }

    // CUSUM, patrones y catálogo ya vienen del orquestador — no se re-ejecutan aquí
    const [alertasMetricas, alertasSegmento] = await Promise.all([
      Promise.resolve(construirAlertasMetricas(
        señalesMetricas, metricasRecientes, benchmarkSector, baselineNegocio, pesos, tipoNegocio, confirmacion_cruzada
      )),
      Promise.resolve(construirAlertasSegmento(
        anomalias, agregados, señalesSectorPorTurno, señalesMetricas, pesos, nombresLocal
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
      prioridad: a.es_positiva ? 'positivo'
                 : a.confianza?.nivel === 'ALTA' ? 'critico'
                 : a.confianza?.nivel === 'MEDIA' ? 'atencion'
                 : 'info',
      mensaje: a.insight || '',
      accion:  a.accion  || '',
      contexto: a.contexto || a.turno || a.metrica || '',
    }));
    // Señales del catálogo
    const señalesCatalogo = [];
    if (cruceCatalogo.señal) señalesCatalogo.push(cruceCatalogo.señal);

    // Cruce de variables del último turno cerrado (fórmula de caja): solo con ≥2 señales simultáneas
    const señalesCruce = [];
    const cruce = contexto?.outputs?.cruce;
    if (cruce && !cruce.error && cruce.num_señales >= 2 && cruce.grado_final !== 'ok') {
      const f = cruce.formula || {};
      const turnoTxt = { manana: 'mañana', tarde: 'tarde', noche: 'noche' }[cruce.tipo_turno] || cruce.tipo_turno;
      señalesCruce.push({
        tipo: 'CRUCE_CAJA_TURNO',
        prioridad: cruce.grado_final === 'critico' ? 'critico' : 'atencion',
        contexto: `turno_${cruce.turno_id}`,
        mensaje: `Turno ${turnoTxt} de ${cruce.empleado}: la caja cerró con una diferencia de $${Math.round(Math.abs(f.brecha || 0)).toLocaleString('es-AR')} (${(f.brecha || 0) > 0 ? 'falta' : 'sobra'} efectivo) y hay ${cruce.num_señales} señales a la vez: ${cruce.señales.map(x => x.descripcion).join('; ')}.`,
        accion: 'Revisá el conteo de cierre de ese turno junto con los egresos cargados.',
        impacto_pesos: Math.round(Math.abs(f.brecha || 0)),
        datos: { turno_id: cruce.turno_id, formula: f, señales: cruce.señales },
      });
    }

    const señales = [
      ...señalesMotor,
      ...señalesCruce,
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
      sucursales_atribuidas: sucursalesAtribuidas, // atribución de anomalías por sucursal
    };
  } catch(e) {
    console.error(e);
    return { error: e.message };
  }
}

module.exports = { analizarNegocio };
