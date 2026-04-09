// benchmark_hibrido.js — Lumo v2.0
// Capa 3: transición automática entre benchmark sector y baseline propio.
// T5-02 resuelto: una sola implementación de z-score propio.
// T5-06 resuelto: un solo sistema de priorización de alertas.

function calcularPesos(totalTx = 0) {
  const pesoPropio = Math.min(totalTx / 500, 1.0);
  const pesoSector = 1 - pesoPropio;
  return {
    pesoSector: parseFloat(pesoSector.toFixed(3)),
    pesoPropio: parseFloat(pesoPropio.toFixed(3)),
  };
}

function determinarCapaOrigen(pesos) {
  if (pesos.pesoSector >= 0.8) return "sector";
  if (pesos.pesoPropio >= 0.8) return "propio";
  return "hibrido";
}

function calcularZScorePropio(valor, historico = []) {
  if (!historico || historico.length < 3) return 0;

  const sorted = [...historico].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const mediana =
    sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;

  const desviaciones = historico.map((v) => Math.abs(v - mediana));
  const sortedDev = [...desviaciones].sort((a, b) => a - b);
  const midDev = Math.floor(sortedDev.length / 2);
  const mad =
    sortedDev.length % 2 !== 0
      ? sortedDev[midDev]
      : (sortedDev[midDev - 1] + sortedDev[midDev]) / 2;

  if (mad === 0) return 0;
  return parseFloat(((0.6745 * (valor - mediana)) / (1.4826 * mad)).toFixed(3));
}

function calcularScoreHibrido(zScoreSector, zScorePropio, pesos) {
  const zSector = zScoreSector || 0;
  const zPropio = zScorePropio || 0;
  const score = zSector * pesos.pesoSector + zPropio * pesos.pesoPropio;
  return parseFloat(score.toFixed(3));
}

function priorizarAlerta(alerta) {
  const score = Math.abs(alerta.score || 0);
  const señales = alerta.metricas_anomalas?.length || 0;
  const impacto = alerta.impacto_pesos || 0;

  if (score >= 3.0 && señales >= 3) return "critica";
  if (score >= 3.5) return "critica";
  if (impacto >= 50000 && score >= 2.5) return "critica";
  if (score >= 2.0 && señales >= 2) return "atencion";
  if (score >= 2.5) return "atencion";
  return "info";
}

function estimarImpactoPesos(ventasTurno, zScore) {
  if (!ventasTurno || ventasTurno <= 0) {
    return { impacto_estimado_pesos: 0, es_estimado: true };
  }
  const proporcion = Math.min(Math.abs(zScore) * 0.05, 0.30);
  const impacto =
