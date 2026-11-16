// margen_costos.js — "Precios que se te comieron" (Palantir, 15/11/2026).
// Para cada producto cuyo costo subió y el margen quedó más flaco, dice en criollo:
//   cuánto costaba, cuánto cuesta, cuánto te queda de cada $100 y a qué precio volvés a ganar lo de antes.
// La solución viene lista para aplicar (mismo formato `aplicar` que el resto: se pone con un botón y se deshace).
// Todo sale de las facturas cargadas (compras_items) y de las ventas reales. Nada se inventa.
const pool = require('./db');

const $ = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
const VENTANA_COSTOS = 180; // días hacia atrás para buscar el costo "de antes"
const CAIDA_MIN_PTS = 2;    // el margen tiene que haber bajado al menos 2 puntos

// Redondeo "de comercio": hacia arriba, a $10 / $50 / $100 según el precio.
function redondear(p) {
  const paso = p < 2000 ? 10 : p < 10000 ? 50 : 100;
  return Math.ceil(p / paso - 1e-9) * paso;
}

async function calcular(negocioId, db = pool) {
  const { rows: filas } = await db.query(
    `SELECT i.producto_id, i.precio_unitario::float AS costo, c.fecha, c.proveedor
       FROM compras_items i JOIN compras c ON c.id = i.compra_id
      WHERE c.negocio_id = $1 AND i.producto_id IS NOT NULL AND i.precio_unitario > 0
        AND c.fecha >= NOW() - ($2::int * INTERVAL '1 day')
      ORDER BY i.producto_id, c.fecha, i.id`, [negocioId, VENTANA_COSTOS]);
  const porProd = new Map();
  for (const f of filas) {
    if (!porProd.has(f.producto_id)) porProd.set(f.producto_id, []);
    porProd.get(f.producto_id).push(f);
  }
  const ids = [...porProd.keys()].filter((id) => porProd.get(id).length >= 2);
  if (!ids.length) return { items: [], total_mes: 0, aplicar_todos: null, hay_datos: false };

  const [prods, hist, ventas] = await Promise.all([
    db.query(`SELECT id, nombre, precio_venta::float AS pv FROM productos WHERE negocio_id = $1 AND id = ANY($2::int[])`, [negocioId, ids]),
    db.query(`SELECT producto_id, precio_anterior::float AS ant, precio_nuevo::float AS nuevo, fecha_cambio
                FROM productos_historico_precios WHERE negocio_id = $1 AND producto_id = ANY($2::int[]) ORDER BY fecha_cambio`, [negocioId, ids]),
    db.query(`SELECT d.producto_id, GREATEST(COALESCE(SUM(d.cantidad),0),0)::float AS u
                FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
               WHERE t.negocio_id = $1 AND d.producto_id = ANY($2::int[]) AND t.fecha >= NOW() - INTERVAL '30 days'
               GROUP BY 1`, [negocioId, ids]),
  ]);
  const u30 = new Map(ventas.rows.map((r) => [r.producto_id, r.u]));
  const histPor = new Map();
  for (const h of hist.rows) {
    if (!histPor.has(h.producto_id)) histPor.set(h.producto_id, []);
    histPor.get(h.producto_id).push(h);
  }

  const items = [];
  for (const p of prods.rows) {
    const compras = porProd.get(p.id);
    const antes = compras[0], ahora = compras[compras.length - 1];
    const pv = p.pv;
    if (!(pv > 0) || antes.fecha >= ahora.fecha) continue;
    const ca = antes.costo, cn = ahora.costo;
    if (cn <= ca) continue;                                  // el costo no subió
    const ratio = cn / ca;
    if (ratio > 3 || ratio < 1 / 3 || cn > pv * 1.5) continue; // probable unidad distinta (caja vs unidad)
    const u = u30.get(p.id) || 0;
    if (u <= 0) continue;                                    // no se vende: no hay plata en juego

    // ¿a cuánto lo vendías cuando pagabas el costo de antes?
    const hs = histPor.get(p.id) || [];
    let pvAntes = pv;
    const previo = hs.filter((h) => h.fecha_cambio <= antes.fecha).pop();
    if (previo) pvAntes = previo.nuevo;
    else {
      const sig = hs.find((h) => h.fecha_cambio > antes.fecha);
      if (sig) pvAntes = sig.ant;
    }
    if (!(pvAntes > 0) || ca >= pvAntes) continue;          // antes tampoco dejaba: no hay "antes" que recuperar

    const margenAntes = (pvAntes - ca) / pvAntes;
    const margenAhora = (pv - cn) / pv;
    const bajoCosto = pv < cn;
    if (!bajoCosto && (margenAntes - margenAhora) * 100 < CAIDA_MIN_PTS) continue;

    const nuevo = redondear(cn / (1 - margenAntes));
    if (nuevo <= pv || nuevo > pv * 1.5) continue;          // el sistema nunca propone subas locas
    const gana = Math.round((nuevo - pv) * u);

    const quedaAntes = Math.round(margenAntes * 100);
    const quedaAhora = Math.round(margenAhora * 100);
    const frase = bajoCosto
      ? `${p.nombre} te costaba ${$(ca)} y ahora te cuesta ${$(cn)}. Lo vendés a ${$(pv)}: perdés ${$(cn - pv)} en cada uno. Poné ${$(nuevo)} y volvés a ganar lo de antes.`
      : `${p.nombre} te costaba ${$(ca)} y ahora te cuesta ${$(cn)}. De cada $100 que vendés hoy te quedan $${Math.max(quedaAhora, 0)}; antes te quedaban $${quedaAntes}. Poné ${$(nuevo)} y volvés a ganar lo de antes.`;
    const porMes = `Vendés unas ${Math.round(u)} por mes: ganás ${$(gana)} más por mes (si vendés lo mismo).`;

    items.push({
      producto_id: p.id, nombre: p.nombre, proveedor: ahora.proveedor || null,
      costo_antes: ca, costo_ahora: cn, suba_costo_pct: Math.round((ratio - 1) * 100),
      fecha_antes: antes.fecha, fecha_ahora: ahora.fecha,
      precio_actual: pv, precio_nuevo: nuevo,
      queda_antes: quedaAntes, queda_ahora: quedaAhora, bajo_costo: bajoCosto,
      unidades_mes: Math.round(u), gana_mes: gana,
      frase, por_mes: porMes,
      aplicar: { tipo: 'precios', boton: `Poner ${$(nuevo)}`, cambios: [{ producto_id: p.id, nombre: p.nombre, antes: pv, nuevo }] },
    });
  }
  items.sort((a, b) => b.gana_mes - a.gana_mes);
  const total = items.reduce((s, i) => s + i.gana_mes, 0);
  return {
    hay_datos: true, items, total_mes: total,
    frase: items.length
      ? `${items.length} ${items.length === 1 ? 'producto subió' : 'productos subieron'} de costo y no les subiste el precio. Si los ajustás ganás ${$(total)} más por mes.`
      : 'Ningún producto con costo en suba te está comiendo el margen.',
    aplicar_todos: items.length > 1 ? {
      tipo: 'precios', boton: `Poner los ${items.length} precios`,
      cambios: items.flatMap((i) => i.aplicar.cambios),
    } : null,
  };
}

module.exports = { calcular, redondear };
