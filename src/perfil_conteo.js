const pool = require('./db');
const { calcularMediana, calcularMAD, robustZScore } = require('./deteccion');

const MIN_TURNOS_COMPARACION = 5;

function redondear(n, dec = 0) {
  return Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec);
}

function grado(zscore) {
  const z = Math.abs(zscore);
  if (z >= 4.0) return 'critico';
  if (z >= 2.5) return 'inconsistencia';
  if (z >= 1.5) return 'atencion';
  return 'normal';
}

async function calcularTramosDeUnTurno(turnoId) {
  const conteosRes = await pool.query(
    `SELECT tipo, monto_declarado, hora FROM conteos_caja 
     WHERE turno_id=$1 AND (tipo IN ('apertura','cierre') OR (tipo='aleatorio' AND numero_conteo=1))`,
    [turnoId]
  );
  const c = {};
  conteosRes.rows.forEach(r => { c[r.tipo] = { monto: parseFloat(r.monto_declarado), hora: r.hora }; });
  if (!c.apertura || !c.cierre || !c.aleatorio) return null;
  const egresosRes = await pool.query(
    `SELECT monto, hora FROM egresos_caja WHERE turno_id=$1`,
    [turnoId]
  );
  const egresos = egresosRes.rows.map(r => ({ monto: parseFloat(r.monto), hora: new Date(r.hora) }));
  const horaAleatorio = new Date(c.aleatorio.hora);
  const egresosTramo1 = egresos.filter(e => e.hora <= horaAleatorio).reduce((s, e) => s + e.monto, 0);
  const egresosTramo2 = egresos.filter(e => e.hora > horaAleatorio).reduce((s, e) => s + e.monto, 0);
  const tramo1Neto = (c.aleatorio.monto - c.apertura.monto) - egresosTramo1;
  const tramo2Neto = (c.cierre.monto - c.aleatorio.monto) - egresosTramo2;
  return { tramo1Neto, tramo2Neto };
}

async function analizarTramosTurno(turnoId) {
  const tRes = await pool.query('SELECT * FROM turnos_caja WHERE id=$1', [turnoId]);
  if (tRes.rows.length === 0) return { error: 'Turno no encontrado' };
  const t = tRes.rows[0];
  if (t.estado !== 'cerrado') return { error: 'El turno aún no está cerrado' };
  const propio = await calcularTramosDeUnTurno(turnoId);
  if (!propio) {
    return {
      turno_id: turnoId, empleado: t.nombre_empleado, tipo_turno: t.tipo_turno,
      disponible: false, motivo: 'sin_conteo_aleatorio',
    };
  }
  const diaSemana = new Date(t.hora_apertura).getDay();
  const candidatosRes = await pool.query(
    `SELECT id, hora_apertura FROM turnos_caja 
     WHERE negocio_id=$1 AND nombre_empleado=$2 AND tipo_turno=$3 
       AND estado='cerrado' AND id != $4 
     ORDER BY hora_apertura DESC LIMIT 60`,
    [t.negocio_id, t.nombre_empleado, t.tipo_turno, turnoId]
  );
  const historicos = [];
  for (const row of candidatosRes.rows) {
    const tramos = await calcularTramosDeUnTurno(row.id);
    if (tramos) {
      historicos.push({ ...tramos, dia_semana: new Date(row.hora_apertura).getDay() });
    }
  }
  const conDia = historicos.filter(h => h.dia_semana === diaSemana);
  let usados, segmentoUsado;
  if (conDia.length >= MIN_TURNOS_COMPARACION) {
    usados = conDia; segmentoUsado = 'empleado_turno_dia';
  } else if (historicos.length >= MIN_TURNOS_COMPARACION) {
    usados = historicos; segmentoUsado = 'empleado_turno';
  } else {
    return {
      turno_id: turnoId, empleado: t.nombre_empleado, tipo_turno: t.tipo_turno,
      disponible: false, motivo: 'datos_insuficientes',
      n_turnos_comparacion: historicos.length,
    };
  }
  function evaluarTramo(valorActual, historicosTramo) {
    const mediana = calcularMediana(historicosTramo);
    const mad = calcularMAD(historicosTramo, mediana);
    if (mad === 0) return { neto: redondear(valorActual), zscore: 0, grado: 'normal', mediana_historica: redondear(mediana) };
    const zscore = redondear(robustZScore(valorActual, mediana, mad), 2);
    return { neto: redondear(valorActual), zscore, grado: grado(zscore), mediana_historica: redondear(mediana) };
  }
  const tramo1 = evaluarTramo(propio.tramo1Neto, usados.map(h => h.tramo1Neto));
  const tramo2 = evaluarTramo(propio.tramo2Neto, usados.map(h => h.tramo2Neto));
  const señales = [];
  if (Math.abs(tramo1.zscore) >= 2.0) {
    señales.push({
      tipo: 'TRAMO1_ANOMALO',
      descripcion: `Movimiento de caja entre apertura y conteo medio fuera de lo habitual (${tramo1.zscore} desvíos)`,
      valor: tramo1.zscore, peso: tramo1.grado,
    });
  }
  if (Math.abs(tramo2.zscore) >= 2.0) {
    señales.push({
      tipo: 'TRAMO2_ANOMALO',
      descripcion: `Movimiento de caja entre conteo medio y cierre fuera de lo habitual (${tramo2.zscore} desvíos)`,
      valor: tramo2.zscore, peso: tramo2.grado,
    });
  }
  return {
    turno_id: turnoId, empleado: t.nombre_empleado, tipo_turno: t.tipo_turno,
    disponible: true, segmento_usado: segmentoUsado, n_turnos_comparacion: usados.length,
    tramo1, tramo2, señales,
  };
}

module.exports = { analizarTramosTurno };
