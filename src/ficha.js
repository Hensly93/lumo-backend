// ficha.js — la ficha de cada cosa del negocio, con todo conectado (Palantir, 14/11/2026).
//   · Producto: cuánto se vende y cuándo, cuánto deja, stock y para cuántos días alcanza, subas del proveedor,
//     cambios de precio (quién y cuándo), quién lo vende, anulaciones y lo que se espera vender.
//   · Empleado: cuánto vende y a qué ritmo, cómo cierra la caja, anulaciones, descuentos, productos sacados
//     del carrito y ventas en espera sin cobrar, comparado con el resto del equipo.
// Todo sale de la base (30 días) y cada número viene con su frase en criollo. Nada se inventa.
const pool = require('./db');
const CF = require('./caja_faltante');

const FL = `(t.fecha - INTERVAL '3 hours')`;
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
  if (v.unidades > 0) frases.push(`En ${VENTANA} días vendiste ${d1(v.unidades)} ${p.unidad === 'kg' ? 'kg' : 'unidades'} (${$(v.plata)}), unas ${d1(porDiaU * 7)} ${p.unidad === 'kg' ? 'kg' : ''} por semana.`.replace('  ', ' '));
  else frases.push(`No se vendió en los últimos ${VENTANA} días.`);
  if (ganancia) frases.push(`Te deja ${$(ganancia.por_unidad)} por unidad (${ganancia.pct}%): en el mes, ${$(ganancia.mes)}.`);
  else frases.push('Cargá el costo para saber cuánto te deja.');
  if (diasStock != null) frases.push(diasStock <= 3 ? `Te quedan ${d1(p.stock)}: alcanzan para ${diasStock} ${diasStock === 1 ? 'día' : 'días'}. Pedí ya.` : diasStock > 90 ? `Te quedan ${d1(p.stock)}: tenés para más de 3 meses, no hace falta pedir.` : `Te quedan ${d1(p.stock)}: alcanzan para unos ${diasStock} días.`);
  if (subaProveedor != null && subaProveedor >= 3) frases.push(`${ultCompra.proveedor || 'El proveedor'} lo subió ${subaProveedor}% en la última compra.${ganancia ? '' : ''}`);
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

  return {
    empleado: nombre,
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

module.exports = { fichaProducto, fichaEmpleado };
