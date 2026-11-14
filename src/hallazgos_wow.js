// hallazgos_wow.js — LumoBi · wow moment v3 (14/11/2026)
//
// Lo que el dueño NO sabía de su negocio, en plata, con evidencia. Cada hallazgo sale de sus datos
// (ventas, productos vendidos, cierres de caja, turnos) — nada de estadísticas genéricas.
//
//   combo_natural       dos productos que se compran juntos mucho más que por azar → combo
//   margen_estrella     lo que más vende te deja poco margen y otro producto te deja mucho más
//   falta_stock         un producto que se vendía todos los días dejó de venderse → probable falta
//   diferencias_caja    lo que suman las diferencias de caja y a cuánto llega en el mes
//   ticket_empleado     con quién atiende, el ticket promedio cambia (hechos, sin acusar)
//   hora_muerta         horas con caja abierta que casi no venden, contra la hora pico
//   concentracion_pico  qué parte de la plata entra en 2 horas
//
// Formato de cada hallazgo (el mismo que ya dibuja el Home):
//   { id, icono, titulo, descripcion, duele, recomendacion, advertencia, impacto_pesos, confianza, detalle }

const pool = require('./db');

const FL = `(t.fecha - INTERVAL '3 hours')`;
const HOY = `(NOW() - INTERVAL '3 hours')::date`;
const REAL = `COALESCE(t.origin,'real') IN ('real','importado')`;
const $ = (n) => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('es-AR');
const pct = (x) => Math.round((Number(x) || 0) * 100);
const VENTANA = 30;

function aviso(dias) {
  return dias >= 14 ? `Calculado con tus últimos ${dias} días.` : `Lectura con ${dias} día${dias === 1 ? '' : 's'} de datos: se afina sola con cada turno.`;
}

async function diasConVentas(db, negocioId) {
  const r = await db.query(
    `SELECT COUNT(DISTINCT ${FL}::date)::int d FROM transacciones t
     WHERE t.negocio_id=$1 AND ${REAL} AND ${FL}::date >= ${HOY} - ${VENTANA}`, [negocioId]);
  return r.rows[0].d;
}

// ─── Detectores ───────────────────────────────────────────────────────────────

async function comboNatural(db, negocioId, dias) {
  const r = await db.query(
    `WITH items AS (
       SELECT DISTINCT d.transaccion_id tx, COALESCE(d.producto_nombre, p.nombre) nombre
       FROM transacciones_detalle d JOIN transacciones t ON t.id=d.transaccion_id
       LEFT JOIN productos p ON p.id = d.producto_id
       WHERE t.negocio_id=$1 AND ${REAL} AND ${FL}::date >= ${HOY} - ${VENTANA}
     ), tot AS (SELECT COUNT(DISTINCT tx)::float n FROM items),
     solo AS (SELECT nombre, COUNT(*)::float n FROM items GROUP BY nombre),
     pares AS (
       SELECT a.nombre a, b.nombre b, COUNT(*)::float n
       FROM items a JOIN items b ON a.tx=b.tx AND a.nombre < b.nombre GROUP BY 1,2)
     SELECT * FROM (
       SELECT p.a, p.b, p.n juntos, sa.n na, sb.n nb, tot.n total,
              (p.n / tot.n) / ((sa.n / tot.n) * (sb.n / tot.n)) lift
       FROM pares p JOIN solo sa ON sa.nombre=p.a JOIN solo sb ON sb.nombre=p.b, tot
       WHERE p.n >= 5) q
     ORDER BY lift * juntos DESC LIMIT 1`, [negocioId]);
  const x = r.rows[0];
  if (!x || x.lift < 1.5) return null;
  // El producto "ancla" es el que más se vende; el otro es el que se suma
  const [ancla, suma, nAncla] = x.na >= x.nb ? [x.a, x.b, x.na] : [x.b, x.a, x.nb];
  const conSuma = x.juntos / nAncla;
  const precio = await db.query(
    `SELECT AVG(d.precio_unitario)::float p FROM transacciones_detalle d JOIN transacciones t ON t.id=d.transaccion_id
     WHERE t.negocio_id=$1 AND COALESCE(d.producto_nombre,'')=$2`, [negocioId, suma]);
  const precioSuma = precio.rows[0].p || 0;
  // Si 1 de cada 5 que hoy se llevan solo el ancla suma el otro, por mes:
  const sinSumaMes = ((nAncla - x.juntos) / Math.max(dias, 1)) * 30;
  const impacto = Math.round(sinSumaMes * 0.2 * precioSuma);
  if (impacto < 1000) return null;
  return {
    id: 'combo_natural', icono: '',
    titulo: `${pct(conSuma)}% de los que compran ${ancla} se llevan también ${suma}`,
    descripcion: `Pasó en ${Math.round(x.juntos)} ventas: es ${x.lift.toFixed(1)} veces más de lo que daría el azar. Tus clientes ya arman ese combo solos.`,
    duele: `El resto se lleva solo ${ancla}: ahí hay plata que no estás cobrando.`,
    recomendacion: `Ofrecé ${ancla} + ${suma} como combo (o poné ${suma} al lado de ${ancla}). Si 1 de cada 5 lo suma, son unos ${$(impacto)} más por mes.`,
    advertencia: aviso(dias), impacto_pesos: impacto, confianza: Math.min(90, 40 + Math.round(x.juntos)),
    detalle: { ancla, suma, juntos: x.juntos, lift: Math.round(x.lift * 10) / 10 },
  };
}

async function margenEstrella(db, negocioId, dias) {
  const r = await db.query(
    `SELECT COALESCE(d.producto_nombre, p.nombre) nombre, SUM(d.subtotal)::float venta,
            SUM(d.subtotal - d.costo_unitario * d.cantidad)::float ganancia, SUM(d.cantidad)::float unidades
     FROM transacciones_detalle d JOIN transacciones t ON t.id=d.transaccion_id LEFT JOIN productos p ON p.id=d.producto_id
     WHERE t.negocio_id=$1 AND ${REAL} AND ${FL}::date >= ${HOY} - ${VENTANA} AND d.costo_unitario > 0
     GROUP BY 1 HAVING SUM(d.subtotal) > 0 ORDER BY 2 DESC`, [negocioId]);
  if (r.rows.length < 3) return null;
  const total = r.rows.reduce((a, b) => a + b.venta, 0);
  const top = r.rows[0];
  const mTop = top.ganancia / top.venta;
  const share = top.venta / total;
  const alto = r.rows.filter((x) => x.venta >= total * 0.03).map((x) => ({ ...x, m: x.ganancia / x.venta })).sort((a, b) => b.m - a.m)[0];
  if (!alto || alto.nombre === top.nombre || share < 0.25 || alto.m - mTop < 0.15) return null;
  // Si el 10% de lo que hoy va al producto estrella se moviera al de mejor margen, por mes:
  const impacto = Math.round(((top.venta * 0.1) / Math.max(dias, 1)) * 30 * (alto.m - mTop));
  if (impacto < 1000) return null;
  return {
    id: 'margen_estrella', icono: '',
    titulo: `${top.nombre} es el ${pct(share)}% de lo que vendés, pero te deja solo ${pct(mTop)}% de ganancia`,
    descripcion: `En cambio ${alto.nombre} te deja ${pct(alto.m)}% de cada venta. Vender mucho no es lo mismo que ganar mucho.`,
    duele: `Cada $1.000 de ${top.nombre} te dejan ${$(mTop * 1000)}; los de ${alto.nombre}, ${$(alto.m * 1000)}.`,
    recomendacion: `Mostrá y ofrecé más ${alto.nombre}. Si una de cada diez ventas se mueve hacia ahí, ganás unos ${$(impacto)} más por mes vendiendo lo mismo.`,
    advertencia: aviso(dias) + ' Usa el costo cargado en tu catálogo.', impacto_pesos: impacto, confianza: 80,
    detalle: { estrella: top.nombre, margen_estrella: pct(mTop), mejor: alto.nombre, margen_mejor: pct(alto.m) },
  };
}

async function faltaStock(db, negocioId) {
  const r = await db.query(
    `WITH x AS (
       SELECT COALESCE(d.producto_nombre, p.nombre) nombre, ${FL}::date dia, SUM(d.subtotal)::float venta
       FROM transacciones_detalle d JOIN transacciones t ON t.id=d.transaccion_id LEFT JOIN productos p ON p.id=d.producto_id
       WHERE t.negocio_id=$1 AND ${REAL} AND ${FL}::date >= ${HOY} - 21 AND ${FL}::date < ${HOY}
       GROUP BY 1,2),
     negocio AS (SELECT COUNT(DISTINCT ${FL}::date)::int d FROM transacciones t
                 WHERE t.negocio_id=$1 AND ${FL}::date >= ${HOY} - 2 AND ${FL}::date < ${HOY})
     SELECT nombre, COUNT(*)::int dias, AVG(venta)::float prom_dia, to_char(MAX(dia),'DD/MM') ultimo, (SELECT d FROM negocio) abiertos
     FROM x GROUP BY nombre
     HAVING COUNT(*) >= 5 AND MAX(dia) <= ${HOY} - 3
     ORDER BY AVG(venta) DESC LIMIT 1`, [negocioId]);
  const x = r.rows[0];
  if (!x || x.abiertos < 2) return null; // el negocio vendió los últimos 2 días, el producto no
  const impacto = Math.round(x.prom_dia * 30);
  return {
    id: 'falta_stock', icono: '',
    titulo: `${x.nombre} se vendía casi todos los días y hace días que no se vende`,
    descripcion: `Se vendió ${x.dias} días, unos ${$(x.prom_dia)} por día. La última venta fue el ${x.ultimo}, y el local siguió vendiendo otras cosas.`,
    duele: `Si es falta de stock, cada día sin ${x.nombre} son ${$(x.prom_dia)} que no entran.`,
    recomendacion: `Fijate si hay ${x.nombre} en el local. Si no hay, reponelo: por mes son unos ${$(impacto)}.`,
    advertencia: 'Calculado con los productos que se cobran en la caja de LumoBi.', impacto_pesos: impacto, confianza: 75,
    detalle: { producto: x.nombre, dias_vendido: x.dias, promedio_dia: Math.round(x.prom_dia) },
  };
}

async function diferenciasCaja(db, negocioId) {
  const r = await db.query(
    `SELECT COUNT(*)::int turnos, COUNT(*) FILTER (WHERE ABS(brecha) >= 200)::int con_dif,
            COALESCE(SUM(GREATEST(brecha,0)),0)::float faltante,
            COUNT(DISTINCT (hora_apertura - INTERVAL '3 hours')::date)::int dias
     FROM turnos_caja WHERE negocio_id=$1 AND estado='cerrado' AND brecha IS NOT NULL
       AND hora_apertura >= NOW() - INTERVAL '${VENTANA} days'`, [negocioId]);
  const x = r.rows[0];
  if (!x.turnos || x.faltante < 1000 || x.con_dif < 2) return null;
  const mes = Math.round((x.faltante / Math.max(x.dias, 1)) * 30);
  return {
    id: 'diferencias_caja', icono: '',
    titulo: `Faltaron ${$(x.faltante)} en la caja en ${x.dias} día${x.dias === 1 ? '' : 's'}`,
    descripcion: `${x.con_dif} de ${x.turnos} cierres no cuadraron con lo vendido.`,
    duele: `A este ritmo son unos ${$(mes)} por mes que se van sin que nadie lo vea.`,
    recomendacion: 'Revisá cada cierre con diferencia el mismo día: egresos sin cargar, vueltos mal dados o ventas sin registrar. En Equipo ves cada turno.',
    advertencia: 'Suma real de las diferencias de tus cierres de caja.', impacto_pesos: mes, confianza: 90,
    detalle: { turnos: x.turnos, con_diferencia: x.con_dif, faltante: Math.round(x.faltante) },
  };
}

async function ticketEmpleado(db, negocioId, dias) {
  const r = await db.query(
    `SELECT t.empleado, COUNT(*)::int n, AVG(t.monto)::float ticket, COUNT(DISTINCT t.turno_id)::int turnos
     FROM transacciones t
     WHERE t.negocio_id=$1 AND ${REAL} AND t.empleado IS NOT NULL AND t.empleado NOT IN ('importado_mp','importado')
       AND ${FL}::date >= ${HOY} - ${VENTANA}
     GROUP BY 1 HAVING COUNT(*) >= 30 ORDER BY 3 DESC`, [negocioId]);
  if (r.rows.length < 2) return null;
  const alto = r.rows[0], bajo = r.rows[r.rows.length - 1];
  const dif = alto.ticket / bajo.ticket - 1;
  if (dif < 0.15) return null;
  const ventasBajoMes = (bajo.n / Math.max(dias, 1)) * 30;
  const impacto = Math.round(ventasBajoMes * (alto.ticket - bajo.ticket) * 0.3);
  return {
    id: 'ticket_empleado', icono: '',
    titulo: `Cuando atiende ${alto.empleado}, cada venta es ${pct(dif)}% más alta que con ${bajo.empleado}`,
    descripcion: `Ticket promedio: ${alto.empleado} ${$(alto.ticket)} · ${bajo.empleado} ${$(bajo.ticket)} (${alto.n} y ${bajo.n} ventas).`,
    duele: 'Puede ser el horario o el tipo de cliente, pero también cómo se ofrece en la caja.',
    recomendacion: `Mirá qué hace distinto ${alto.empleado} al cobrar (ofrecer algo más, el combo) y compartilo con el equipo. Si se achica un tercio de la diferencia, son unos ${$(impacto)} más por mes.`,
    advertencia: aviso(dias) + ' Son hechos de las ventas, no una evaluación de la persona.', impacto_pesos: impacto, confianza: 70,
    detalle: { alto: alto.empleado, bajo: bajo.empleado, ticket_alto: Math.round(alto.ticket), ticket_bajo: Math.round(bajo.ticket) },
  };
}

async function horaMuerta(db, negocioId, dias) {
  const r = await db.query(
    `SELECT EXTRACT(HOUR FROM ${FL})::int h, SUM(t.monto)::float total, COUNT(DISTINCT ${FL}::date)::int dias_h
     FROM transacciones t WHERE t.negocio_id=$1 AND ${REAL} AND ${FL}::date >= ${HOY} - ${VENTANA}
     GROUP BY 1 ORDER BY 1`, [negocioId]);
  const hs = r.rows.filter((x) => x.dias_h >= Math.max(2, dias * 0.5));
  if (hs.length < 5) return null;
  const pico = hs.reduce((a, b) => (b.total > a.total ? b : a));
  const muertas = hs.filter((x) => x.total < pico.total * 0.2);
  if (!muertas.length) return null;
  const ventaMuertasDia = muertas.reduce((a, b) => a + b.total, 0) / Math.max(dias, 1);
  const lista = muertas.map((x) => x.h).sort((a, b) => a - b);
  const texto = lista.length > 3 ? `${lista.length} horas del día` : lista.map((h) => `${h} a ${h + 1} h`).join(', ');
  return {
    id: 'hora_muerta', icono: '',
    titulo: `De ${texto} vendés menos de la quinta parte que en tu hora pico (${pico.h} a ${pico.h + 1} h)`,
    descripcion: `En esas horas entran en total unos ${$(ventaMuertasDia)} por día, con la caja abierta y alguien atendiendo.`,
    duele: 'Pagar horas de atención que casi no venden es plata que se va en sueldo y luz.',
    recomendacion: 'Usá esas horas para reponer y ordenar, armá una promo solo para esa franja o reorganizá los horarios del equipo hacia el pico.',
    advertencia: aviso(dias), impacto_pesos: 0, confianza: Math.min(85, 40 + dias * 3),
    detalle: { horas: lista, hora_pico: pico.h },
  };
}

async function concentracionPico(db, negocioId, dias) {
  const r = await db.query(
    `SELECT EXTRACT(HOUR FROM ${FL})::int h, SUM(t.monto)::float total
     FROM transacciones t WHERE t.negocio_id=$1 AND ${REAL} AND ${FL}::date >= ${HOY} - ${VENTANA}
     GROUP BY 1 ORDER BY 2 DESC`, [negocioId]);
  if (r.rows.length < 4) return null;
  const total = r.rows.reduce((a, b) => a + b.total, 0);
  const top = r.rows.slice(0, 2);
  const share = (top[0].total + top[1].total) / total;
  if (share < 0.35) return null;
  const hs = top.map((x) => x.h).sort((a, b) => a - b);
  const franja = hs[1] === hs[0] + 1 ? `las ${hs[0]} y las ${hs[1] + 1}` : `las ${hs[0]} y las ${hs[1]} h`;
  const porDia = (top[0].total + top[1].total) / Math.max(dias, 1);
  return {
    id: 'concentracion_pico', icono: '',
    titulo: `El ${pct(share)}% de tu plata entra entre ${franja}`,
    descripcion: `Son unos ${$(porDia)} por día concentrados en dos horas.`,
    duele: 'Si en ese momento falta cambio, mercadería o alguien en la caja, se pierde la venta más cara del día.',
    recomendacion: 'Antes de esa franja: caja con cambio, heladeras llenas y nadie de descanso.',
    advertencia: aviso(dias), impacto_pesos: Math.round(porDia * 30 * 0.05), confianza: Math.min(85, 40 + dias * 3),
    detalle: { horas: hs, share: pct(share) },
  };
}

// ─── Principal ────────────────────────────────────────────────────────────────

async function hallazgosWow(negocioId, db = pool) {
  if (!negocioId) return [];
  const dias = await diasConVentas(db, negocioId);
  if (!dias) return [];
  const det = [comboNatural, margenEstrella, faltaStock, diferenciasCaja, ticketEmpleado, horaMuerta, concentracionPico];
  const res = await Promise.all(det.map((f) => f(db, negocioId, dias).catch((e) => { console.error('[wow]', f.name, e.message); return null; })));
  return res.filter(Boolean).sort((a, b) => b.impacto_pesos - a.impacto_pesos);
}

module.exports = { hallazgosWow };
