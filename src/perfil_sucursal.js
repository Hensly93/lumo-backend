const pool = require('./db');

const K_FACTOR = 0.5;
const H_FACTOR = 4.5;
const VENTANA_DIAS = 14;
const MARGEN_ATRIBUCION = 1.2;
const VENTANA_PARTICIPACION_DIAS = 60;

async function calcularParticipacionEsperada(negocioId) {
  const r = await pool.query(
    `SELECT sucursal_id, COUNT(*) as n_turnos
     FROM turnos_caja
     WHERE negocio_id=$1 AND estado='cerrado' AND sucursal_id IS NOT NULL
       AND hora_apertura >= NOW() - INTERVAL '${VENTANA_PARTICIPACION_DIAS} days'
     GROUP BY sucursal_id`,
    [negocioId]
  );

  const total = r.rows.reduce((a, row) => a + parseInt(row.n_turnos), 0);
  if (total === 0) return {};

  const participacion = {};
  r.rows.forEach(row => {
    participacion[row.sucursal_id] = parseInt(row.n_turnos) / total;
  });

  return participacion;
}

async function calcularContribucionSucursal(negocioId, tipoTurno, metrica = 'brecha') {
  const res = await pool.query(
    `SELECT brecha as valor, hora_apertura, sucursal_id
     FROM turnos_caja
     WHERE negocio_id=$1 AND LOWER(tipo_turno)=LOWER($2)
       AND estado='cerrado' AND brecha IS NOT NULL AND sucursal_id IS NOT NULL
       AND hora_apertura >= NOW() - INTERVAL '${VENTANA_DIAS} days'
     ORDER BY hora_apertura ASC`,
    [negocioId, tipoTurno]
  );

  if (res.rows.length < 5) {
    return { disponible: false, motivo: 'insuficientes_datos', n: res.rows.length };
  }

  const valores = res.rows.map(r => parseFloat(r.valor));
  const sucursales = res.rows.map(r => r.sucursal_id);
  const n = valores.length;

  const mitad = Math.max(Math.floor(n / 2), 3);
  const baseline = valores.slice(0, mitad);
  const mu = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const sigma = Math.sqrt(baseline.reduce((a, b) => a + Math.pow(b - mu, 2), 0) / baseline.length) || mu * 0.3;

  const k = K_FACTOR * sigma;
  const h = H_FACTOR * sigma;

  let sPos = 0, sNeg = 0;
  let inicioRunPos = 0, inicioRunNeg = 0;
  const serie = [];
  let alarmaDetectada = false;

  for (let i = 0; i < n; i++) {
    const x = valores[i];
    const incPos = (x - mu) - k;
    const incNeg = -(x - mu) - k;

    sPos = Math.max(0, sPos + incPos);
    sNeg = Math.max(0, sNeg + incNeg);

    if (sPos === 0) inicioRunPos = i + 1;
    if (sNeg === 0) inicioRunNeg = i + 1;

    serie.push({ sPos, sNeg, incPos, incNeg, sucursal_id: sucursales[i] });

    if (!alarmaDetectada && (sPos > h || sNeg > h)) {
      alarmaDetectada = true;
    }
  }

  if (!alarmaDetectada) {
    return { disponible: true, alarma: false };
  }

  const ultimoS = serie[serie.length - 1];
  const direccion = ultimoS.sPos > ultimoS.sNeg ? 'creciente' : 'decreciente';
  const inicioRun = direccion === 'creciente' ? inicioRunPos : inicioRunNeg;
  const campoIncremento = direccion === 'creciente' ? 'incPos' : 'incNeg';

  const contribucionesParciales = {};
  for (let i = inicioRun; i < n; i++) {
    const inc = serie[i][campoIncremento];
    if (inc > 0) {
      const suc = serie[i].sucursal_id;
      contribucionesParciales[suc] = (contribucionesParciales[suc] || 0) + inc;
    }
  }

  const totalPositivo = Object.values(contribucionesParciales).reduce((a, b) => a + b, 0) || 1;
  const contribucionPorSucursal = {};
  for (const [suc, val] of Object.entries(contribucionesParciales)) {
    contribucionPorSucursal[suc] = Math.round((val / totalPositivo) * 1000) / 1000;
  }

  return {
    disponible: true,
    alarma: true,
    direccion,
    contribucion_por_sucursal: contribucionPorSucursal,
  };
}

async function atribuirAnomaliaSucursal(negocioId, tipoTurno) {
  const [participacion, contribucion] = await Promise.all([
    calcularParticipacionEsperada(negocioId),
    calcularContribucionSucursal(negocioId, tipoTurno),
  ]);

  if (!contribucion.disponible || !contribucion.alarma) {
    return { disponible: contribucion.disponible, alarma: false };
  }

  const sucursalesAtribuidas = [];
  for (const [sucId, contrib] of Object.entries(contribucion.contribucion_por_sucursal)) {
    const esperado = participacion[sucId] || 0;
    if (contrib > esperado * MARGEN_ATRIBUCION) {
      sucursalesAtribuidas.push({
        sucursal_id: parseInt(sucId),
        contribucion: contrib,
        participacion_esperada: Math.round(esperado * 1000) / 1000,
      });
    }
  }

  return {
    disponible: true,
    alarma: true,
    direccion: contribucion.direccion,
    sucursales_atribuidas: sucursalesAtribuidas,
  };
}

module.exports = { calcularParticipacionEsperada, calcularContribucionSucursal, atribuirAnomaliaSucursal };
