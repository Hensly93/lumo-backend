const { getSegmento } = require('./segmentacion');

function calcularMediana(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calcularIQR(sorted) {
  const mid = Math.floor(sorted.length / 2);
  const q1 = calcularMediana(sorted.slice(0, mid));
  const q3 = calcularMediana(sorted.slice(Math.ceil(sorted.length / 2)));
  return q3 - q1;
}

function construirBaseline(transacciones) {
  const grupos = {};
  transacciones.forEach(t => {
    const seg = getSegmento(t.fecha);
    const clave = `${seg.franja}_${seg.tipoDia}_${seg.quincena}`;
    if (!grupos[clave]) grupos[clave] = [];
    grupos[clave].push(Number(t.monto));
  });

  const baseline = {};
  Object.keys(grupos).forEach(clave => {
    const sorted = [...grupos[clave]].sort((a, b) => a - b);
    const n = sorted.length;
    const mediana = calcularMediana(sorted);
    const iqr = calcularIQR(sorted);
    baseline[clave] = { mediana, iqr, n };
  });

  return baseline;
}

function getConfianzaTemporal(diasDeHistorial) {
  if (diasDeHistorial < 8) return { nivel: 'BAJA', score: 0.3, label: 'datos insuficientes' };
  if (diasDeHistorial < 15) return { nivel: 'MEDIA', score: 0.6, label: `${diasDeHistorial} dias de datos` };
  if (diasDeHistorial < 30) return { nivel: 'MEDIA_ALTA', score: 0.8, label: `${diasDeHistorial} dias de datos` };
  return { nivel: 'ALTA', score: 0.95, label: '+30 dias de datos consistentes' };
}

module.exports = { construirBaseline, getConfianzaTemporal };