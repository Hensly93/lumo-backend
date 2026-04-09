// benchmarks_sector.js — Lumo v2.0
// Capa 1: benchmarks reales del sector (Maxirest/CAME abril 2026)
// Incluye ajuste automático por inflación mensual estimada

const INFLACION_MENSUAL_ESTIMADA = 0.04; // 4% mensual — actualizar cada mes

const BENCHMARKS_SECTOR = {
  kiosko: {
    ticket_promedio: { min: 2500, max: 8000 },
    ratio_efectivo: { min: 0.75, max: 0.95 },
    ventas_por_turno: { min: 15000, max: 80000 },
  },
  almacen: {
    ticket_promedio: { min: 3000, max: 10000 },
    ratio_efectivo: { min: 0.70, max: 0.90 },
    ventas_por_turno: { min: 20000, max: 100000 },
  },
  cafeteria: {
    ticket_promedio: { min: 20000, max: 45000 },
    ratio_efectivo: { min: 0.35, max: 0.55 },
    ventas_por_turno: { min: 80000, max: 400000 },
  },
  bar: {
    ticket_promedio: { min: 20000, max: 45000 },
    ratio_efectivo: { min: 0.35, max: 0.55 },
    ventas_por_turno: { min: 80000, max: 400000 },
  },
  restaurante: {
    ticket_promedio: { min: 35000, max: 70000 },
    ratio_efectivo: { min: 0.30, max: 0.50 },
    ventas_por_turno: { min: 150000, max: 800000 },
  },
  parrilla: {
    ticket_promedio: { min: 50000, max: 100000 },
    ratio_efectivo: { min: 0.35, max: 0.55 },
    ventas_por_turno: { min: 200000, max: 1000000 },
  },
  panaderia: {
    ticket_promedio: { min: 3000, max: 12000 },
    ratio_efectivo: { min: 0.68, max: 0.88 },
    ventas_por_turno: { min: 30000, max: 150000 },
  },
  farmacia: {
    ticket_promedio: { min: 8000, max: 30000 },
    ratio_efectivo: { min: 0.25, max: 0.45 },
    ventas_por_turno: { min: 50000, max: 300000 },
  },
  retail: {
    ticket_promedio: { min: 15000, max: 60000 },
    ratio_efectivo: { min: 0.20, max: 0.40 },
    ventas_por_turno: { min: 40000, max: 250000 },
  },
};

const ALIASES = {
  "kiosco": "kiosko",
  "kiosks": "kiosko",
  "cafe": "cafeteria",
  "café": "cafeteria",
  "cafè": "cafeteria",
  "resto": "restaurante",
  "restaurant": "restaurante",
  "panadería": "panaderia",
  "farmacía": "farmacia",
};

function normalizarTipoNegocio(tipo) {
  if (!tipo) return null;
  const lower = tipo.toLowerCase().trim();
  return ALIASES[lower] || (BENCHMARKS_SECTOR[lower] ? lower : null);
}

function ajustarPorInflacion(benchmark, mesesDesdeBase = 0) {
  if (mesesDesdeBase === 0) return benchmark;
  const factor = Math.pow(1 + INFLACION_MENSUAL_ESTIMADA, mesesDesdeBase);
  return {
    ticket_promedio: {
      min: Math.round(benchmark.ticket_promedio.min * factor),
      max: Math.round(benchmark.ticket_promedio.max * factor),
    },
    ratio_efectivo: { ...benchmark.ratio_efectivo },
    ventas_por_turno: {
      min: Math.round(benchmark.ventas_por_turno.min * factor),
      max: Math.round(benchmark.ventas_por_turno.max * factor),
    },
  };
}

function mesesDesdeAbril2026() {
  const base = new Date(2026, 3, 1);
  const ahora = new Date();
  return (
    (ahora.getFullYear() - base.getFullYear()) * 12 +
    (ahora.getMonth() - base.getMonth())
  );
}

function getBenchmarkSector(tipoNegocio) {
  const tipo = normalizarTipoNegocio(tipoNegocio);
  if (!tipo) return null;
  const base = BENCHMARKS_SECTOR[tipo];
  const meses = mesesDesdeAbril2026();
  return ajustarPorInflacion(base, meses);
}

function calcularZScoreSector(valor, tipoNegocio, metrica) {
  const benchmark = getBenchmarkSector(tipoNegocio);
  if (!benchmark || !benchmark[metrica]) return null;
  const { min, max } = benchmark[metrica];
  const media = (min + max) / 2;
  const desvio = (max - min) / 4;
  if (desvio === 0) return 0;
  return (valor - media) / desvio;
}

function estaEnRangoSector(valor, tipoNegocio, metrica) {
  const benchmark = getBenchmarkSector(tipoNeg
