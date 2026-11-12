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

async function armar(negocioId, hallazgo, accionId, db = pool) {
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
  const nombreNeg = ((await db.query('SELECT negocio FROM usuarios WHERE negocio_id = $1 ORDER BY id LIMIT 1', [negocioId]).catch(() => ({ rows: [] }))).rows[0] || {}).negocio;
  const A = cap(estrella.nombre), B = cap(b.nombre);
  const ganancia = costo > 0 ? Math.round(pr.precio - costo) : null;
  const combosDia = hallazgo.monto > 0 ? Math.max(1, Math.min(40, Math.ceil(hallazgo.monto / 26 / pr.precio))) : null;
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

module.exports = { armar, calcularPrecio, elegirPareja, textos, cuando, MARGEN_MIN };
