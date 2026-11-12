// promo.js — LumoBi ARMA la promo (no solo la sugiere): elige el combo con lo que mejor funciona en ese negocio,
// calcula el precio cuidando el margen y deja los textos listos. Todo sale de las ventas, precios y costos del negocio.
const pool = require('./db');

const MARGEN_MIN = 0.25;          // el combo con descuento tiene que dejar al menos 25% de margen sobre su precio
const DESCUENTOS = [0.15, 0.10, 0.05];
const DIAS = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
const fmt = (n) => '$' + Math.round(n).toLocaleString('es-AR');
const cap = (s) => String(s || '').trim().replace(/^./, (c) => c.toUpperCase());

// Elige el compañero del producto estrella: el que más se compra en el mismo ticket; si no hay, el de mejor margen.
function elegirPareja(estrella, candidatos, juntos) {
  const margen = (p) => (p.costo > 0 && p.pv > 0 ? (p.pv - p.costo) / p.pv : 0);
  const otros = candidatos.filter((p) => p.id !== estrella.id);
  if (!otros.length) return null;
  const conJuntos = juntos.map((j) => ({ p: otros.find((p) => p.id === j.id), veces: j.veces })).filter((x) => x.p && x.veces >= 2);
  if (conJuntos.length) return { p: conJuntos[0].p, motivo: `se compran juntos en el mismo ticket (${conJuntos[0].veces} veces)` };
  const mejor = otros.slice().sort((a, b) => (margen(b) - margen(a)) || (b.u - a.u))[0];
  return { p: mejor, motivo: 'es de los que más vendés y deja buen margen' };
}

// Precio del combo: el mayor descuento (15/10/5%) que deja el margen mínimo. Sin costos cargados: 10% y se avisa.
function calcularPrecio(normal, costo) {
  const paso = normal >= 3000 ? 100 : normal >= 1000 ? 50 : 10;
  let desc;
  let aviso = null;
  if (costo > 0) {
    const precioMin = costo / (1 - MARGEN_MIN);
    const maxDesc = 1 - precioMin / normal;
    desc = DESCUENTOS.find((d) => d <= maxDesc + 1e-9);
    if (!desc) return { error: 'margen_justo' };
  } else { desc = 0.10; aviso = 'No tenés cargado el costo de estos productos, así que no pude verificar el margen. Cargalo en el catálogo antes de lanzarla.'; }
  const precio = Math.ceil((normal * (1 - desc)) / paso) * paso;
  if (costo > 0 && precio < costo / (1 - MARGEN_MIN) - 1e-9) return { error: 'margen_justo' };
  const ahorro = normal - precio;
  if (ahorro / normal < 0.04) return { error: 'margen_justo' };
  return { precio, ahorro, pct: Math.round((ahorro / normal) * 100), aviso };
}

function cuando(accionId, clave) {
  const n = Number(String(clave).match(/(\d+)$/)?.[1]);
  if (accionId === 'promo_franja' && n >= 0 && n <= 23) return { texto: `de ${n} a ${n + 2} h`, corto: `De ${n} a ${n + 2} h` };
  if (accionId === 'promo_dia' && n >= 0 && n <= 6) return { texto: `los ${DIAS[n]}`, corto: `Solo los ${DIAS[n]}` };
  return { texto: 'todos los días', corto: 'Todos los días' };
}

function textos(nombreNeg, combo, cuandoT) {
  const { a, b, normal, precio } = combo;
  const nom = nombreNeg || 'tu negocio';
  return {
    whatsapp: `¡Hola! 👋 En ${nom} armamos una promo para vos: ${a} + ${b} a ${fmt(precio)} (precio normal ${fmt(normal)}). Válida ${cuandoT.texto}. ¡Te esperamos!`,
    instagram: `PROMO ${cuandoT.corto.toUpperCase()} ✨\n${a} + ${b}\n${fmt(precio)} en vez de ${fmt(normal)}\nEn ${nom}. ¡Te esperamos!`,
    cartel: `COMBO\n${a} + ${b}\n${fmt(precio)}\n${cuandoT.corto}`,
  };
}

async function datos(negocioId, db) {
  const top = (await db.query(
    `SELECT p.id, p.nombre, p.precio_venta::float AS pv, COALESCE(p.precio_costo, 0)::float AS costo, SUM(d.cantidad)::float AS u
       FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id JOIN productos p ON p.id = d.producto_id
      WHERE t.negocio_id = $1 AND p.negocio_id = $1 AND t.fecha >= NOW() - INTERVAL '90 days' AND p.activo IS NOT FALSE AND p.precio_venta > 0
      GROUP BY p.id ORDER BY u DESC LIMIT 10`, [negocioId])).rows;
  return top;
}

// Comisiones: LumoBi calcula el descuento por pagar en efectivo/transferencia que SÍ conviene con la mezcla de cobros del negocio.
// Ojo: el descuento lo aprovecha también quien ya paga en efectivo, así que se descuenta ese costo del ahorro.
async function armarComisiones(negocioId, db = pool) {
  const { normMedio, TASAS } = require('./radiografia');
  const filas = (await db.query(
    `SELECT COALESCE(metodo_pago, '') AS medio, SUM(monto)::float AS total FROM transacciones
      WHERE negocio_id = $1 AND (fecha - INTERVAL '3 hours') >= (NOW() - INTERVAL '3 hours')::date - INTERVAL '28 days'
        AND (fecha - INTERVAL '3 hours')::date < (NOW() - INTERVAL '3 hours')::date GROUP BY 1`, [negocioId])).rows;
  let sc = 0, com = 0, se = 0;
  for (const x of filas) {
    const k = normMedio(x.medio); if (!k) continue;
    const t = TASAS[k] || 0, mes = x.total * 30 / 28;
    if (t > 0) { sc += mes; com += mes * t; } else se += mes;
  }
  if (!(sc > 0) || !(com > 0)) return { sin_promo: true, motivo: 'No veo cobros con tarjeta o billetera en el último mes, así que no hay comisiones para reducir.' };
  const r = com / sc;
  const neto = (d, f) => f * sc * (r - d) - d * se;
  let mejor = null;
  for (const d of [0.03, 0.04, 0.05]) { const n = neto(d, 0.2); if (n > 0 && (!mejor || n > mejor.n)) mejor = { d, n }; }
  if (!mejor) return { sin_promo: true, motivo: `Hoy pagás en promedio ${(r * 100).toFixed(1)}% de comisión en los cobros con tarjeta o billetera y ya cobrás ${fmt(se)} por mes en efectivo o transferencia. Un descuento por pagar así te costaría más de lo que ahorrarías en comisiones, porque también se lo llevarían los que ya pagan en efectivo. Un descuento menor al 3% casi no mueve a los clientes, así que no te lo recomiendo.` };
  const d = mejor.d, pct = Math.round(d * 100);
  const nombreNeg = ((await db.query('SELECT nombre FROM negocios WHERE id = $1', [negocioId]).catch(() => ({ rows: [] }))).rows[0] || {}).nombre;
  const nom = nombreNeg || 'tu negocio';
  const esc = (f) => { const n = Math.round(neto(d, f)); return `Si ${Math.round(f * 100)}% de tus cobros con tarjeta o billetera pasa a efectivo o transferencia: ${n >= 0 ? 'ganás' : 'perdés'} ${fmt(Math.abs(n))} por mes.`; };
  return {
    sin_promo: false, nombre: `${pct}% de descuento por pagar en efectivo o transferencia`, cuando: '',
    resumen: `Ofrecé ${pct}% de descuento a quien pague en efectivo o transferencia.`,
    por_que: [
      `El ${Math.round(sc / (sc + se) * 100)}% de lo que cobrás es con tarjeta o billetera y te cuesta en promedio ${(r * 100).toFixed(1)}% (estimado con tasas típicas: cada procesador tiene las suyas).`,
      `Elegí ${pct}% porque es el descuento que más te deja con tu mezcla de cobros, descontando lo que regalás a quienes ya pagan en efectivo.`,
      esc(0.1), esc(0.2), esc(0.3),
    ],
    aviso: 'En general el recargo por tarjeta no está permitido; el descuento por pagar en efectivo sí. Los porcentajes de arriba son supuestos: probalo un mes y mirá cuánto cambia tu mezcla de cobros.',
    textos: {
      whatsapp: `¡Hola! En ${nom} tenés ${pct}% de descuento si pagás en efectivo o transferencia. ¡Te esperamos!`,
      instagram: `PAGANDO EN EFECTIVO O TRANSFERENCIA ✨\n${pct}% DE DESCUENTO\nEn ${nom}`,
      cartel: `${pct}% DE DESCUENTO\nPagando en efectivo o transferencia`,
    },
  };
}

// Proveedores: LumoBi calcula el precio nuevo de cada producto que el proveedor aumentó, manteniendo tu margen (el mismo múltiplo costo→precio).
async function armarProveedores(negocioId, db = pool) {
  let filas;
  try {
    filas = (await db.query(
      `WITH x AS (
         SELECT i.producto_id, i.clave, c.fecha, c.id AS cid, i.precio_unitario::float AS precio,
                LAG(i.precio_unitario) OVER (PARTITION BY i.clave ORDER BY c.fecha, c.id) AS ant
           FROM compras_items i JOIN compras c ON c.id = i.compra_id WHERE c.negocio_id = $1 AND i.precio_unitario > 0),
       u AS (SELECT DISTINCT ON (producto_id) * FROM x
              WHERE ant > 0 AND producto_id IS NOT NULL AND fecha >= (NOW() - INTERVAL '3 hours')::date - 90 AND precio / ant::float - 1 >= 0.05
              ORDER BY producto_id, fecha DESC, cid DESC)
       SELECT p.nombre, p.precio_venta::float AS pv, u.precio, u.ant::float AS ant
         FROM u JOIN productos p ON p.id = u.producto_id AND p.negocio_id = $1 WHERE p.precio_venta > 0
        ORDER BY u.precio / u.ant DESC LIMIT 8`, [negocioId])).rows;
  } catch (e) {
    if (e.code === '42P01') filas = [];
    else throw e;
  }
  if (!filas.length) return { sin_promo: true, motivo: 'Para calcular los precios nuevos necesito facturas cargadas con productos de tu catálogo que hayan subido de precio. Cuando cargues una factura y asocies los productos, lo calculo.' };
  const items = filas.map((x) => {
    const paso = x.pv >= 3000 ? 100 : x.pv >= 1000 ? 50 : 10;
    const nuevo = Math.ceil((x.pv * x.precio / x.ant) / paso) * paso;
    return { nombre: cap(x.nombre), pv: x.pv, nuevo, subida: Math.round((nuevo / x.pv - 1) * 100), aumento: Math.round((x.precio / x.ant - 1) * 100) };
  }).filter((x) => x.nuevo > x.pv);
  if (!items.length) return { sin_promo: true, motivo: 'Con los aumentos que encontré, tus precios actuales ya cubren el margen. No hace falta cambiar nada.' };
  return {
    sin_promo: false, nombre: 'Precios nuevos por la suba de tus proveedores', cuando: '',
    resumen: `Subí el precio de ${items.length} ${items.length === 1 ? 'producto' : 'productos'} para mantener tu margen.`,
    por_que: [
      ...items.map((x) => `${x.nombre}: de ${fmt(x.pv)} a ${fmt(x.nuevo)} (+${x.subida}%), porque tu proveedor lo subió ${x.aumento}%.`),
      'El precio nuevo mantiene la misma relación entre lo que te cuesta y lo que cobrás.',
    ],
    aviso: 'Si ya actualizaste alguno de estos precios, ignoralo. LumoBi no cambia tus precios solo: los cargás vos en el catálogo.',
    textos: { lista: 'Precios nuevos:\n' + items.map((x) => `${x.nombre}: ${fmt(x.nuevo)}`).join('\n') },
  };
}

async function armar(negocioId, hallazgo, accionId, db = pool) {
  if (accionId === 'descuento_efectivo') return armarComisiones(negocioId, db);
  if (accionId === 'ajustar_precio') return armarProveedores(negocioId, db);
  if (accionId === 'corregir_precios') return require('./detector_marcas').armarPrecios(negocioId, db);
  const top = await datos(negocioId, db);
  if (top.length < 2) return { sin_promo: true, motivo: 'Necesito al menos 2 productos con ventas registradas por producto para armar un combo con tus datos. Escaneá o cargá ventas con productos y lo armo.' };
  const estrella = top[0];
  const juntos = (await db.query(
    `SELECT d2.producto_id AS id, COUNT(*)::int AS veces
       FROM transacciones_detalle d1
       JOIN transacciones_detalle d2 ON d2.transaccion_id = d1.transaccion_id AND d2.producto_id <> d1.producto_id
       JOIN transacciones t ON t.id = d1.transaccion_id
      WHERE t.negocio_id = $1 AND d1.producto_id = $2 AND t.fecha >= NOW() - INTERVAL '90 days'
      GROUP BY d2.producto_id ORDER BY veces DESC LIMIT 5`, [negocioId, estrella.id])).rows;
  const par = elegirPareja(estrella, top, juntos);
  if (!par) return { sin_promo: true, motivo: 'Necesito al menos 2 productos distintos con ventas para armar un combo.' };
  const b = par.p;
  const normal = estrella.pv + b.pv;
  const costo = estrella.costo > 0 && b.costo > 0 ? estrella.costo + b.costo : 0;
  const pr = calcularPrecio(normal, costo);
  if (pr.error) return { sin_promo: true, motivo: `Con los costos de ${cap(estrella.nombre)} y ${cap(b.nombre)} no queda margen para hacer un descuento sano. Probá con otros productos o revisá tus precios.` };
  const cu = cuando(accionId, hallazgo.clave);
  const nombreNeg = ((await db.query('SELECT nombre FROM negocios WHERE id = $1', [negocioId]).catch(() => ({ rows: [] }))).rows[0] || {}).nombre;
  const A = cap(estrella.nombre), B = cap(b.nombre);
  const ganancia = costo > 0 ? Math.round(pr.precio - costo) : null;
  // La meta solo se muestra si es creíble (hasta 10 combos por día); una estimación inflada daría una cuenta absurda
  const combosCalc = hallazgo.monto > 0 ? Math.max(1, Math.ceil(hallazgo.monto / 26 / pr.precio)) : null;
  const combosDia = combosCalc && combosCalc <= 10 ? combosCalc : null;
  return {
    sin_promo: false,
    nombre: `Combo ${A} + ${B}`, cuando: cu.texto,
    productos: [A, B], precio_normal: normal, precio_promo: pr.precio, ahorro: pr.ahorro, descuento_pct: pr.pct,
    ganancia_por_combo: ganancia,
    meta_combos_por_dia: combosDia,
    por_que: [
      `${A} es lo que más vende tu negocio (${Math.round(estrella.u)} unidades en 90 días).`,
      `${B}: ${par.motivo}.`,
      costo > 0 ? `El descuento de ${pr.pct}% deja un margen de al menos ${Math.round(MARGEN_MIN * 100)}% sobre el precio del combo.` : null,
    ].filter(Boolean),
    aviso: pr.aviso,
    textos: textos(nombreNeg, { a: A, b: B, normal, precio: pr.precio }, cu),
  };
}

module.exports = { armar, armarProveedores, armarComisiones, calcularPrecio, elegirPareja, textos, cuando, MARGEN_MIN };
