// revelacion.js — LumoBi · la "revelación" de los primeros minutos (15/11/2026)
//
// Lo que ve el dueño apenas sube sus ventas (Excel, PDF, foto) o conecta Mercado Pago:
//   1) LECTURA  → hechos medidos de SU negocio (cuántas ventas, qué día/hora se vende, cuánto es efectivo).
//   2) HALLAZGOS → los 3 que más plata mueven, cada uno con su botón a la solución.
//   3) PLATA EN JUEGO → suma de las estimaciones de esos hallazgos (siempre "estimada", nunca "recuperada").
// Todo sale de sus datos. Si hay poco, lo dice; no inventa.

const pool = require('./db');
const { hallazgosWow } = require('./hallazgos_wow');

const { FL_T: FL, REAL_T: REAL } = require('./ventas_sql');
const HOY = `(NOW() - INTERVAL '3 hours')::date`;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const $ = (n) => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('es-AR');

// A dónde lleva cada hallazgo para resolverlo.
const ACCION = {
  combo_natural: { texto: 'Armar el combo', href: '/catalogo' },
  margen_estrella: { texto: 'Ver mis productos', href: '/catalogo' },
  falta_stock: { texto: 'Revisar el stock', href: '/catalogo' },
  diferencias_caja: { texto: 'Ver los cierres', href: '/equipo' },
  ticket_empleado: { texto: 'Ver mi equipo', href: '/equipo' },
  hora_muerta: { texto: 'Ver horarios', href: '/equipo' },
  concentracion_pico: { texto: 'Ver mis horas', href: '/en-vivo' },
  dia_flojo: { texto: 'Ver oportunidades', href: '/oportunidades' },
};

// Día de la semana que vende claramente menos que el resto (funciona con solo un archivo de ventas).
async function diaFlojo(db, negocioId) {
  const r = await db.query(
    `WITH d AS (
       SELECT ${FL}::date dia, EXTRACT(DOW FROM ${FL})::int dow, SUM(t.monto)::float total
       FROM transacciones t WHERE t.negocio_id=$1 AND ${REAL} AND ${FL}::date >= ${HOY} - 56
       GROUP BY 1,2)
     SELECT dow, COUNT(*)::int veces, AVG(total)::float prom FROM d GROUP BY dow`, [negocioId]);
  const dias = r.rows.filter((x) => x.veces >= 2);
  if (dias.length < 5) return null;
  const flojo = dias.reduce((a, b) => (b.prom < a.prom ? b : a));
  const otros = dias.filter((x) => x.dow !== flojo.dow);
  const promOtros = otros.reduce((a, b) => a + b.prom, 0) / otros.length;
  if (flojo.prom >= promOtros * 0.6) return null;
  // Conservador: si ese día llegara al 70% de un día normal, por mes (4 semanas):
  const impacto = Math.round((promOtros * 0.7 - flojo.prom) * 4);
  if (impacto < 1000) return null;
  const nombre = DIAS[flojo.dow];
  const plural = nombre.endsWith('s') ? nombre : nombre + 's';
  return {
    id: 'dia_flojo', icono: '',
    titulo: `Los ${plural} vendés ${$(flojo.prom)}; un día normal, ${$(promOtros)}`,
    descripcion: `Es ${Math.round((1 - flojo.prom / promOtros) * 100)}% menos que el promedio de los otros días (${flojo.veces} ${plural} medidos).`,
    duele: `Ese día el local está abierto igual: se paga lo mismo y entra mucho menos.`,
    recomendacion: `Probá una promo solo para los ${plural} (un combo o un 2x1 en lo que menos rota). Si ese día llega al 70% de uno normal, son unos ${$(impacto)} más por mes.`,
    advertencia: 'Estimación con tus ventas de las últimas 8 semanas.', impacto_pesos: impacto, confianza: 70,
    detalle: { dia: nombre, promedio: Math.round(flojo.prom), promedio_otros: Math.round(promOtros) },
  };
}

async function lectura(db, negocioId) {
  const r = await db.query(
    `SELECT COUNT(*)::int ventas, COUNT(DISTINCT ${FL}::date)::int dias,
            MIN(${FL}::date)::text desde, MAX(${FL}::date)::text hasta,
            COALESCE(SUM(t.monto),0)::float total, COALESCE(AVG(t.monto),0)::float ticket,
            COALESCE(SUM(t.monto) FILTER (WHERE lower(COALESCE(t.metodo_pago,'')) IN ('efectivo','cash')),0)::float efectivo
     FROM transacciones t WHERE t.negocio_id=$1 AND ${REAL} AND t.monto > 0`, [negocioId]);
  const x = r.rows[0];
  if (!x.ventas) return null;
  const [dow, hora] = await Promise.all([
    db.query(`SELECT EXTRACT(DOW FROM ${FL})::int k, SUM(t.monto)::float total, COUNT(DISTINCT ${FL}::date)::int n
              FROM transacciones t WHERE t.negocio_id=$1 AND ${REAL} AND t.monto > 0 GROUP BY 1`, [negocioId]),
    db.query(`SELECT EXTRACT(HOUR FROM ${FL})::int k, SUM(t.monto)::float total
              FROM transacciones t WHERE t.negocio_id=$1 AND ${REAL} AND t.monto > 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, [negocioId]),
  ]);
  const prom = dow.rows.filter((d) => d.n >= 1).map((d) => ({ k: d.k, p: d.total / d.n }));
  const mejor = prom.sort((a, b) => b.p - a.p)[0];
  return {
    ventas: x.ventas, dias: x.dias, desde: x.desde, hasta: x.hasta,
    total: Math.round(x.total), ticket: Math.round(x.ticket),
    pct_efectivo: x.total > 0 ? Math.round((x.efectivo / x.total) * 100) : null,
    mejor_dia: mejor && prom.length >= 3 ? { nombre: DIAS[mejor.k], promedio: Math.round(mejor.p) } : null,
    hora_pico: hora.rows[0] ? hora.rows[0].k : null,
  };
}

async function comisionesMP(db, negocioId) {
  try {
    const r = await db.query(
      `SELECT COALESCE(SUM(comision),0)::float c, COALESCE(SUM(monto),0)::float m, COUNT(*)::int n
       FROM pagos_mp WHERE negocio_id=$1 AND estado='approved' AND fecha >= NOW() - INTERVAL '30 days'`, [negocioId]);
    const x = r.rows[0];
    if (!x.n) return null;
    return { cobros: x.n, cobrado: Math.round(x.m), comision: Math.round(x.c), pct: x.m > 0 ? Math.round((x.c / x.m) * 1000) / 10 : 0 };
  } catch (e) { return null; }
}

async function revelacion(negocioId, db = pool) {
  if (!negocioId) return { hay_datos: false };
  const [lec, mp, flojo, wow] = await Promise.all([
    lectura(db, negocioId),
    comisionesMP(db, negocioId),
    diaFlojo(db, negocioId).catch(() => null),
    hallazgosWow(negocioId, db).catch(() => []),
  ]);
  if (!lec && !mp) return { hay_datos: false };
  const todos = [...wow, ...(flojo ? [flojo] : [])].sort((a, b) => b.impacto_pesos - a.impacto_pesos);
  const hallazgos = todos.slice(0, 3).map((h) => ({ ...h, accion: ACCION[h.id] || { texto: 'Ver más', href: '/oportunidades' } }));
  const plata = hallazgos.reduce((a, h) => a + (h.impacto_pesos || 0), 0);
  return {
    hay_datos: true,
    lectura: lec,
    mercado_pago: mp,
    hallazgos,
    plata_en_juego: plata,
    poca_data: !lec || lec.dias < 7,
  };
}

module.exports = { revelacion };
