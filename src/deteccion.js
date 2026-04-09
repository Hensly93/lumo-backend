// deteccion.js — Lumo v2.0
// Robust z-score aplicado sobre AGREGADOS de turno, no transacciones individuales.
// T3-05 resuelto: la unidad de análisis es el turno, no la transacción.

function calcularMediana(valores) {
  if (!valores || valores.length === 0) return 0;
  const sorted = [...valores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calcularMAD(valores, mediana) {
  if (!valores || valores.length === 0) return 0;
  const desviaciones = valores.map((v) => Math.abs(v - mediana));
  return calcularMediana(desviaciones);
}

function robustZScore(valor, mediana, mad) {
  if (mad === 0) return 0;
  return (0.6745 * (valor - mediana)) / (1.4826 * mad);
}

function agregarPorTurno(transacciones) {
  if (!transacciones || transacciones.length === 0) return [];

  const turnos = {};

  for (const tx of transacciones) {
    const fecha = tx.fecha_hora
      ? new Date(tx.fecha_hora).toISOString().slice(0, 10)
      : "sin_fecha";
    const turno = tx.turno || "sin_turno";
    const clave = `${fecha}_${turno}`;

    if (!turnos[clave]) {
      turnos[clave] = {
        clave,
        fecha,
        turno,
        transacciones: [],
        total_ventas: 0,
        total_efectivo: 0,
        total_digital: 0,
        cantidad: 0,
      };
    }

    const monto = parseFloat(tx.monto) || 0;
    const esEfectivo =
      tx.metodo_pago === "efectivo" || tx.metodo_pago === "cash";

    turnos[clave].transacciones.push(tx);
    turnos[clave].total_ventas += monto;
    turnos[clave].cantidad += 1;
    if (esEfectivo) {
      turnos[clave].total_efectivo += monto;
    } else {
      turnos[clave].total_digital += monto;
    }
  }

  return Object.values(turnos).map((t) => ({
    ...t,
    ticket_promedio: t.cantidad > 0 ? t.total_ventas / t.cantidad : 0,
    ratio_efectivo:
      t.total_ventas > 0 ? t.total_efectivo / t.total_ventas : 0,
    ventas_por_turno: t.total_ventas,
  }));
}

function detectarAnomalias(turnosAgregados, umbralZScore = 2.0) {
  if (!turnosAgregados || turnosAgregados.length < 2) return [];

  const metricas = ["ticket_promedio", "ratio_efectivo", "ventas_por_turno"];
  const resultados = [];

  for (const metrica of metricas) {
    const valores = turnosAgregados
      .map((t) => t[metrica])
      .filter((v) => !isNaN(v) && v !== null);

    const mediana = calcularMediana(valores);
    const mad = calcularMAD(valores, mediana);

    for (const turno of turnosAgregados) {
      const valor = turno[metrica];
      if (valor === null || isNaN(valor)) continue;

      const zscore = robustZScore(valor, mediana, mad);
      const esAnomalia = Math.abs(zscore) > umbralZScore;

      resultados.push({
        clave: turno.clave,
        fecha: turno.fecha,
        turno: turno.turno,
        metrica,
        valor,
        mediana,
        mad,
        zscore: parseFloat(zscore.toFixed(3)),
        es_anomalia: esAnomalia,
        direccion: zscore > 0 ? "alto" : "bajo",
        cantidad_transacciones: turno.cantidad,
      });
    }
  }

  return resultados;
}

function filtrarAnomalias(resultadosDeteccion) {
  return resultadosDeteccion.filter((r) => r.es_anomalia);
}

function agruparAnomaliasPorTurno(anomalias) {
  const porTurno = {};

  for (const anomalia of anomalias) {
    const { clave } = anomalia;
    if (!porTurno[clave]) {
      porTurno[clave] = {
        clave,
        fecha: anomalia.fecha,
        turno: anomalia.turno,
        metricas_anomalas: [],
      };
    }
    porTurno[clave].metricas_anomalas.push(anomalia);
  }

  // Regla inamovible: mínimo 2 señales simultáneas
  return Object.values(porTurno).filter(
    (t) => t.metricas_anomalas.length >= 2
  );
}

module.exports = {
  agregarPorTurno,
  detectarAnomalias,
  filtrarAnomalias,
  agruparAnomaliasPorTurno,
  calcularMediana,
  calcularMAD,
  robustZScore,
};
