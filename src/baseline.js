const { getSegmento } = require('./segmentacion');

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
    const valores = grupos[clave];
    const n = valores.length;
    const media = valores.reduce((a,b) => a+b, 0) / n;
    const varianza = valores.reduce((a,b) => a + Math.pow(b-media,2), 0) / n;
    const std = Math.sqrt(varianza);
    baseline[clave] = { media, std, n, valores };
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