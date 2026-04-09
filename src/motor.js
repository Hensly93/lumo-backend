// motor.js — Lumo v2.0
// Orquestador principal del sistema híbrido de 3 capas.

const { agregarPorTurno, detectarAnomalias, filtrarAnomalias, agruparAnomaliasPorTurno } = require('./deteccion');
const { generarInsight } = require('./insights');
const { getBenchmarkSector, normalizarTipoNegocio, calcularZScoreSector } = require('./benchmarks_sector');
const { calcularMetricasNegocio, getBaselineNegocio } = require('./baseline_negocio');
const { calcularPesos, calcularScoreHibrido, determinarCapaOrigen, calcularZScorePropio, priorizarAlerta, estimarImpactoPesos } = require('./benchmark_hibrido');
const pool = require('./db');

const UMBRAL_SEÑAL = 2.0;
const HORAS_GAP_MAXIMO = 8;

// ─── Data Quality Score ──────────────────────────────────────────────────────

function calcularDataQualityScore(transacciones) {
  if (!transacciones || transacciones.length === 0) return 0;

  let score = 0;

  // Volumen (40 puntos)
  if (transacciones.length >= 30) score += 40;
  else if (transacciones.length >= 15) score += 25;
  else if (transacciones.length >= 7) score += 15;
  else score += 5;

  // Completitud de campos (30 puntos)
  const conMonto = transacciones.filter(t => t.monto && !isNaN(t.monto)).length;
  const conFecha = transacciones.filter(t => t.fecha_hora).length;
  const conMetodo = transacciones.filter(t => t.metodo_pago).length;
  const completitud = (conMonto + conFecha + conMetodo) / (transacciones.length * 3);
  score += Math.round(completitud * 30);

  // Continuidad temporal (30 puntos)
  const sinGaps = !detectarGapsDatos(transacciones);
  if (sinGaps) score += 30;
  else score += 10;

  return Math.min(sc
