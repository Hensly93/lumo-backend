// detector_stock.js — el stock, dentro del libro único de hallazgos (hallazgos.js). Solo mira productos que el dueño ya controla.
//   · stock_agotado     productos que se venden seguido y hoy no tienen stock: ventas que se pierden
//   · stock_bajo        productos que se terminan en pocos días al ritmo de venta actual
//   · stock_inmovil     plata dormida: productos con stock que hace 60+ días que no se venden
//   · stock_diferencia  faltantes en los conteos (unidades que no están y nadie vendió): plata perdida
const pool = require('./db');

const fmt = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('es-AR');
const sinTabla = (e) => e && (e.code === '42P01' || e.code === '42703');
const DIAS_RIESGO = 7;

async function base(negocioId, db) {
  const { listar } = require('./stock');
  return (await listar(negocioId, db)).productos.filter((p) => p.estado !== 'sin_control');
}
const margenUnit = (p) => (p.precio_costo > 0 && p.precio_venta > p.precio_costo ? p.precio_venta - p.precio_costo : 0);

function detQuiebres(prods) {
  const lista = (estado) => prods.filter((p) => p.estado === estado && p.vendido30 >= 3 && margenUnit(p) > 0)
    .map((p) => { const vel = p.vendido30 / 30; const dias = estado === 'agotado' ? DIAS_RIESGO : Math.max(0, DIAS_RIESGO - (p.stock / vel)); return { ...p, vel, plata: vel * margenUnit(p) * dias }; })
    .filter((p) => p.plata > 0).sort((a, b) => b.plata - a.plata);
  const out = [];
  const ag = lista('agotado');
  if (ag.length) {
    const total = Math.round(ag.reduce((s, p) => s + p.plata, 0));
    out.push({
      id: 'stock_agotado', tipo: 'estimado', ignora_suficiente: true,
      titulo: `${ag.length === 1 ? 'Un producto que vendés seguido está sin stock' : ag.length + ' productos que vendés seguido están sin stock'}: ~${fmt(total)} de ganancia en juego esta semana`,
      detalle: 'Es lo que dejarías de ganar en los próximos 7 días si no los reponés, al ritmo al que se venden.',
      evidencia: ag.slice(0, 5).map((p) => `${p.nombre}: sin stock, se vendían ${Math.round(p.vendido30)} unidades por mes (~${fmt(p.plata)} de ganancia en 7 días).`),
      monto: total, monto_texto: `~${fmt(total)} de ganancia en juego por falta de stock`, url: '/catalogo',
    });
  }
  const ba = lista('bajo');
  if (ba.length) {
    const total = Math.round(ba.reduce((s, p) => s + p.plata, 0));
    out.push({
      id: 'stock_bajo', tipo: 'estimado', ignora_suficiente: true,
      titulo: `${ba.length === 1 ? 'Un producto se te termina' : ba.length + ' productos se te terminan'} en pocos días: ~${fmt(total)} de ganancia en juego`,
      detalle: 'Al ritmo de venta del último mes, no te alcanza para la semana. Conviene pedirlos antes de quedarte sin.',
      evidencia: ba.slice(0, 5).map((p) => `${p.nombre}: quedan ${p.stock} y se venden ~${(Math.round(p.vel * 10) / 10)} por día${p.dias_restantes != null ? ` (te alcanza para ${p.dias_restantes} días)` : ''}.`),
      monto: total, monto_texto: `~${fmt(total)} de ganancia en juego si se terminan`, url: '/catalogo',
    });
  }
  return out;
}

function detInmovil(prods) {
  const dorm = prods.filter((p) => p.estado === 'sin_movimiento' && p.stock > 0 && p.precio_costo > 0)
    .map((p) => ({ ...p, capital: p.stock * p.precio_costo })).sort((a, b) => b.capital - a.capital);
  const total = Math.round(dorm.reduce((s, p) => s + p.capital, 0));
  if (!dorm.length || total <= 0) return null;
  return {
    id: 'stock_inmovil', tipo: 'calculado', ignora_suficiente: true,
    titulo: `Tenés ${fmt(total)} parados en ${dorm.length === 1 ? 'un producto' : dorm.length + ' productos'} que hace más de 60 días no se venden`,
    detalle: 'Es plata que pagaste y está en el estante. Una promo, un combo o dejar de reponerlos la libera.',
    evidencia: dorm.slice(0, 5).map((p) => `${p.nombre}: ${p.stock} unidades, ${fmt(p.capital)} a costo, última venta hace ${p.dias_sin_venta} días.`),
    monto: total, monto_texto: `${fmt(total)} parados en productos que no se venden`, url: '/catalogo',
  };
}

async function detDiferencia(negocioId, db) {
  const r = await db.query(
    `SELECT p.nombre, SUM(-m.cantidad)::float AS faltan, SUM(-m.cantidad * COALESCE(m.costo, p.precio_costo, 0))::float AS plata
       FROM movimientos_stock m JOIN productos p ON p.id = m.producto_id
      WHERE m.negocio_id = $1 AND m.tipo = 'conteo' AND m.cantidad < 0 AND m.creado >= NOW() - INTERVAL '30 days'
      GROUP BY p.id, p.nombre HAVING SUM(-m.cantidad * COALESCE(m.costo, p.precio_costo, 0)) > 0 ORDER BY 3 DESC`, [negocioId]);
  const total = Math.round(r.rows.reduce((s, x) => s + x.plata, 0));
  if (!r.rows.length || total <= 0) return null;
  return {
    id: 'stock_diferencia', tipo: 'calculado', ignora_suficiente: true,
    titulo: `Al contar faltaron productos por ${fmt(total)} a costo en los últimos 30 días`,
    detalle: 'Son unidades que según el sistema tenías y al contar no estaban: no figuran como venta. Puede ser robo, rotura, vencimiento o una carga mal hecha.',
    evidencia: r.rows.slice(0, 5).map((x) => `${x.nombre}: faltaron ${Math.round(x.faltan * 100) / 100} unidades (${fmt(x.plata)} a costo).`),
    monto: total, monto_texto: `${fmt(total)} de faltante en los conteos`, url: '/catalogo',
  };
}

async function detectarStock(negocioId, db = pool, opts = {}) {
  const out = [];
  let prods = [];
  try { prods = await (opts.productos ? opts.productos() : base(negocioId, db)); }
  catch (e) { if (!sinTabla(e)) console.error('detector_stock/base:', e.message); }
  if (prods.length) {
    try { out.push(...detQuiebres(prods)); } catch (e) { console.error('detector_stock/quiebres:', e.message); }
    try { const h = detInmovil(prods); if (h) out.push(h); } catch (e) { console.error('detector_stock/inmovil:', e.message); }
  }
  try { const h = await detDiferencia(negocioId, db); if (h) out.push(h); }
  catch (e) { if (!sinTabla(e)) console.error('detector_stock/diferencia:', e.message); }
  return out;
}

module.exports = { detectarStock, detQuiebres, detInmovil, detDiferencia };
