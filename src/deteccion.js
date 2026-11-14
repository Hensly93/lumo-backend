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

function robustZScore(valor, mediana, mad, escalaAlternativa = 0) {
  if (mad === 0) {
    // MAD = 0 pasa cuando más de la mitad de los turnos tienen el mismo valor (ej. 100% efectivo).
    // Antes daba z = 0 y ningún desvío se detectaba; ahora se usa una escala alternativa.
    if (!escalaAlternativa) return 0;
    return (valor - mediana) / escalaAlternativa;
  }
  return (0.6745 * (valor - mediana)) / (1.4826 * mad);
}

// Escala de respaldo cuando MAD = 0: desvío absoluto medio, con un piso del 5% de la mediana
// (o 0.05 para proporciones) para que una variación mínima no grite.
function escalaRespaldo(valores, mediana, esProporcion) {
  const n = valores.length || 1;
  const meanAD = valores.reduce((a, v) => a + Math.abs(v - mediana), 0) / n;
  const piso = esProporcion ? 0.05 : Math.abs(mediana) * 0.05;
  return Math.max(1.2533 * meanAD, piso) || 0;
}

function agregarPorTurno(transacciones) {
  if (!transacciones || transacciones.length === 0) return [];

  const turnos = {};

  for (const tx of transacciones) {
    // La tabla transacciones guarda el instante en la columna "fecha" (UTC); se pasa al día argentino (UTC-3).
    const instante = new Date(tx.fecha_hora || tx.fecha);
    const fecha = isNaN(instante.getTime())
      ? "sin_fecha"
      : new Date(instante.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const turno = tx.turno || "sin_turno";
    // Cada local se compara contra sí mismo: el turno tarde de Castelar no es el turno tarde del Centro
    const sucursal = tx.sucursal_id ?? null;
    const clave = sucursal == null ? `${fecha}_${turno}` : `${fecha}_${turno}_s${sucursal}`;

    if (!turnos[clave]) {
      turnos[clave] = {
        clave,
        fecha,
        turno,
        sucursal_id: sucursal,
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

  // Cada turno (mañana, tarde, noche) se compara contra SU propio historial, no contra los otros turnos.
  // Si un turno tiene menos de MIN_TURNOS_BASE registros no se lo juzga: sin historial no hay "anormal".
  const MIN_TURNOS_BASE = 5;
  const porNombreTurno = {};
  const grupo = (t) => `${t.turno || "sin_turno"}|${t.sucursal_id ?? ""}`;
  const hoyAR = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  for (const t of turnosAgregados) {
    const k = grupo(t);
    (porNombreTurno[k] = porNombreTurno[k] || []).push(t);
  }

  for (const metrica of metricas) {
    const base = {};
    for (const k of Object.keys(porNombreTurno)) {
      const valores = porNombreTurno[k]
        .filter((t) => !(metrica === "ventas_por_turno" && t.fecha === hoyAR))
        .map((t) => t[metrica])
        .filter((v) => v !== null && v !== undefined && !isNaN(v));
      if (valores.length < MIN_TURNOS_BASE) continue;
      const med = calcularMediana(valores);
      base[k] = { mediana: med, mad: calcularMAD(valores, med), respaldo: escalaRespaldo(valores, med, metrica === 'ratio_efectivo') };
    }

    for (const turno of turnosAgregados) {
      const b = base[grupo(turno)];
      if (!b) continue;
      const valor = turno[metrica];
      if (valor === null || valor === undefined || isNaN(valor)) continue;

      const mediana = b.mediana;
      const mad = b.mad;
      // Las ventas del turno de HOY están incompletas (el turno puede seguir abierto): no se juzgan como "bajas"
      if (metrica === "ventas_por_turno" && turno.fecha === hoyAR) continue;
      // Hoy, con pocas ventas, el ticket y el % de efectivo todavía no dicen nada
      if (turno.fecha === hoyAR && (turno.cantidad || 0) < 10) continue;
      const zscore = robustZScore(valor, mediana, mad, b.respaldo);
      const esAnomalia = Math.abs(zscore) > umbralZScore;

      resultados.push({
        clave: turno.clave,
        fecha: turno.fecha,
        turno: turno.turno,
        sucursal_id: turno.sucursal_id ?? null,
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
