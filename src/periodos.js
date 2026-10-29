// periodos.js — LumoBi · Períodos y comparativas (29/10/2026)
//
// GET /api/periodos?periodo=hoy|semana|mes|anio&sucursal_id=
//
// · Comparaciones JUSTAS: el período en curso se compara contra el mismo tramo
//   (ej. mes: del 1 al 29 hasta esta hora vs del 1 al 29 del mes pasado hasta la misma hora).
//     hoy    → vs el mismo día de la semana pasada, hasta la misma hora; y vs hace 52 semanas
//     semana → lunes→ahora vs la semana pasada (mismo tramo); y vs hace 52 semanas
//     mes    → 1→ahora vs el mes pasado (mismo tramo); y vs el mismo mes del año pasado
//     anio   → 1/1→ahora vs el mismo tramo del año pasado
//   (52 semanas = 364 días: se compara lunes con lunes, no 29/10 con 29/10.)
// · Valor REAL: cada mes se lleva a pesos del último IPC publicado (INDEC, datos.gob.ar),
//   así "vendiste 80% más" no esconde una caída real. Sin IPC → se muestra solo el nominal.
// · Desglose del período actual: por día/hora, local, empleado y medio de pago.
// Todas las consultas filtran por negocio_id (y sucursal si se elige).

const pool = require('./db');

const FL = `(fecha - INTERVAL '3 hours')`;               // hora Argentina (la base está en UTC)
const FL_CIERRE = `(hora_cierre - INTERVAL '3 hours')`;
const IPC_SERIE = '148.3_INIVELNAL_DICI_M_26';           // IPC nivel general nacional (INDEC)
const DIA_MS = 86400000;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// ─── Fechas (los campos UTC del Date representan la hora local de Argentina) ─────────
const fmtTS = d => d.toISOString().slice(0, 19).replace('T', ' ');
const fmtD = d => d.toISOString().slice(0, 10);
const dia = (y, m, d) => new Date(Date.UTC(y, m, d));
const sumD = (d, n) => new Date(d.getTime() + n * DIA_MS);
const minD = (a, b) => (a < b ? a : b);
const etiquetaDia = d => `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;

function ahoraLocal(opciones = {}) {
  return opciones.ahora ? new Date(opciones.ahora.replace(' ', 'T') + 'Z') : new Date(Date.now() - 3 * 3600000);
}

function rangos(periodo, ahora) {
  const y = ahora.getUTCFullYear(), m = ahora.getUTCMonth(), d = ahora.getUTCDate();
  const hoy0 = dia(y, m, d);
  const tramo = (ini, dur, tope) => ({ ini, fin: tope ? minD(new Date(ini.getTime() + dur), tope) : new Date(ini.getTime() + dur) });
  switch (periodo) {
    case 'hoy': {
      const dur = ahora - hoy0;
      const nombre = DIAS[ahora.getUTCDay()];
      return {
        actual: { ini: hoy0, fin: ahora, etiqueta: 'Hoy' },
        anterior: { ...tramo(sumD(hoy0, -7), dur), etiqueta: `el ${nombre} pasado` },
        anio: { ...tramo(sumD(hoy0, -364), dur), etiqueta: `el mismo ${nombre} del año pasado` },
        granularidad: 'hora',
      };
    }
    case 'semana': {
      const lunes = sumD(hoy0, -((ahora.getUTCDay() + 6) % 7));
      const dur = ahora - lunes;
      return {
        actual: { ini: lunes, fin: ahora, etiqueta: 'Esta semana' },
        anterior: { ...tramo(sumD(lunes, -7), dur), etiqueta: 'la semana pasada' },
        anio: { ...tramo(sumD(lunes, -364), dur), etiqueta: 'la misma semana del año pasado' },
        granularidad: 'dia',
      };
    }
    case 'anio': {
      const ini = dia(y, 0, 1);
      return {
        actual: { ini, fin: ahora, etiqueta: `${y}` },
        anterior: null,
        anio: { ...tramo(dia(y - 1, 0, 1), ahora - ini, dia(y, 0, 1)), etiqueta: `${y - 1} (mismo tramo)` },
        granularidad: 'mes',
      };
    }
    default: { // mes
      const ini = dia(y, m, 1);
      const dur = ahora - ini;
      return {
        actual: { ini, fin: ahora, etiqueta: 'Este mes' },
        anterior: { ...tramo(dia(y, m - 1, 1), dur, ini), etiqueta: 'el mes pasado' },
        anio: { ...tramo(dia(y - 1, m, 1), dur, dia(y - 1, m + 1, 1)), etiqueta: 'el mismo mes del año pasado' },
        granularidad: 'dia',
      };
    }
  }
}

// ─── IPC ─────────────────────────────────────────────────────────────────────
let actualizandoIPC = null;

async function actualizarIPC(db = pool) {
  if (actualizandoIPC) return actualizandoIPC;
  actualizandoIPC = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const url = `https://apis.datos.gob.ar/series/api/series/?ids=${IPC_SERIE}&format=json&limit=1000&start_date=2018-01-01`;
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`datos.gob.ar respondió ${r.status}`);
      const j = await r.json();
      const filas = (j.data || []).filter(f => f && f[0] && Number.isFinite(Number(f[1])));
      if (!filas.length) throw new Error('IPC vacío');
      await db.query(
        `INSERT INTO ipc_mensual (mes, indice, actualizado_en)
         SELECT x.mes::date, x.indice::numeric, NOW() FROM json_to_recordset($1::json) AS x(mes text, indice float)
         ON CONFLICT (mes) DO UPDATE SET indice = EXCLUDED.indice, actualizado_en = NOW()`,
        [JSON.stringify(filas.map(f => ({ mes: f[0], indice: Number(f[1]) })))]
      );
      return filas.length;
    } finally {
      clearTimeout(t);
      actualizandoIPC = null;
    }
  })();
  return actualizandoIPC;
}

async function cargarIPC(db = pool) {
  const leer = () => db.query(`SELECT to_char(mes,'YYYY-MM') AS mes, indice::float AS indice,
                                      (SELECT MAX(actualizado_en) FROM ipc_mensual) AS ult_act
                               FROM ipc_mensual ORDER BY mes`);
  let r;
  try { r = await leer(); } catch { return null; }              // tabla inexistente: sin ajuste
  const viejo = !r.rows.length || (Date.now() - new Date(r.rows[0].ult_act).getTime() > DIA_MS);
  if (viejo) {
    const p = actualizarIPC(db).catch(e => console.warn('[periodos] IPC no actualizado:', e.message));
    if (!r.rows.length) { await p; try { r = await leer(); } catch { return null; } }
  }
  if (!r.rows.length) return null;
  const mapa = new Map(r.rows.map(x => [x.mes, x.indice]));
  const ult = r.rows[r.rows.length - 1];
  return { mapa, ultMes: ult.mes, ultIndice: ult.indice };
}

// Lleva un monto del mes "YYYY-MM" a pesos del último IPC publicado.
// Meses más nuevos que el último IPC se toman como ya actualizados (factor 1).
const factorIPC = (ipc, mes) => (ipc ? ipc.ultIndice / (ipc.mapa.get(mes) ?? ipc.ultIndice) : 1);

// ─── Consultas ───────────────────────────────────────────────────────────────
async function ventasPorMes(db, negocioId, sucursalId, r) {
  const q = await db.query(
    `SELECT to_char(${FL}, 'YYYY-MM') AS mes, COUNT(*)::int AS tickets, COALESCE(SUM(monto),0)::float AS total
     FROM transacciones
     WHERE negocio_id = $1 AND ($2::integer IS NULL OR sucursal_id = $2)
       AND ${FL} >= $3::timestamp AND ${FL} < $4::timestamp
     GROUP BY 1`,
    [negocioId, sucursalId, fmtTS(r.ini), fmtTS(r.fin)]
  );
  return q.rows;
}

async function caja(db, negocioId, sucursalId, r) {
  const q = await db.query(
    `SELECT COUNT(*)::int AS turnos,
            COUNT(*) FILTER (WHERE brecha > 0)::int AS turnos_con_faltante,
            COALESCE(SUM(GREATEST(brecha, 0)),0)::float AS faltante,
            COALESCE(SUM(GREATEST(-brecha, 0)),0)::float AS sobrante
     FROM turnos_caja
     WHERE negocio_id = $1 AND ($2::integer IS NULL OR sucursal_id = $2)
       AND hora_cierre IS NOT NULL AND brecha IS NOT NULL
       AND ${FL_CIERRE} >= $3::timestamp AND ${FL_CIERRE} < $4::timestamp`,
    [negocioId, sucursalId, fmtTS(r.ini), fmtTS(r.fin)]
  );
  return q.rows[0];
}

async function resumen(db, negocioId, sucursalId, r, ipc) {
  if (!r) return null;
  const [meses, c] = await Promise.all([ventasPorMes(db, negocioId, sucursalId, r), caja(db, negocioId, sucursalId, r)]);
  const facturacion = meses.reduce((s, x) => s + x.total, 0);
  const tickets = meses.reduce((s, x) => s + x.tickets, 0);
  const real = ipc ? meses.reduce((s, x) => s + x.total * factorIPC(ipc, x.mes), 0) : null;
  return {
    desde: fmtTS(r.ini), hasta: fmtTS(r.fin), etiqueta: r.etiqueta,
    facturacion: Math.round(facturacion),
    facturacion_real: real == null ? null : Math.round(real),
    tickets,
    ticket_promedio: tickets ? Math.round(facturacion / tickets) : null,
    ticket_promedio_real: tickets && real != null ? Math.round(real / tickets) : null,
    turnos: c.turnos,
    turnos_con_faltante: c.turnos_con_faltante,
    faltante: Math.round(c.faltante),
    sobrante: Math.round(c.sobrante),
  };
}

const pct = (a, b) => (a == null || b == null || !b ? null : Math.round(((a - b) / b) * 1000) / 10);

function comparar(act, base) {
  if (!base) return null;
  const hayDatos = base.tickets > 0 || base.turnos > 0;
  return {
    etiqueta: base.etiqueta, desde: base.desde, hasta: base.hasta, hay_datos: hayDatos,
    base,
    variacion: {
      facturacion: pct(act.facturacion, base.facturacion),
      facturacion_real: pct(act.facturacion_real, base.facturacion_real),
      tickets: pct(act.tickets, base.tickets),
      ticket_promedio: pct(act.ticket_promedio, base.ticket_promedio),
      ticket_promedio_real: pct(act.ticket_promedio_real, base.ticket_promedio_real),
      faltante: pct(act.faltante, base.faltante),
    },
  };
}

const MEDIO = `CASE
  WHEN metodo_pago IS NULL OR TRIM(metodo_pago) = '' THEN 'Sin dato'
  WHEN LOWER(REPLACE(REPLACE(metodo_pago,' ',''),'_','')) IN ('mp','mercadopago') THEN 'Mercado Pago'
  WHEN LOWER(metodo_pago) = 'efectivo' THEN 'Efectivo'
  WHEN LOWER(metodo_pago) IN ('debito','débito','tarjeta_debito') THEN 'Débito'
  WHEN LOWER(metodo_pago) IN ('credito','crédito','tarjeta_credito') THEN 'Crédito'
  WHEN LOWER(metodo_pago) = 'transferencia' THEN 'Transferencia'
  ELSE INITCAP(REPLACE(metodo_pago,'_',' ')) END`;

async function desglose(db, negocioId, sucursalId, r) {
  const p = [negocioId, sucursalId, fmtTS(r.ini), fmtTS(r.fin)];
  const W = `WHERE t.negocio_id = $1 AND ($2::integer IS NULL OR t.sucursal_id = $2)
               AND ${FL.replace('fecha', 't.fecha')} >= $3::timestamp AND ${FL.replace('fecha', 't.fecha')} < $4::timestamp`;
  const agrupar = (expr, orden = 'total DESC') => db.query(
    `SELECT ${expr} AS clave, COUNT(*)::int AS tickets, COALESCE(SUM(t.monto),0)::float AS total
     FROM transacciones t ${expr.includes('s.nombre') ? 'LEFT JOIN mis_sucursales s ON s.id = t.sucursal_id' : ''}
     ${W} GROUP BY 1 ORDER BY ${orden}`, p).then(q => q.rows.map(x => ({ clave: x.clave, tickets: x.tickets, total: Math.round(x.total) })));
  const [suc, emp, medio, hora, dsem] = await Promise.all([
    agrupar(`COALESCE(s.nombre, 'Sin local')`),
    agrupar(`COALESCE(NULLIF(TRIM(t.empleado),''), 'Sin asignar')`),
    agrupar(MEDIO.replace(/metodo_pago/g, 't.metodo_pago')),
    agrupar(`EXTRACT(HOUR FROM ${FL.replace('fecha', 't.fecha')})::int`, 'clave'),
    agrupar(`EXTRACT(ISODOW FROM ${FL.replace('fecha', 't.fecha')})::int`, 'clave'),
  ]);
  const limpiarNombre = n => String(n).replace(/^[\s"']+|[\s"']+$/g, '');
  return {
    por_local: suc.map(x => ({ ...x, clave: limpiarNombre(x.clave) })),
    por_empleado: emp,
    por_medio: medio,
    por_hora: hora.map(x => ({ ...x, clave: `${String(x.clave).padStart(2, '0')}h` })),
    por_dia_semana: dsem.map(x => ({ ...x, clave: DIAS[x.clave % 7] })),
  };
}

// Serie para el gráfico: actual vs comparación, alineadas por posición (hora / día / mes)
async function serie(db, negocioId, sucursalId, r, gran) {
  if (!r) return [];
  const expr = gran === 'hora' ? `EXTRACT(HOUR FROM ${FL})::int`
    : gran === 'mes' ? `(EXTRACT(MONTH FROM ${FL})::int - 1)`
    : `FLOOR(EXTRACT(EPOCH FROM (${FL} - $3::timestamp)) / 86400)::int`;
  const q = await db.query(
    `SELECT ${expr} AS i, COALESCE(SUM(monto),0)::float AS total, COUNT(*)::int AS tickets
     FROM transacciones
     WHERE negocio_id = $1 AND ($2::integer IS NULL OR sucursal_id = $2)
       AND ${FL} >= $3::timestamp AND ${FL} < $4::timestamp
     GROUP BY 1 ORDER BY 1`,
    [negocioId, sucursalId, fmtTS(r.ini), fmtTS(r.fin)]
  );
  return q.rows;
}

function armarSerie(gran, rAct, filasAct, filasCmp) {
  let n, etiqueta;
  if (gran === 'hora') { n = 24; etiqueta = i => `${String(i).padStart(2, '0')}h`; }
  else if (gran === 'mes') { n = 12; etiqueta = i => MESES[i]; }
  else {
    const dias = Math.round((dia(rAct.fin.getUTCFullYear(), rAct.fin.getUTCMonth(), rAct.fin.getUTCDate()) - rAct.ini) / DIA_MS) + 1;
    n = rAct.etiqueta === 'Esta semana' ? 7 : new Date(Date.UTC(rAct.ini.getUTCFullYear(), rAct.ini.getUTCMonth() + 1, 0)).getUTCDate();
    n = Math.max(n, dias);
    etiqueta = i => (rAct.etiqueta === 'Esta semana' ? DIAS[(i + 1) % 7].slice(0, 3) : etiquetaDia(sumD(rAct.ini, i)));
  }
  const mA = new Map(filasAct.map(x => [x.i, x])), mC = new Map(filasCmp.map(x => [x.i, x]));
  const hasta = gran === 'hora' ? rAct.fin.getUTCHours()
    : gran === 'mes' ? rAct.fin.getUTCMonth()
    : Math.floor((rAct.fin - rAct.ini) / DIA_MS);
  return Array.from({ length: n }, (_, i) => ({
    etiqueta: etiqueta(i),
    actual: i <= hasta ? Math.round(mA.get(i)?.total ?? 0) : null,   // futuro: sin dato todavía
    comparacion: mC.has(i) ? Math.round(mC.get(i).total) : (i <= hasta ? 0 : null),
  }));
}

async function calcularPeriodo(negocioId, sucursalId = null, periodo = 'mes', opciones = {}, db = pool) {
  const ahora = ahoraLocal(opciones);
  const R = rangos(periodo, ahora);
  const ipc = opciones.sinIPC ? null : await cargarIPC(db);

  const [act, ant, anio] = await Promise.all([
    resumen(db, negocioId, sucursalId, R.actual, ipc),
    resumen(db, negocioId, sucursalId, R.anterior, ipc),
    resumen(db, negocioId, sucursalId, R.anio, ipc),
  ]);

  // Serie del gráfico: vs período anterior (hoy/semana/mes) o vs año pasado (año)
  const rCmp = R.anterior || R.anio;
  const rCmpCompleto = R.granularidad === 'hora' || R.granularidad === 'mes'
    ? { ini: rCmp.ini, fin: R.granularidad === 'hora' ? sumD(rCmp.ini, 1) : dia(rCmp.ini.getUTCFullYear() + 1, 0, 1) }
    : periodo === 'semana' ? { ini: rCmp.ini, fin: sumD(rCmp.ini, 7) }
    : { ini: rCmp.ini, fin: dia(rCmp.ini.getUTCFullYear(), rCmp.ini.getUTCMonth() + 1, 1) };
  const [sAct, sCmp, des] = await Promise.all([
    serie(db, negocioId, sucursalId, R.actual, R.granularidad),
    serie(db, negocioId, sucursalId, rCmpCompleto, R.granularidad),
    desglose(db, negocioId, sucursalId, R.actual),
  ]);

  return {
    periodo,
    sucursal_id: sucursalId,
    ahora: fmtTS(ahora),
    actual: act,
    vs_anterior: comparar(act, ant),
    vs_anio_anterior: comparar(act, anio),
    serie: {
      granularidad: R.granularidad,
      comparacion: rCmp === R.anterior ? (R.anterior?.etiqueta ?? '') : R.anio.etiqueta,
      puntos: armarSerie(R.granularidad, R.actual, sAct, sCmp),
    },
    desglose: des,
    inflacion: ipc
      ? { disponible: true, ipc_hasta: ipc.ultMes, nota: `Valores reales en pesos de ${ipc.ultMes.split('-').reverse().join('/')} (IPC INDEC).` }
      : { disponible: false, nota: 'Sin dato de inflación por ahora: se muestran solo valores nominales.' },
  };
}

module.exports = { calcularPeriodo, actualizarIPC, rangos, ahoraLocal };
