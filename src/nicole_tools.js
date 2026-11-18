// nicole_tools.js — herramientas con las que NICOLE consulta los datos reales del negocio (ventas, productos, hallazgos, plata recuperada).
// Todo se filtra por negocio_id, las fechas se validan y los resultados se acotan: NICOLE nunca ve datos de otro negocio ni inventa números.
const pool = require('./db');

const { FL_T: FL, REAL_T, ticketsNetos } = require('./ventas_sql');
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
    name: 'marcas_top',
    description: 'Ranking de marcas del negocio: cuánto vende cada una, cuántos productos tiene y qué ganancia y margen deja (si el costo está cargado). Usar para preguntas como qué marca vendo más, cuál me deja más ganancia o en cuál pierdo. Informa qué parte de lo vendido no tiene marca cargada.',
    input_schema: {
      type: 'object',
      properties: {
        dias: { type: 'integer', description: 'Cuántos días mirar hacia atrás, 1 a 180. Por defecto 30.' },
        orden: { type: 'string', enum: ['monto', 'ganancia', 'unidades'], description: 'Por defecto monto.' },
        limite: { type: 'integer', description: 'Cuántas marcas, 1 a 10. Por defecto 5.' },
      },
    },
  },
  {
    name: 'hallazgos_negocio',
    description: 'Lo más importante que detectó LumoBi hoy en el negocio (pantalla Oportunidades, dentro de Plata): problemas y oportunidades con su monto estimado, y las acciones que LumoBi puede armar. Usar cuando el dueño pregunta dónde pierde plata o qué debería mejorar.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ficha_producto',
    description: 'La ficha completa de UN producto, con los mismos números que la pantalla de la ficha: cuánto se vende y cuándo, cuánto deja, para cuántos días alcanza el stock, si el proveedor lo subió, quién cambió su precio y quién lo vende. Usar para preguntas sobre un producto puntual (cómo viene la yerba, para cuánto me alcanza la coca, cuánto me deja el café).',
    input_schema: { type: 'object', properties: { nombre: { type: 'string', description: 'Nombre del producto, como lo dice el dueño.' } }, required: ['nombre'] },
  },
  {
    name: 'ficha_persona',
    description: 'La ficha de UNA persona del equipo (últimos 30 días): cuánto vende, cómo cierra la caja y qué hace en la caja (anulaciones, descuentos, productos sacados), comparada con el resto del equipo. Hablá de hechos de la caja, nunca de culpas.',
    input_schema: { type: 'object', properties: { nombre: { type: 'string', description: 'Nombre del empleado.' } }, required: ['nombre'] },
  },
  {
    name: 'ficha_turno',
    description: 'La cuenta de la caja de UN turno paso a paso (con cuánto abrió, ventas en efectivo, gastos, cuánto tenía que haber y cuánto contó) y lo que pasó en la caja. Sin datos trae el último turno cerrado. Usar para preguntas como por qué faltó plata en un turno o cómo cerró el último turno.',
    input_schema: { type: 'object', properties: { turno_id: { type: 'integer', description: 'Número de turno, opcional.' }, empleado: { type: 'string', description: 'Trae el último turno cerrado de esa persona, opcional.' } } },
  },
  {
    name: 'ficha_proveedor',
    description: 'La ficha de UN proveedor: cada cuánto se le compra, cuánto, qué productos subió en la última compra y cuánta ganancia sacan esas subas por mes.',
    input_schema: { type: 'object', properties: { nombre: { type: 'string', description: 'Nombre del proveedor.' } }, required: ['nombre'] },
  },
  {
    name: 'que_pedir',
    description: 'Qué productos se van a terminar pronto y cuánto pedir para cubrir 2 semanas, agrupado por proveedor (pantalla Pedidos).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'que_mirar_hoy',
    description: 'Lo que el dueño tiene que mirar hoy (la misma lista que el Inicio y la pantalla En vivo) más cómo viene el día y cómo se espera mañana.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'costos_precios',
    description: 'Productos cuyo costo subió y el precio de venta quedó igual: cuánto costaba, cuánto cuesta, cuánto le queda al dueño de cada $100, a qué precio volver a ganar lo de antes y cuánta plata más por mes. Usar cuando preguntan qué precios subir, si el proveedor les subió o por qué ganan menos.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'precision_lumobi',
    description: 'Qué tan bien viene acertando LumoBi en este negocio: cuántas predicciones acertó, cuántos avisos le sirvieron al dueño, cuántos consejos funcionaron y qué avisos se ajustó solo. Usar cuando preguntan si pueden confiar en LumoBi o qué tan bien predice.',
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
  const filtro = `t.negocio_id = $1 AND ${FL}::date >= COALESCE($2::date, ${HOY_AR} - 29) AND ${FL}::date <= COALESCE($3::date, ${HOY_AR}) AND ($4::int IS NULL OR t.sucursal_id = $4) AND ${REAL_T}`;
  const params = [negocioId, desde, hasta, suc];
  const ventana = (await db.query(`SELECT COALESCE($1::date, ${HOY_AR} - 29)::text AS desde, COALESCE($2::date, ${HOY_AR})::text AS hasta`, [desde, hasta])).rows[0];
  const dias = Math.round((new Date(ventana.hasta) - new Date(ventana.desde)) / 86400000) + 1;
  if (dias < 1 || dias > 366) return { error: 'El período tiene que ser de 1 a 366 días.' };
  const base = { desde: ventana.desde, hasta: ventana.hasta, ver_en: '/periodos' };
  let q;
  if (agrupar === 'total') q = `SELECT ${ticketsNetos('t.')}::int AS tickets, COALESCE(SUM(t.monto),0)::float AS total, COUNT(DISTINCT ${FL}::date)::int AS dias_con_ventas FROM transacciones t WHERE ${filtro}`;
  else if (agrupar === 'dia') q = `SELECT ${FL}::date::text AS dia, ${ticketsNetos('t.')}::int AS tickets, SUM(t.monto)::float AS total FROM transacciones t WHERE ${filtro} GROUP BY 1 ORDER BY 1 DESC LIMIT 62`;
  else if (agrupar === 'dia_semana') q = `SELECT EXTRACT(DOW FROM ${FL})::int AS dow, ${ticketsNetos('t.')}::int AS tickets, SUM(t.monto)::float AS total, COUNT(DISTINCT ${FL}::date)::int AS dias FROM transacciones t WHERE ${filtro} GROUP BY 1 ORDER BY 1`;
  else if (agrupar === 'hora') q = `SELECT EXTRACT(HOUR FROM ${FL})::int AS hora, ${ticketsNetos('t.')}::int AS tickets, SUM(t.monto)::float AS total FROM transacciones t WHERE ${filtro} GROUP BY 1 ORDER BY 1`;
  else if (agrupar === 'medio_pago') q = `SELECT COALESCE(NULLIF(t.metodo_pago, ''), 'sin dato') AS medio, ${ticketsNetos('t.')}::int AS tickets, SUM(t.monto)::float AS total FROM transacciones t WHERE ${filtro} GROUP BY 1 ORDER BY 3 DESC LIMIT 12`;
  else q = `SELECT COALESCE(NULLIF(t.empleado, ''), 'sin dato') AS empleado, ${ticketsNetos('t.')}::int AS tickets, SUM(t.monto)::float AS total FROM transacciones t WHERE ${filtro} GROUP BY 1 ORDER BY 3 DESC LIMIT 15`;
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
      `SELECT p.nombre, p.marca, SUM(d.cantidad)::float AS unidades, SUM(d.subtotal)::float AS monto, p.precio_venta::float AS precio, p.precio_costo::float AS costo
         FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id JOIN productos p ON p.id = d.producto_id
        WHERE t.negocio_id = $1 AND p.negocio_id = $1 AND ${FL}::date >= ${HOY_AR} - ($2::int - 1)
        GROUP BY p.id ORDER BY ${orden} DESC NULLS LAST LIMIT $3`, [negocioId, dias, limite])).rows;
  } catch (e) { if (e.code === '42P01') rows = []; else throw e; }
  if (!rows.length) return { productos: [], nota: 'No hay ventas cargadas con productos en ese período.', ver_en: '/catalogo' };
  return {
    dias, ver_en: '/catalogo',
    productos: rows.map((x) => ({
      nombre: x.nombre, marca: x.marca || null, unidades: x.unidades, monto: x.monto,
      margen_pct: x.costo > 0 && x.precio > 0 ? Math.round((1 - x.costo / x.precio) * 100) : null,
    })),
  };
}

async function marcasTop(negocioId, input, db) {
  const dias = Math.min(180, Math.max(1, Number.isInteger(input && input.dias) ? input.dias : 30));
  const limite = Math.min(10, Math.max(1, Number.isInteger(input && input.limite) ? input.limite : 5));
  const orden = ['monto', 'ganancia', 'unidades'].includes(input && input.orden) ? input.orden : 'monto';
  let rows;
  try {
    await require('./catalogo_marca').asegurar(db);
    // La marca de la venta es la del momento; si es una venta vieja sin esa foto, se usa la marca actual del producto
    rows = (await db.query(
      `SELECT COALESCE(NULLIF(d.producto_marca, ''), NULLIF(p.marca, '')) AS marca,
              SUM(d.cantidad)::float AS unidades, SUM(d.subtotal)::float AS monto, COUNT(DISTINCT p.id)::int AS productos,
              SUM(CASE WHEN COALESCE(d.costo_unitario, p.precio_costo) > 0 THEN d.subtotal ELSE 0 END)::float AS monto_con_costo,
              SUM(CASE WHEN COALESCE(d.costo_unitario, p.precio_costo) > 0 THEN d.subtotal - d.cantidad * COALESCE(d.costo_unitario, p.precio_costo) ELSE 0 END)::float AS ganancia
         FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id JOIN productos p ON p.id = d.producto_id
        WHERE t.negocio_id = $1 AND p.negocio_id = $1 AND ${FL}::date >= ${HOY_AR} - ($2::int - 1)
        GROUP BY 1`, [negocioId, dias])).rows;
  } catch (e) { if (e.code === '42P01') rows = []; else throw e; }
  if (!rows.length) return { marcas: [], nota: 'No hay ventas cargadas con productos en ese período.', ver_en: '/catalogo' };
  const total = rows.reduce((s, x) => s + (x.monto || 0), 0);
  const sinMarca = rows.filter((x) => !x.marca).reduce((s, x) => s + (x.monto || 0), 0);
  const conMarca = rows.filter((x) => x.marca).sort((a, b) => (orden === 'ganancia' ? b.ganancia - a.ganancia : orden === 'unidades' ? b.unidades - a.unidades : b.monto - a.monto)).slice(0, limite);
  return {
    dias, ver_en: '/catalogo',
    porcentaje_vendido_sin_marca: total > 0 ? Math.round((sinMarca / total) * 100) : 0,
    nota: total > 0 && sinMarca / total > 0.3 ? 'Más del 30% de lo vendido no tiene marca cargada: el ranking es parcial. Se completa desde el catálogo.' : undefined,
    marcas: conMarca.map((x) => ({
      marca: x.marca, unidades: x.unidades, monto: x.monto, productos: x.productos,
      ganancia: x.monto_con_costo > 0 ? Math.round(x.ganancia) : null,
      margen_pct: x.monto_con_costo > 0 ? Math.round((x.ganancia / x.monto_con_costo) * 100) : null,
      costo_cargado_pct: x.monto > 0 ? Math.round((x.monto_con_costo / x.monto) * 100) : 0,
    })),
  };
}

// ── Fichas: NICOLE usa EXACTAMENTE el mismo código que las pantallas, así nunca dice un número distinto ──
const sinTildes = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
// Busca por nombre sin importar mayúsculas ni tildes. Una sola coincidencia → esa; varias → las lista para preguntar.
function elegir(lista, texto, clave = (x) => x) {
  const q = sinTildes(texto);
  if (!q) return { vacio: true };
  const exactos = lista.filter((x) => sinTildes(clave(x)) === q);
  if (exactos.length === 1) return { uno: exactos[0] };
  const parecidos = (exactos.length ? exactos : lista.filter((x) => sinTildes(clave(x)).includes(q)));
  if (parecidos.length === 1) return { uno: parecidos[0] };
  return parecidos.length ? { varios: parecidos.slice(0, 6) } : { ninguno: true };
}
const resumirProducto = (f) => ({ producto: f.producto.nombre, frases: f.frases, vendidas_por_semana: f.ventas.por_semana, mejor_dia: f.cuando.mejor_dia, hora_pico: f.cuando.hora_pico,
  ganancia: f.ganancia, stock: f.stock, proveedor_suba_pct: f.proveedor.suba_pct, ultimos_cambios_de_precio: (f.cambios_precio || []).slice(0, 3), quien_lo_vende: f.quien_lo_vende.slice(0, 3), ver_en: `/ficha/producto/${f.producto.id}` });

async function fichas(nombre, input, negocioId, db) {
  const F = require('./ficha');
  if (nombre === 'ficha_producto') {
    const l = (await db.query('SELECT id, nombre FROM productos WHERE negocio_id = $1 AND COALESCE(activo, true)', [negocioId])).rows;
    const e = elegir(l, input.nombre, (x) => x.nombre);
    if (e.uno) return resumirProducto(await F.fichaProducto(negocioId, e.uno.id, db));
    if (e.varios) return { aclarar: 'Hay varios productos parecidos. Preguntale a cuál se refiere.', opciones: e.varios.map((x) => x.nombre) };
    return { error: 'No encontré ese producto en el catálogo.' };
  }
  if (nombre === 'ficha_persona') {
    const l = (await db.query(`SELECT DISTINCT nombre_empleado AS n FROM turnos_caja WHERE negocio_id = $1 AND nombre_empleado IS NOT NULL`, [negocioId])).rows;
    const e = elegir(l, input.nombre, (x) => x.n);
    if (e.varios) return { aclarar: 'Hay varias personas con ese nombre.', opciones: e.varios.map((x) => x.n) };
    if (!e.uno) return { error: 'No encontré a esa persona entre los turnos de caja.' };
    const f = await F.fichaEmpleado(negocioId, e.uno.n, db);
    if (!f) return { error: 'Esa persona no tiene turnos en los últimos 30 días.' };
    return { persona: f.empleado, frases: f.frases, senales: f.senales, ventas: f.ventas, caja: f.caja, acciones_en_la_caja: f.acciones, turnos_recientes: (f.turnos_recientes || []).slice(0, 5), ver_en: `/ficha/persona/${encodeURIComponent(f.empleado)}` };
  }
  if (nombre === 'ficha_turno') {
    let id = Number(input.turno_id) || null;
    if (!id) {
      const emp = input.empleado ? (await db.query(`SELECT DISTINCT nombre_empleado AS n FROM turnos_caja WHERE negocio_id = $1 AND nombre_empleado IS NOT NULL`, [negocioId])).rows : null;
      const e = emp ? elegir(emp, input.empleado, (x) => x.n) : null;
      if (emp && !e.uno) return { error: 'No encontré a esa persona.' };
      const r = await db.query(`SELECT id FROM turnos_caja WHERE negocio_id = $1 AND estado = 'cerrado' AND ($2::text IS NULL OR nombre_empleado = $2) ORDER BY hora_apertura DESC LIMIT 1`, [negocioId, e ? e.uno.n : null]);
      id = r.rows[0] && r.rows[0].id;
    }
    const f = id ? await F.fichaTurno(negocioId, id, db) : null;
    if (!f) return { error: 'No encontré ese turno.' };
    return { turno: f.turno, frases: f.frases, senales: f.senales, cuenta: f.cuenta.map((c) => `${c.paso}: $${c.monto}`), totales: f.totales, lo_que_paso_en_la_caja: f.hechos.slice(0, 8).map((h) => `${h.hora} ${h.tipo}${h.detalle ? ' (' + h.detalle + ')' : ''}`), mas_vendidos: f.mas_vendidos, ver_en: `/ficha/turno/${f.turno.id}` };
  }
  if (nombre === 'ficha_proveedor') {
    const l = (await db.query(`SELECT DISTINCT proveedor AS n FROM compras WHERE negocio_id = $1 AND proveedor IS NOT NULL`, [negocioId]).catch(() => ({ rows: [] }))).rows;
    const e = elegir(l, input.nombre, (x) => x.n);
    if (e.varios) return { aclarar: 'Hay varios proveedores parecidos.', opciones: e.varios.map((x) => x.n) };
    if (!e.uno) return { error: 'No encontré ese proveedor en las facturas cargadas.' };
    const f = await F.fichaProveedor(negocioId, e.uno.n, db);
    return { proveedor: f.proveedor, frases: f.frases, resumen: f.resumen, subieron: f.subieron.slice(0, 5), ver_en: `/ficha/proveedor/${encodeURIComponent(f.proveedor)}` };
  }
  if (nombre === 'precision_lumobi') return { ...(await require('./precision').precision(negocioId, db)), ver_en: '/oportunidades' };
  if (nombre === 'que_pedir') {
    const r = await require('./pedidos').calcular(negocioId, db);
    return { ...r, por_proveedor: (r.por_proveedor || []).slice(0, 5).map((g) => ({ ...g, items: (g.items || []).slice(0, 6) })), ver_en: '/pedidos' };
  }
  if (nombre === 'costos_precios') {
    const r = await require('./margen_costos').calcular(negocioId, db);
    return { frase: r.frase, total_mes: r.total_mes, productos: r.items.slice(0, 6).map((i) => ({ frase: i.frase, por_mes: i.por_mes })), ver_en: '/costos' };
  }
  if (nombre === 'que_mirar_hoy') {
    const s = await require('./sala').sala(negocioId, null, db);
    return { fecha: s.fecha, para_mirar: s.revisar, ahora: s.ahora, viene: s.viene, ver_en: '/en-vivo' };
  }
  return null;
}

async function ejecutar(nombre, input, negocioId, db = pool) {
  input = input && typeof input === 'object' ? input : {};
  if (nombre === 'ventas_periodo') return ventasPeriodo(negocioId, input, db);
  if (nombre === 'productos_top') return productosTop(negocioId, input, db);
  if (nombre === 'marcas_top') return marcasTop(negocioId, input, db);
  if (nombre === 'hallazgos_negocio') {
    const r = await require('./hallazgos').radiografia(negocioId);
    return {
      datos_suficientes: r.suficiente, ver_en: '/oportunidades',
      hallazgos: (r.hallazgos || []).map((h) => ({
        titulo: h.titulo, detalle: h.detalle, monto: h.monto_texto || h.monto, es_buena_noticia: !!h.positivo,
        acciones_que_lumobi_puede_armar: (h.acciones || []).map((a) => a.titulo),
      })),
    };
  }
  if (['ficha_producto', 'ficha_persona', 'ficha_turno', 'ficha_proveedor', 'que_pedir', 'que_mirar_hoy', 'costos_precios', 'precision_lumobi'].includes(nombre)) return fichas(nombre, input, negocioId, db);
  if (nombre === 'plata_recuperada') return require('./hallazgos').resumenRecuperado(negocioId);
  return { error: 'tool desconocida: ' + nombre };
}

module.exports = { TOOLS, ejecutar };
