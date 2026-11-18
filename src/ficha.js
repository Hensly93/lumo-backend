// ficha.js — la ficha de cada cosa del negocio, con todo conectado (Palantir, 14/11/2026).
//   · Producto: cuánto se vende y cuándo, cuánto deja, stock y para cuántos días alcanza, subas del proveedor,
//     cambios de precio (quién y cuándo), quién lo vende, anulaciones y lo que se espera vender.
//   · Empleado: cuánto vende y a qué ritmo, cómo cierra la caja, anulaciones, descuentos, productos sacados
//     del carrito y ventas en espera sin cobrar, comparado con el resto del equipo.
// Todo sale de la base (30 días) y cada número viene con su frase en criollo. Nada se inventa.
const pool = require('./db');
const CF = require('./caja_faltante');

const { FL_T: FL } = require('./ventas_sql');
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const $ = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const d1 = (n) => r1(n).toLocaleString('es-AR'); // para frases: 0,9 y no 0.9
const VENTANA = 30;

async function fichaProducto(negocioId, productoId, db = pool) {
  await require('./caja_extra').asegurar(db).catch(() => {});
  const p = (await db.query(
    `SELECT id, nombre, marca, categoria, precio_venta::float AS precio, precio_costo::float AS costo, unidad, codigo_barras,
            stock::float AS stock, stock_minimo::float AS stock_minimo
       FROM productos WHERE id = $1 AND negocio_id = $2`, [productoId, negocioId])).rows[0];
  if (!p) return null;

  const [ventas, porDia, porHora, porEmpleado, cambios, compras, anul, porSemana] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(d.cantidad),0)::float AS unidades, COALESCE(SUM(d.subtotal),0)::float AS plata,
                     COUNT(DISTINCT t.id) FILTER (WHERE t.tipo = 'venta')::int AS tickets,
                     COUNT(DISTINCT ${FL}::date) FILTER (WHERE t.tipo = 'venta')::int AS dias_con_venta,
                     to_char(MAX(${FL}) FILTER (WHERE t.tipo = 'venta'),'DD/MM HH24:MI') AS ultima
                FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
               WHERE t.negocio_id = $1 AND d.producto_id = $2 AND t.fecha >= NOW() - ($3::int * INTERVAL '1 day')`, [negocioId, productoId, VENTANA]),
    db.query(`SELECT EXTRACT(DOW FROM ${FL})::int AS dow, SUM(d.cantidad)::float AS u
                FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
               WHERE t.negocio_id = $1 AND d.producto_id = $2 AND t.fecha >= NOW() - INTERVAL '56 days' GROUP BY 1`, [negocioId, productoId]),
    db.query(`SELECT EXTRACT(HOUR FROM ${FL})::int AS h, SUM(d.cantidad)::float AS u
                FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
               WHERE t.negocio_id = $1 AND d.producto_id = $2 AND t.fecha >= NOW() - ($3::int * INTERVAL '1 day') GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, [negocioId, productoId, VENTANA]),
    db.query(`SELECT t.empleado, SUM(d.cantidad)::float AS u, SUM(d.subtotal)::float AS plata
                FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
               WHERE t.negocio_id = $1 AND d.producto_id = $2 AND t.fecha >= NOW() - ($3::int * INTERVAL '1 day') AND t.empleado IS NOT NULL
               GROUP BY 1 HAVING SUM(d.cantidad) > 0 ORDER BY 2 DESC LIMIT 5`, [negocioId, productoId, VENTANA]),
    db.query(`SELECT campo, valor_anterior::float AS antes, valor_nuevo::float AS despues, empleado, origen, to_char(creado - INTERVAL '3 hours','DD/MM HH24:MI') AS cuando
                FROM cambios_precios WHERE negocio_id = $1 AND producto_id = $2 ORDER BY creado DESC LIMIT 6`, [negocioId, productoId]).catch(() => ({ rows: [] })),
    db.query(`SELECT c.proveedor, c.fecha::text AS fecha, i.precio_unitario::float AS precio, i.cantidad::float AS cantidad
                FROM compras_items i JOIN compras c ON c.id = i.compra_id
               WHERE c.negocio_id = $1 AND i.producto_id = $2 AND i.precio_unitario > 0 ORDER BY c.fecha DESC, c.id DESC LIMIT 4`, [negocioId, productoId]).catch(() => ({ rows: [] })),
    db.query(`SELECT COALESCE(-SUM(d.cantidad),0)::float AS u, COUNT(DISTINCT t.id)::int AS n
                FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
               WHERE t.negocio_id = $1 AND d.producto_id = $2 AND t.tipo = 'anulacion' AND t.fecha >= NOW() - ($3::int * INTERVAL '1 day')`, [negocioId, productoId, VENTANA]),
    db.query(`SELECT ((NOW() - INTERVAL '3 hours')::date - ${FL}::date) / 7 AS semana, SUM(d.cantidad)::float AS u
                FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
               WHERE t.negocio_id = $1 AND d.producto_id = $2 AND t.fecha >= NOW() - INTERVAL '28 days' GROUP BY 1`, [negocioId, productoId]),
  ]);

  const v = ventas.rows[0];
  const porDiaU = v.unidades / VENTANA;
  const ganancia = p.costo > 0 && p.precio > 0 ? { por_unidad: p.precio - p.costo, pct: r1(((p.precio - p.costo) / p.precio) * 100), mes: (p.precio - p.costo) * v.unidades } : null;
  const diasStock = p.stock != null && porDiaU > 0 ? Math.floor(p.stock / porDiaU) : null;
  const mejorDia = porDia.rows.length ? porDia.rows.reduce((a, b) => (b.u > a.u ? b : a)) : null;
  const sem = Object.fromEntries(porSemana.rows.map((x) => [x.semana, x.u]));
  const tendencia = sem[0] != null && sem[1] > 0 ? Math.round((sem[0] / sem[1] - 1) * 100) : null;
  const ultCompra = compras.rows[0], antCompra = compras.rows[1];
  const subaProveedor = ultCompra && antCompra && antCompra.precio > 0 ? r1((ultCompra.precio / antCompra.precio - 1) * 100) : null;

  // Frases: lo importante primero
  const frases = [];
  const uni = p.unidad === 'kg' ? 'kg' : (Math.abs(v.unidades - 1) < 0.001 ? 'unidad' : 'unidades');
  if (v.unidades > 0) frases.push(`En ${VENTANA} días vendiste ${d1(v.unidades)} ${uni} (${$(v.plata)}), unas ${d1(porDiaU * 7)}${p.unidad === 'kg' ? ' kg' : ''} por semana.`);
  else frases.push(`No se vendió en los últimos ${VENTANA} días.`);
  if (ganancia && ganancia.por_unidad < 0) frases.push(`Lo vendés por debajo de lo que te cuesta: perdés ${$(-ganancia.por_unidad)} por cada unidad (${$(-ganancia.mes)} en el mes). Revisá el precio o el costo cargado.`);
  else if (ganancia) frases.push(`Te deja ${$(ganancia.por_unidad)} por unidad (${d1(ganancia.pct)}%): en el mes, ${$(ganancia.mes)}.`);
  else frases.push('Cargá el costo para saber cuánto te deja.');
  if (diasStock != null) frases.push(diasStock <= 3 ? `Te quedan ${d1(p.stock)}: alcanzan para ${diasStock} ${diasStock === 1 ? 'día' : 'días'}. Pedí ya.` : diasStock > 90 ? `Te quedan ${d1(p.stock)}: tenés para más de 3 meses, no hace falta pedir.` : `Te quedan ${d1(p.stock)}: alcanzan para unos ${diasStock} días.`);
  if (subaProveedor != null && subaProveedor >= 3) frases.push(`${ultCompra.proveedor || 'El proveedor'} lo subió ${d1(subaProveedor)}% en la última compra.`);
  if (tendencia != null && Math.abs(tendencia) >= 20) frases.push(`Esta semana se vendió ${Math.abs(tendencia)}% ${tendencia > 0 ? 'más' : 'menos'} que la anterior.`);
  if (anul.rows[0].n > 0) frases.push(`Se anularon ${anul.rows[0].n} ${anul.rows[0].n === 1 ? 'venta' : 'ventas'} con este producto (${d1(anul.rows[0].u)} unidades).`);

  return {
    producto: p,
    frases,
    ventas: { unidades: r1(v.unidades), plata: Math.round(v.plata), tickets: v.tickets, dias_con_venta: v.dias_con_venta, ultima: v.ultima,
      por_semana: r1(porDiaU * 7), tendencia_pct: tendencia },
    cuando: { mejor_dia: mejorDia ? DIAS[mejorDia.dow] : null, hora_pico: porHora.rows[0] ? porHora.rows[0].h : null },
    ganancia: ganancia && { por_unidad: Math.round(ganancia.por_unidad), pct: ganancia.pct, mes: Math.round(ganancia.mes) },
    stock: { actual: p.stock, minimo: p.stock_minimo, alcanza_dias: diasStock, proxima_semana: r1(porDiaU * 7) },
    proveedor: { ultimas: compras.rows, suba_pct: subaProveedor },
    cambios_precio: cambios.rows,
    quien_lo_vende: porEmpleado.rows.map((x) => ({ empleado: x.empleado, unidades: r1(x.u), plata: Math.round(x.plata) })),
    anulaciones: { ventas: anul.rows[0].n, unidades: r1(anul.rows[0].u) },
  };
}

async function fichaEmpleado(negocioId, nombre, db = pool) {
  const [ventas, equipo, caja, hechos, hechosEquipo, ritmo] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(t.monto),0)::float AS plata,
                     GREATEST(COUNT(*) FILTER (WHERE t.tipo = 'venta') - COUNT(*) FILTER (WHERE t.tipo = 'anulacion'),0)::int AS ventas,
                     COUNT(DISTINCT t.turno_id)::int AS turnos,
                     GREATEST(COUNT(*) FILTER (WHERE t.tipo = 'venta' AND t.turno_id IS NOT NULL) - COUNT(*) FILTER (WHERE t.tipo = 'anulacion' AND t.turno_id IS NOT NULL),0)::int AS ventas_en_turno
                FROM transacciones t WHERE t.negocio_id = $1 AND t.empleado = $2 AND t.fecha >= NOW() - ($3::int * INTERVAL '1 day')`, [negocioId, nombre, VENTANA]),
    db.query(`SELECT t.empleado, SUM(t.monto)::float AS plata, COUNT(*) FILTER (WHERE t.tipo = 'venta')::int AS ventas, COUNT(DISTINCT t.turno_id)::int AS turnos
                FROM transacciones t WHERE t.negocio_id = $1 AND t.empleado IS NOT NULL AND t.fecha >= NOW() - ($2::int * INTERVAL '1 day')
               GROUP BY 1`, [negocioId, VENTANA]),
    db.query(`SELECT COUNT(*)::int AS cierres, COUNT(*) FILTER (WHERE ${CF.sqlFaltante()} > 0)::int AS con_faltante,
                     COALESCE(SUM(${CF.sqlFaltante()}),0)::float AS faltante,
                     COUNT(*) FILTER (WHERE COALESCE(conteo_aleatorio_omitido,false) OR COALESCE(conteo_aleatorio2_omitido,false))::int AS conteos_sin_responder
                FROM turnos_caja WHERE negocio_id = $1 AND nombre_empleado = $2 AND estado = 'cerrado'
                 AND hora_cierre >= NOW() - ($3::int * INTERVAL '1 day')`, [negocioId, nombre, VENTANA]),
    db.query(`SELECT tipo, COUNT(*)::int AS n, COALESCE(SUM(valor),0)::float AS plata
                FROM hechos_caja WHERE negocio_id = $1 AND empleado = $2 AND creado >= NOW() - ($3::int * INTERVAL '1 day') GROUP BY 1`, [negocioId, nombre, VENTANA]).catch(() => ({ rows: [] })),
    db.query(`SELECT empleado, tipo, COUNT(*)::int AS n FROM hechos_caja
               WHERE negocio_id = $1 AND empleado IS NOT NULL AND creado >= NOW() - ($2::int * INTERVAL '1 day') GROUP BY 1, 2`, [negocioId, VENTANA]).catch(() => ({ rows: [] })),
    // Ritmo: ventas por hora de turno (cuánto despacha)
    db.query(`SELECT SUM(EXTRACT(EPOCH FROM (hora_cierre - hora_apertura)) / 3600)::float AS horas
                FROM turnos_caja WHERE negocio_id = $1 AND nombre_empleado = $2 AND estado = 'cerrado'
                 AND hora_cierre >= NOW() - ($3::int * INTERVAL '1 day') AND hora_cierre > hora_apertura`, [negocioId, nombre, VENTANA]),
  ]);
  const v = ventas.rows[0];
  if (!v.turnos && !caja.rows[0].cierres) return null;

  const H = Object.fromEntries(hechos.rows.map((x) => [x.tipo, x]));
  const cuenta = (tipo) => (H[tipo] ? H[tipo].n : 0);
  const plataDe = (tipo) => (H[tipo] ? H[tipo].plata : 0);
  // Equipo: promedio por turno de cada cosa, para comparar
  const turnosDe = Object.fromEntries(equipo.rows.map((x) => [x.empleado, x.turnos || 1]));
  const porTurnoEquipo = (tipos) => {
    const otros = equipo.rows.filter((x) => x.empleado !== nombre).map((x) => {
      const n = hechosEquipo.rows.filter((h) => h.empleado === x.empleado && tipos.includes(h.tipo)).reduce((s, h) => s + h.n, 0);
      return n / (turnosDe[x.empleado] || 1);
    });
    return otros.length ? otros.reduce((a, b) => a + b, 0) / otros.length : null;
  };
  const c0 = caja.rows[0];
  v.turnos = Math.max(v.turnos, c0.cierres); // las ventas viejas cargadas a mano no tienen turno: se cuentan los cierres
  const turnos = v.turnos || 1;
  const horas = ritmo.rows[0].horas || 0;
  // Solo con suficientes ventas cobradas dentro de un turno (si no, el ritmo sale engañoso)
  const porHora = horas > 0 && v.ventas_en_turno >= 20 ? v.ventas_en_turno / horas : null;
  const otrosRitmo = equipo.rows.filter((x) => x.empleado !== nombre && x.turnos > 0);
  const ticket = v.ventas > 0 ? v.plata / v.ventas : 0;
  const ticketEquipo = (() => { const o = otrosRitmo.filter((x) => x.ventas > 0); return o.length ? o.reduce((s, x) => s + x.plata / x.ventas, 0) / o.length : null; })();
  const c = c0;

  const comparar = (mio, equipoVal) => (equipoVal == null || equipoVal === 0 ? null : Math.round((mio / equipoVal - 1) * 100));
  const senales = [];
  const vsAnul = comparar(cuenta('venta_anulada') / turnos, porTurnoEquipo(['venta_anulada']));
  const nadieMas = (tipos) => porTurnoEquipo(tipos) === 0;
  if (cuenta('venta_anulada') >= 2 && vsAnul != null && vsAnul >= 100) senales.push(`Anula ${vsAnul}% más ventas por turno que el resto del equipo.`);
  else if (cuenta('venta_anulada') >= 3 && nadieMas(['venta_anulada'])) senales.push(`Anuló ${cuenta('venta_anulada')} ventas (${$(plataDe('venta_anulada'))}); el resto del equipo, ninguna.`);
  const vsDesc = comparar(cuenta('descuento') / turnos, porTurnoEquipo(['descuento']));
  if (cuenta('descuento') >= 3 && vsDesc != null && vsDesc >= 100) senales.push(`Hace ${vsDesc}% más descuentos por turno que el resto.`);
  else if (cuenta('descuento') >= 3 && nadieMas(['descuento'])) senales.push(`Hizo ${cuenta('descuento')} descuentos (${$(plataDe('descuento'))}); el resto del equipo, ninguno.`);
  const sacados = cuenta('item_borrado') + cuenta('cantidad_reducida');
  const vsSac = comparar(sacados / turnos, porTurnoEquipo(['item_borrado', 'cantidad_reducida']));
  if (sacados >= 5 && vsSac != null && vsSac >= 100) senales.push(`Saca productos del carrito ${vsSac}% más que el resto.`);
  if (cuenta('espera_descartada') > 0) senales.push(`${cuenta('espera_descartada')} ${cuenta('espera_descartada') === 1 ? 'vez cerró' : 'veces cerró'} el turno con una venta en espera sin cobrar (${$(plataDe('espera_descartada'))}).`);
  if (c.con_faltante >= 2) senales.push(`${c.con_faltante} de ${c.cierres} cierres terminaron con plata de menos (${$(c.faltante)} en total).`);
  if (c.conteos_sin_responder > 0) senales.push(`No respondió ${c.conteos_sin_responder} ${c.conteos_sin_responder === 1 ? 'conteo' : 'conteos'} de caja a mitad de turno.`);

  const frases = [`En ${VENTANA} días vendió ${$(v.plata)} en ${v.ventas} ventas${v.turnos ? `, en ${v.turnos} ${v.turnos === 1 ? 'turno' : 'turnos'}` : ''}.`];
  if (porHora != null) frases.push(`Atiende unas ${d1(porHora)} ventas por hora de turno.`);
  if (ticketEquipo) {
    const d = comparar(ticket, ticketEquipo);
    if (d != null && Math.abs(d) >= 15) frases.push(`Cada cliente le gasta ${Math.abs(d)}% ${d > 0 ? 'más' : 'menos'} que con el resto del equipo (${$(ticket)} contra ${$(ticketEquipo)}).`);
  }
  if (!senales.length) frases.push(c.cierres ? `Sus ${c.cierres} cierres de caja están dentro de lo normal.` : 'Todavía no cerró turnos de caja.');

  const turnosRecientes = await turnosRecientesDe(negocioId, nombre, db).catch(() => []);
  return {
    empleado: nombre,
    turnos_recientes: turnosRecientes,
    frases,
    senales,
    ventas: { plata: Math.round(v.plata), ventas: v.ventas, turnos: v.turnos, gasto_por_cliente: Math.round(ticket), por_hora: porHora != null ? r1(porHora) : null },
    caja: { cierres: c.cierres, con_faltante: c.con_faltante, faltante: Math.round(c.faltante), conteos_sin_responder: c.conteos_sin_responder },
    acciones: {
      anulaciones: { n: cuenta('venta_anulada'), plata: Math.round(plataDe('venta_anulada')) },
      descuentos: { n: cuenta('descuento'), plata: Math.round(plataDe('descuento')) },
      sacados_del_carrito: { n: sacados, plata: Math.round(plataDe('item_borrado') + plataDe('cantidad_reducida')) },
      precios_cambiados: cuenta('precio_cambiado'),
      egresos: { n: cuenta('egreso'), plata: Math.round(plataDe('egreso')) },
      esperas_sin_cobrar: { n: cuenta('espera_descartada'), plata: Math.round(plataDe('espera_descartada')) },
    },
  };
}

// Lo que guarda cada hecho de caja, dicho en criollo
function detalleHecho(h) {
  const d = h.detalle || {};
  const m = d.motivo ? `motivo: ${d.motivo}` : null;
  if (h.tipo === 'descuento') return [d.pct ? `${d.pct}%` : null, d.subtotal ? `sobre ${$(d.subtotal)}` : null, m].filter(Boolean).join(' · ') || null;
  if (h.tipo === 'venta_anulada') return [d.metodo_pago ? `se había cobrado ${d.metodo_pago === 'mixto' ? 'con dos medios' : d.metodo_pago}` : null, m].filter(Boolean).join(' · ') || null;
  if (h.tipo === 'espera_descartada') return d.lineas ? `${d.lineas} ${d.lineas === 1 ? 'producto' : 'productos'} en el carrito` : null;
  if (h.tipo === 'item_borrado' && d.precio_unitario) return `a ${$(d.precio_unitario)} c/u`;
  if (h.tipo === 'precio_cambiado' && (d.antes != null || d.despues != null)) return `de ${$(d.antes)} a ${$(d.despues)}`;
  return m;
}

// ── Turno: la cuenta de la caja paso a paso y cada venta que la compone ──
async function fichaTurno(negocioId, turnoId, db = pool) {
  await require('./caja_extra').asegurar(db).catch(() => {});
  const t = (await db.query(
    `SELECT tc.*, s.nombre AS local_nombre,
            to_char(tc.hora_apertura - INTERVAL '3 hours','DD/MM HH24:MI') AS abre, to_char(tc.hora_cierre - INTERVAL '3 hours','DD/MM HH24:MI') AS cierra,
            EXTRACT(EPOCH FROM (COALESCE(tc.hora_cierre, NOW()) - tc.hora_apertura)) / 3600 AS horas
       FROM turnos_caja tc LEFT JOIN mis_sucursales s ON s.id = tc.sucursal_id AND s.negocio_id = tc.negocio_id
      WHERE tc.id = $1 AND tc.negocio_id = $2`, [turnoId, negocioId])).rows[0];
  if (!t) return null;

  // Las ventas de ESTE turno: la misma regla que usa la cuenta de la caja (ventas_turno.js)
  const filtro = `t.negocio_id = $1 AND (t.turno_id = $2 OR (t.turno_id IS NULL AND t.empleado = $3 AND t.fecha >= $4 AND t.fecha <= COALESCE($5, NOW()) AND t.sucursal_id IS NOT DISTINCT FROM $6::integer))`;
  const args = [negocioId, t.id, t.nombre_empleado, t.hora_apertura, t.hora_cierre || null, t.sucursal_id || null];
  const [v, ventas, items, egresos, conteos, hechos] = await Promise.all([
    require('./ventas_turno').ventasDelTurno(db, t),
    db.query(`SELECT t.id, t.monto::float AS monto, t.tipo, t.metodo_pago, t.monto_efectivo::float AS monto_efectivo, t.anula_id, t.motivo,
                     to_char(t.fecha - INTERVAL '3 hours','HH24:MI') AS hora
                FROM transacciones t WHERE ${filtro} ORDER BY t.fecha DESC, t.id DESC LIMIT 300`, args),
    db.query(`SELECT d.transaccion_id, d.producto_id, COALESCE(d.producto_nombre, p.nombre, 'Producto') AS nombre, d.cantidad::float AS cantidad,
                     d.subtotal::float AS subtotal, d.tipo_linea
                FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id LEFT JOIN productos p ON p.id = d.producto_id
               WHERE ${filtro} ORDER BY d.id`, args),
    db.query(`SELECT monto::float AS monto, motivo, to_char(hora - INTERVAL '3 hours','HH24:MI') AS hora FROM egresos_caja WHERE turno_id = $1 AND negocio_id = $2 ORDER BY hora`, [t.id, negocioId]),
    db.query(`SELECT tipo, monto_declarado::float AS monto, numero_conteo, to_char(hora - INTERVAL '3 hours','HH24:MI') AS hora FROM conteos_caja WHERE turno_id = $1 AND negocio_id = $2 ORDER BY hora`, [t.id, negocioId]).catch(() => ({ rows: [] })),
    db.query(`SELECT tipo, producto_id, producto_nombre, cantidad::float AS cantidad, valor::float AS valor, detalle, to_char(creado - INTERVAL '3 hours','HH24:MI') AS hora
                FROM hechos_caja WHERE negocio_id = $1 AND turno_id = $2 ORDER BY creado`, [negocioId, t.id]).catch(() => ({ rows: [] })),
  ]);

  const avisosTurno = (await db.query(`SELECT id, titulo, cuerpo, feedback, to_char(creado - INTERVAL '3 hours','HH24:MI') AS hora FROM alertas_instante WHERE negocio_id = $1 AND turno_id = $2 ORDER BY id`, [negocioId, t.id]).catch(() => ({ rows: [] }))).rows;
  const egr = egresos.rows.reduce((s, e) => s + e.monto, 0);
  const apertura = Number(t.caja_apertura) || 0;
  const efectivoVentas = v.total_ventas - v.total_mp;
  const esperado = apertura + efectivoVentas - egr;
  const cerrado = t.estado === 'cerrado' && t.caja_cierre != null;
  const contado = cerrado ? Number(t.caja_cierre) : null;
  const diferencia = cerrado ? contado - esperado : null; // + sobra / − falta
  const falta = cerrado ? CF.faltanteTurno(t) : 0; // la misma regla y el mismo número que Inicio y Equipo

  const porVenta = {};
  for (const it of items.rows) (porVenta[it.transaccion_id] = porVenta[it.transaccion_id] || []).push(it);
  const anuladas = new Set(ventas.rows.filter((x) => x.anula_id).map((x) => x.anula_id));
  const lista = ventas.rows.map((x) => ({ ...x, anulada: anuladas.has(x.id), items: (porVenta[x.id] || []).map((i) => ({ producto_id: i.producto_id, nombre: i.nombre, cantidad: r1(i.cantidad), subtotal: Math.round(i.subtotal), tipo_linea: i.tipo_linea })) }));

  // Lo más vendido del turno
  const top = {};
  for (const it of items.rows) if (it.producto_id) { const k = it.producto_id; top[k] = top[k] || { producto_id: k, nombre: it.nombre, cantidad: 0, plata: 0 }; top[k].cantidad += it.cantidad; top[k].plata += it.subtotal; }
  const masVendidos = Object.values(top).filter((x) => x.cantidad > 0).sort((a, b) => b.plata - a.plata).slice(0, 5).map((x) => ({ ...x, cantidad: r1(x.cantidad), plata: Math.round(x.plata) }));

  const H = {}; for (const h of hechos.rows) { H[h.tipo] = H[h.tipo] || { n: 0, plata: 0 }; H[h.tipo].n++; H[h.tipo].plata += h.valor || 0; }
  const senales = [];
  if (falta > 0) senales.push(`Cerró con ${$(falta)} de menos en el cajón.`);
  if (H.venta_anulada) senales.push(`${H.venta_anulada.n} ${H.venta_anulada.n === 1 ? 'venta anulada' : 'ventas anuladas'} (${$(H.venta_anulada.plata)}).`);
  if (H.descuento) senales.push(`${H.descuento.n} ${H.descuento.n === 1 ? 'descuento' : 'descuentos'} (${$(H.descuento.plata)}).`);
  const sac = (H.item_borrado ? H.item_borrado.n : 0) + (H.cantidad_reducida ? H.cantidad_reducida.n : 0);
  if (sac >= 3) senales.push(`Sacó ${sac} veces productos del carrito antes de cobrar.`);
  if (H.espera_descartada) senales.push(`Cerró con ${H.espera_descartada.n === 1 ? 'una venta' : H.espera_descartada.n + ' ventas'} en espera sin cobrar (${$(H.espera_descartada.plata)}).`);
  if (t.conteo_aleatorio_omitido || t.conteo_aleatorio2_omitido) senales.push('No respondió el conteo de caja a mitad de turno.');

  const frases = [];
  frases.push(`${t.nombre_empleado || 'Sin nombre'}, turno ${t.tipo_turno || ''}${t.local_nombre ? ' en ' + t.local_nombre : ''}: ${t.abre}${t.cierra ? ' a ' + t.cierra.slice(-5) : ' (sigue abierto)'}.`.replace('turno :', 'turno:'));
  frases.push(`Vendió ${$(v.total_ventas)} en ${v.cantidad_tx} ${v.cantidad_tx === 1 ? 'venta' : 'ventas'}; ${$(efectivoVentas)} en efectivo.`);
  if (cerrado) frases.push(falta > 0 ? `En el cajón tenía que haber ${$(esperado)} y contó ${$(contado)}: faltan ${$(esperado - contado)}.`
    : diferencia > 0 && Math.abs(diferencia) >= 1 ? `En el cajón tenía que haber ${$(esperado)} y contó ${$(contado)}: sobran ${$(diferencia)}.`
    : `En el cajón tenía que haber ${$(esperado)} y contó ${$(contado)}: la caja cerró bien.`);
  else frases.push(`Ahora en el cajón tendría que haber ${$(esperado)}.`);

  return {
    turno: { id: t.id, empleado: t.nombre_empleado, tipo: t.tipo_turno, estado: t.estado, abre: t.abre, cierra: t.cierra, horas: r1(t.horas),
      local: t.local_nombre, sucursal_id: t.sucursal_id },
    frases, senales,
    cuenta: [
      { paso: 'Abrió la caja con', monto: Math.round(apertura), signo: '' },
      { paso: 'Ventas en efectivo', monto: Math.round(efectivoVentas), signo: '+' },
      { paso: 'Plata que sacó de la caja (gastos)', monto: Math.round(egr), signo: '−' },
      { paso: cerrado ? 'Tenía que haber' : 'Tendría que haber ahora', monto: Math.round(esperado), signo: '=' , total: true },
      ...(cerrado ? [{ paso: 'Contó al cerrar', monto: Math.round(contado), signo: '' }, { paso: Math.abs(diferencia) < 1 ? 'Diferencia' : diferencia < 0 ? 'Faltan' : 'Sobran', monto: Math.round(Math.abs(diferencia)), signo: '', resultado: true, falta: falta > 0, nota: falta > 0 || Math.abs(diferencia) < 1 ? null : 'Dentro de lo normal (menos de ' + $(Math.max(CF.TOLERANCIA_MIN, esperado * CF.TOLERANCIA_PCT)) + ')' }] : []),
    ],
    totales: { ventas: Math.round(v.total_ventas), efectivo: Math.round(efectivoVentas), digital: Math.round(v.total_mp), cantidad: v.cantidad_tx, egresos: Math.round(egr) },
    ventas: lista,
    mas_vendidos: masVendidos,
    egresos: egresos.rows,
    conteos: conteos.rows,
    hechos: hechos.rows.map((h) => ({ ...h, detalle: detalleHecho(h) })),
    avisos: avisosTurno,
  };
}

// ── Proveedor: qué le comprás, cuánto, y cuánto te subió ──
async function fichaProveedor(negocioId, nombre, db = pool) {
  const compras = (await db.query(
    `SELECT c.id, c.proveedor, c.fecha::text AS fecha, c.total::float AS total, c.numero, c.proveedor_cuit
       FROM compras c WHERE c.negocio_id = $1 AND LOWER(TRIM(c.proveedor)) = LOWER(TRIM($2)) ORDER BY c.fecha DESC, c.id DESC LIMIT 60`, [negocioId, nombre]).catch(() => ({ rows: [] }))).rows;
  if (!compras.length) return null;
  const items = (await db.query(
    `SELECT i.compra_id, i.producto_id, COALESCE(p.nombre, i.descripcion) AS nombre, i.cantidad::float AS cantidad, i.precio_unitario::float AS precio, c.fecha::text AS fecha
       FROM compras_items i JOIN compras c ON c.id = i.compra_id LEFT JOIN productos p ON p.id = i.producto_id AND p.negocio_id = c.negocio_id
      WHERE c.negocio_id = $1 AND LOWER(TRIM(c.proveedor)) = LOWER(TRIM($2)) AND i.precio_unitario > 0
      ORDER BY c.fecha ASC, c.id ASC`, [negocioId, nombre])).rows;

  const hoy = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const hace = (d) => { const x = new Date(hoy); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); };
  const mes = compras.filter((c) => c.fecha >= hace(30)).reduce((s, c) => s + (c.total || 0), 0);
  const total90 = compras.filter((c) => c.fecha >= hace(90)).reduce((s, c) => s + (c.total || 0), 0);

  // Por producto: primer y último precio → suba
  const porProd = {};
  for (const i of items) {
    const k = i.producto_id ? 'p' + i.producto_id : 'd' + String(i.nombre).toLowerCase();
    const x = (porProd[k] = porProd[k] || { producto_id: i.producto_id, nombre: i.nombre, compras: 0, unidades: 0, precios: [] });
    x.compras++; x.unidades += i.cantidad || 0; x.precios.push({ fecha: i.fecha, precio: i.precio });
  }
  const productos = Object.values(porProd).map((x) => {
    const ult = x.precios[x.precios.length - 1], ant = x.precios.length > 1 ? x.precios[x.precios.length - 2] : null, pri = x.precios[0];
    return { producto_id: x.producto_id, nombre: x.nombre, compras: x.compras, unidades: r1(x.unidades), precio_actual: Math.round(ult.precio), ultima: ult.fecha,
      suba_por_unidad: ant ? Math.round(ult.precio - ant.precio) : null,
      suba_ultima_pct: ant && ant.precio > 0 ? r1((ult.precio / ant.precio - 1) * 100) : null,
      suba_total_pct: x.precios.length > 1 && pri.precio > 0 ? r1((ult.precio / pri.precio - 1) * 100) : null, desde: pri.fecha };
  }).sort((a, b) => b.compras - a.compras);
  const subieron = productos.filter((p) => p.suba_ultima_pct != null && p.suba_ultima_pct >= 3).sort((a, b) => b.suba_ultima_pct - a.suba_ultima_pct);
  // Cuánto te come la suba en un mes si no tocás tu precio de venta (unidades vendidas en 30 días × lo que subió)
  const ids = subieron.filter((p) => p.producto_id).map((p) => p.producto_id);
  if (ids.length) {
    const vend = Object.fromEntries((await db.query(
      `SELECT d.producto_id, SUM(d.cantidad)::float AS u FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
        WHERE t.negocio_id = $1 AND d.producto_id = ANY($2::int[]) AND t.fecha >= NOW() - INTERVAL '30 days' GROUP BY 1`, [negocioId, ids])).rows.map((x) => [x.producto_id, x.u]));
    for (const p of subieron) p.te_come_mes = p.producto_id && vend[p.producto_id] > 0 ? Math.round(vend[p.producto_id] * p.suba_por_unidad) : 0;
  }
  const comeMes = subieron.reduce((s2, p) => s2 + (p.te_come_mes || 0), 0);

  // Cada cuánto le comprás
  const fechas = [...new Set(compras.map((c) => c.fecha))].sort();
  let cada = null;
  if (fechas.length >= 3) { const d = []; for (let i = 1; i < fechas.length; i++) d.push((new Date(fechas[i]) - new Date(fechas[i - 1])) / 864e5); d.sort((a, b) => a - b); cada = Math.round(d[Math.floor(d.length / 2)]); }

  const frases = [];
  frases.push(`Le compraste ${compras.length} ${compras.length === 1 ? 'vez' : 'veces'}${cada ? `, más o menos cada ${cada} ${cada === 1 ? 'día' : 'días'}` : ''}. Última compra: ${compras[0].fecha.split('-').reverse().join('/')}.`);
  if (mes > 0) frases.push(`En los últimos 30 días le compraste ${$(mes)}.`);
  if (subieron.length) frases.push(`En la última compra te subió ${subieron.length} ${subieron.length === 1 ? 'producto' : 'productos'}: ${subieron.slice(0, 3).map((p) => `${p.nombre} ${d1(p.suba_ultima_pct)}%`).join(', ')}.`);
  else if (productos.some((p) => p.suba_ultima_pct != null)) frases.push('En la última compra no te subió precios.');
  if (comeMes > 0) frases.push(`Si no cambiás tus precios de venta, esas subas te sacan unos ${$(comeMes)} de ganancia por mes.`);

  return {
    proveedor: compras[0].proveedor || nombre, cuit: compras.find((c) => c.proveedor_cuit)?.proveedor_cuit || null,
    frases,
    resumen: { te_come_mes: comeMes, compras: compras.length, ultimos_30: Math.round(mes), ultimos_90: Math.round(total90), cada_dias: cada, productos: productos.length },
    subieron, productos: productos.slice(0, 40),
    compras: compras.slice(0, 15).map((c) => ({ ...c, total: Math.round(c.total || 0) })),
  };
}

// Turnos recientes de una persona (para tirar del hilo desde su ficha)
async function turnosRecientesDe(negocioId, nombre, db = pool) {
  return (await db.query(
    `SELECT id, tipo_turno, estado, to_char(hora_apertura - INTERVAL '3 hours','DD/MM HH24:MI') AS abre,
            CASE WHEN estado = 'cerrado' THEN ${CF.sqlFaltante()} ELSE 0 END::float AS faltante
       FROM turnos_caja WHERE negocio_id = $1 AND nombre_empleado = $2 ORDER BY hora_apertura DESC LIMIT 10`, [negocioId, nombre])).rows
    .map((x) => ({ ...x, faltante: Math.round(x.faltante || 0) }));
}

module.exports = { fichaProducto, fichaEmpleado, fichaTurno, fichaProveedor, turnosRecientesDe };
