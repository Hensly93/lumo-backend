// nicole_tools.js — herramientas con las que NICOLE consulta los datos reales del negocio (ventas, productos, hallazgos, plata recuperada).
// Todo se filtra por negocio_id, las fechas se validan y los resultados se acotan: NICOLE nunca ve datos de otro negocio ni inventa números.
const pool = require('./db');

const FL = "(t.fecha - INTERVAL '3 hours')";
const HOY_AR = "(NOW() - INTERVAL '3 hours')::date";
const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const TOOLS = [
  {
    name: 'ventas_periodo',
    description: 'Ventas reales del negocio en un período, con la agrupación que se pida. Usar para cualquier pregunta con números de ventas: cuánto vendí, qué día o a qué hora vendo más, cómo cobro (medio de pago), cómo rinde cada empleado. Sin fechas trae los últimos 30 días.',
    input_schema: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: 'Fecha inicial YYYY-MM-DD (hora de Argentina), opcional.' },
        hasta: { type: 'string', description: 'Fecha final YYYY-MM-DD inclusive, opcional.' },
        agrupar: { type: 'string', enum: ['total', 'dia', 'dia_semana', 'hora', 'medio_pago', 'empleado'], description: 'Cómo agrupar. Por defecto total.' },
        sucursal_id: { type: 'integer', description: 'Sucursal específica, opcional.' },
      },
    },
  },
  {
    name: 'productos_top',
    description: 'Productos que más se venden (por unidades o por plata) en los últimos días, con margen si el costo está cargado. Solo cuenta ventas cargadas con productos.',
    input_schema: {
      type: 'object',
      properties: {
        dias: { type: 'integer', description: 'Cuántos días mirar hacia atrás, 1 a 180. Por defecto 30.' },
        orden: { type: 'string', enum: ['unidades', 'monto'], description: 'Por defecto unidades.' },
        limite: { type: 'integer', description: 'Cuántos productos, 1 a 10. Por defecto 5.' },
      },
    },
  },
  {
    name: 'hallazgos_negocio',
    description: 'Lo más importante que detectó LumoBi hoy en el negocio (la Radiografía): problemas y oportunidades con su monto estimado, y las acciones que LumoBi puede armar. Usar cuando el dueño pregunta dónde pierde plata o qué debería mejorar.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'plata_recuperada',
    description: 'Cuánta plata recuperó el dueño con las acciones que probó, y cuáles se están midiendo todavía.',
    input_schema: { type: 'object', properties: {} },
  },
];

function rango(input) {
  const d = input && ISO.test(String(input.desde || '')) ? String(input.desde) : null;
  const h = input && ISO.test(String(input.hasta || '')) ? String(input.hasta) : null;
  return { desde: d, hasta: h };
}

async function ventasPeriodo(negocioId, input, db) {
  const { desde, hasta } = rango(input);
  const suc = Number.isInteger(input && input.sucursal_id) ? input.sucursal_id : null;
  const agrupar = ['total', 'dia', 'dia_semana', 'hora', 'medio_pago', 'empleado'].includes(input && input.agrupar) ? input.agrupar : 'total';
  const filtro = `t.negocio_id = $1 AND ${FL}::date >= COALESCE($2::date, ${HOY_AR} - 29) AND ${FL}::date <= COALESCE($3::date, ${HOY_AR}) AND ($4::int IS NULL OR t.sucursal_id = $4)`;
  const params = [negocioId, desde, hasta, suc];
  const ventana = (await db.query(`SELECT COALESCE($1::date, ${HOY_AR} - 29)::text AS desde, COALESCE($2::date, ${HOY_AR})::text AS hasta`, [desde, hasta])).rows[0];
  const dias = Math.round((new Date(ventana.hasta) - new Date(ventana.desde)) / 86400000) + 1;
  if (dias < 1 || dias > 366) return { error: 'El período tiene que ser de 1 a 366 días.' };
  const base = { desde: ventana.desde, hasta: ventana.hasta, ver_en: '/periodos' };
  let q;
  if (agrupar === 'total') q = `SELECT COUNT(*)::int AS tickets, COALESCE(SUM(t.monto),0)::float AS total, COUNT(DISTINCT ${FL}::date)::int AS dias_con_ventas FROM transacciones t WHERE ${filtro}`;
  else if (agrupar === 'dia') q = `SELECT ${FL}::date::text AS dia, COUNT(*)::int AS tickets, SUM(t.monto)::float AS total FROM transacciones t WHERE ${filtro} GROUP BY 1 ORDER BY 1 DESC LIMIT 62`;
  else if (agrupar === 'dia_semana') q = `SELECT EXTRACT(DOW FROM ${FL})::int AS dow, COUNT(*)::int AS tickets, SUM(t.monto)::float AS total, COUNT(DISTINCT ${FL}::date)::int AS dias FROM transacciones t WHERE ${filtro} GROUP BY 1 ORDER BY 1`;
  else if (agrupar === 'hora') q = `SELECT EXTRACT(HOUR FROM ${FL})::int AS hora, COUNT(*)::int AS tickets, SUM(t.monto)::float AS total FROM transacciones t WHERE ${filtro} GROUP BY 1 ORDER BY 1`;
  else if (agrupar === 'medio_pago') q = `SELECT COALESCE(NULLIF(t.metodo_pago, ''), 'sin dato') AS medio, COUNT(*)::int AS tickets, SUM(t.monto)::float AS total FROM transacciones t WHERE ${filtro} GROUP BY 1 ORDER BY 3 DESC LIMIT 12`;
  else q = `SELECT COALESCE(NULLIF(t.empleado, ''), 'sin dato') AS empleado, COUNT(*)::int AS tickets, SUM(t.monto)::float AS total FROM transacciones t WHERE ${filtro} GROUP BY 1 ORDER BY 3 DESC LIMIT 15`;
  const rows = (await db.query(q, params)).rows;
  if (agrupar === 'total') { const r = rows[0]; return { ...base, ...r, ticket_promedio: r.tickets ? Math.round(r.total / r.tickets) : 0 }; }
  if (!rows.length) return { ...base, agrupar, filas: [], nota: 'No hay ventas cargadas en ese período.' };
  if (agrupar === 'dia_semana') return { ...base, agrupar, filas: rows.map((x) => ({ dia: DOW[x.dow], tickets: x.tickets, total: x.total, dias_con_ventas: x.dias, promedio_por_dia: Math.round(x.total / x.dias) })) };
  return { ...base, agrupar, filas: rows };
}

async function productosTop(negocioId, input, db) {
  const dias = Math.min(180, Math.max(1, Number.isInteger(input && input.dias) ? input.dias : 30));
  const limite = Math.min(10, Math.max(1, Number.isInteger(input && input.limite) ? input.limite : 5));
  const orden = input && input.orden === 'monto' ? 'monto' : 'unidades';
  let rows;
  try {
    rows = (await db.query(
      `SELECT p.nombre, SUM(d.cantidad)::float AS unidades, SUM(d.subtotal)::float AS monto, p.precio_venta::float AS precio, p.precio_costo::float AS costo
         FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id JOIN productos p ON p.id = d.producto_id
        WHERE t.negocio_id = $1 AND p.negocio_id = $1 AND ${FL}::date >= ${HOY_AR} - ($2::int - 1)
        GROUP BY p.id ORDER BY ${orden} DESC NULLS LAST LIMIT $3`, [negocioId, dias, limite])).rows;
  } catch (e) { if (e.code === '42P01') rows = []; else throw e; }
  if (!rows.length) return { productos: [], nota: 'No hay ventas cargadas con productos en ese período.', ver_en: '/catalogo' };
  return {
    dias, ver_en: '/catalogo',
    productos: rows.map((x) => ({
      nombre: x.nombre, unidades: x.unidades, monto: x.monto,
      margen_pct: x.costo > 0 && x.precio > 0 ? Math.round((1 - x.costo / x.precio) * 100) : null,
    })),
  };
}

async function ejecutar(nombre, input, negocioId, db = pool) {
  input = input && typeof input === 'object' ? input : {};
  if (nombre === 'ventas_periodo') return ventasPeriodo(negocioId, input, db);
  if (nombre === 'productos_top') return productosTop(negocioId, input, db);
  if (nombre === 'hallazgos_negocio') {
    const r = await require('./hallazgos').radiografia(negocioId);
    return {
      datos_suficientes: r.suficiente, ver_en: '/',
      hallazgos: (r.hallazgos || []).map((h) => ({
        titulo: h.titulo, detalle: h.detalle, monto: h.monto_texto || h.monto, es_buena_noticia: !!h.positivo,
        acciones_que_lumobi_puede_armar: (h.acciones || []).map((a) => a.titulo),
      })),
    };
  }
  if (nombre === 'plata_recuperada') return require('./hallazgos').resumenRecuperado(negocioId);
  return { error: 'tool desconocida: ' + nombre };
}

module.exports = { TOOLS, ejecutar };
