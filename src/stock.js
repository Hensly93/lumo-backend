// stock.js — stock liviano: cuánto hay de cada producto, sin ser un ERP (no hay órdenes de compra ni depósitos).
// Idea: el stock de un producto arranca cuando el dueño lo CUENTA (o lo carga). Desde ahí se mueve solo:
//   · cada venta lo baja (nunca frena una venta: si no alcanza, queda en negativo y se marca para revisar)
//   · cada compra cargada lo sube (solo si la unidad de la factura es "unidad", para no mezclar cajas con unidades)
//   · cada conteo lo corrige, y la diferencia queda registrada: es plata que se pierde (robo, rotura, vencido, error)
// stock = NULL significa "este producto no se controla todavía". Todo queda en el libro movimientos_stock.
const pool = require('./db');

let listo = null;
function asegurar(db = pool) {
  if (!listo) {
    listo = (async () => {
      await db.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS stock NUMERIC(14,3), ADD COLUMN IF NOT EXISTS stock_minimo NUMERIC(14,3)`);
      await db.query(`CREATE TABLE IF NOT EXISTS movimientos_stock (
        id SERIAL PRIMARY KEY, negocio_id INTEGER NOT NULL, producto_id INTEGER NOT NULL,
        tipo TEXT NOT NULL, cantidad NUMERIC(14,3) NOT NULL, stock_despues NUMERIC(14,3), costo NUMERIC(14,2),
        ref_id INTEGER, origen TEXT, empleado TEXT, creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.query('CREATE INDEX IF NOT EXISTS idx_mov_stock_prod ON movimientos_stock (negocio_id, producto_id, creado DESC)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_mov_stock_tipo ON movimientos_stock (negocio_id, tipo, creado DESC)');
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const UNIDADES_OK = ['', 'u', 'un', 'uni', 'unid', 'unidad', 'unidades', 'ud', 'uds', 'pza', 'pieza', 'piezas'];
const unidadSirve = (u) => UNIDADES_OK.includes(String(u == null ? '' : u).trim().toLowerCase().replace(/\.$/, ''));

// Mueve el stock de UN producto, solo si ya se controla. Devuelve el stock nuevo o null si no se controla.
async function mover(db, { negocioId, productoId, tipo, cantidad, costo = null, refId = null, origen = null, empleado = null }) {
  const c = num(cantidad);
  if (!productoId || !c) return null;
  const r = await db.query(
    `UPDATE productos SET stock = stock + $3 WHERE id = $1 AND negocio_id = $2 AND stock IS NOT NULL RETURNING stock::float AS stock`, [productoId, negocioId, c]);
  if (!r.rows.length) return null;
  await db.query(
    `INSERT INTO movimientos_stock (negocio_id, producto_id, tipo, cantidad, stock_despues, costo, ref_id, origen, empleado) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [negocioId, productoId, tipo, c, r.rows[0].stock, costo, refId, origen, empleado]);
  return r.rows[0].stock;
}

// Dentro de una transacción: lo que falle acá no puede arruinar la venta ni la compra → SAVEPOINT.
async function conSavepoint(client, nombre, fn) {
  await client.query(`SAVEPOINT ${nombre}`);
  try { const r = await fn(); await client.query(`RELEASE SAVEPOINT ${nombre}`); return r; }
  catch (e) {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${nombre}`); } catch (_) { /* nada */ }
    console.error('stock/' + nombre + ':', e.message); return null;
  }
}

async function descontarVenta(client, { negocioId, transaccionId, items, empleado }) {
  return conSavepoint(client, 'stock_venta', async () => {
    const juntos = new Map();
    for (const it of items) { if (it.producto_id) juntos.set(it.producto_id, (juntos.get(it.producto_id) || 0) + num(it.cantidad)); }
    for (const [productoId, cant] of juntos) {
      await mover(client, { negocioId, productoId, tipo: 'venta', cantidad: -cant, refId: transaccionId, origen: 'caja', empleado });
    }
    return true;
  });
}

async function sumarCompra(client, { negocioId, compraId, items }) {
  const r = { sumados: 0, omitidos: 0 };
  await conSavepoint(client, 'stock_compra', async () => {
    for (const it of items) {
      if (!it.producto_id || !(num(it.cantidad) > 0)) continue;
      if (!unidadSirve(it.unidad)) { r.omitidos++; continue; }
      const s = await mover(client, { negocioId, productoId: it.producto_id, tipo: 'compra', cantidad: num(it.cantidad), costo: it.precio_unitario || null, refId: compraId, origen: 'factura' });
      if (s != null) r.sumados++;
    }
  });
  return r;
}

// Al borrar una factura, se devuelve lo que había sumado.
async function revertirCompra(db, { negocioId, compraId }) {
  const r = await db.query(`SELECT producto_id, SUM(cantidad)::float AS cant FROM movimientos_stock WHERE negocio_id = $1 AND tipo = 'compra' AND ref_id = $2 GROUP BY producto_id`, [negocioId, compraId]);
  for (const x of r.rows) await mover(db, { negocioId, productoId: x.producto_id, tipo: 'compra_anulada', cantidad: -x.cant, refId: compraId, origen: 'factura' });
  return r.rows.length;
}

// Conteo: el dueño dice cuánto hay. Si no se controlaba, es el stock inicial; si ya se controlaba, la diferencia es faltante o sobrante.
async function contar(negocioId, items, quien = null, db = pool) {
  const out = { iniciales: 0, ajustes: 0, sin_cambio: 0, diferencias: [] };
  for (const it of items) {
    const pid = parseInt(it.producto_id, 10);
    const contado = num(it.contado);
    if (!pid || it.contado === '' || it.contado == null || contado < 0 || contado > 1e7) continue;
    const p = (await db.query('SELECT id, nombre, stock::float AS stock, precio_costo::float AS costo FROM productos WHERE id = $1 AND negocio_id = $2', [pid, negocioId])).rows[0];
    if (!p) continue;
    if (p.stock == null) {
      await db.query('UPDATE productos SET stock = $3 WHERE id = $1 AND negocio_id = $2', [pid, negocioId, contado]);
      await db.query(`INSERT INTO movimientos_stock (negocio_id, producto_id, tipo, cantidad, stock_despues, costo, origen, empleado) VALUES ($1,$2,'inicial',$3,$3,$4,'conteo',$5)`, [negocioId, pid, contado, p.costo || null, quien]);
      out.iniciales++;
    } else {
      const dif = Math.round((contado - p.stock) * 1000) / 1000;
      if (!dif) { out.sin_cambio++; continue; }
      await db.query('UPDATE productos SET stock = $3 WHERE id = $1 AND negocio_id = $2', [pid, negocioId, contado]);
      await db.query(`INSERT INTO movimientos_stock (negocio_id, producto_id, tipo, cantidad, stock_despues, costo, origen, empleado) VALUES ($1,$2,'conteo',$3,$4,$5,'conteo',$6)`, [negocioId, pid, dif, contado, p.costo || null, quien]);
      out.ajustes++;
      out.diferencias.push({ producto_id: pid, nombre: p.nombre, esperado: p.stock, contado, diferencia: dif, plata: p.costo ? Math.round(dif * p.costo) : null });
    }
  }
  return out;
}

// Estado de cada producto (puro, para probar): sin_control | negativo | agotado | bajo | sin_movimiento | ok
const DIAS_BAJO = 4;
function estadoDe({ stock, stock_minimo, vendido30, dias_sin_venta }) {
  if (stock == null) return 'sin_control';
  if (stock < 0) return 'negativo';
  const vel = vendido30 / 30;
  if (stock === 0) return vendido30 > 0 || (stock_minimo != null && stock_minimo > 0) ? 'agotado' : 'ok';
  if (stock_minimo != null && stock_minimo > 0 && stock <= stock_minimo) return 'bajo';
  if (vel > 0 && stock / vel < DIAS_BAJO && vendido30 >= 3) return 'bajo';
  if (dias_sin_venta != null && dias_sin_venta >= 60) return 'sin_movimiento';
  return 'ok';
}

async function listar(negocioId, db = pool) {
  const r = await db.query(
    `SELECT p.id, p.nombre, p.marca, p.categoria, p.precio_venta::float AS precio_venta, p.precio_costo::float AS precio_costo,
            p.stock::float AS stock, p.stock_minimo::float AS stock_minimo,
            COALESCE(v.u30,0)::float AS vendido30, v.ultima AS ultima_venta
       FROM productos p
       LEFT JOIN LATERAL (
         SELECT SUM(d.cantidad) FILTER (WHERE t.fecha >= NOW() - INTERVAL '30 days') AS u30, MAX(t.fecha) AS ultima
           FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
          WHERE t.negocio_id = $1 AND d.producto_id = p.id AND t.tipo = 'venta') v ON true
      WHERE p.negocio_id = $1 AND p.activo = true ORDER BY p.nombre`, [negocioId]);
  const ahora = Date.now();
  const filas = r.rows.map((p) => {
    const dias_sin_venta = p.ultima_venta ? Math.floor((ahora - new Date(p.ultima_venta).getTime()) / 86400000) : null;
    const vel = p.vendido30 / 30;
    const estado = estadoDe({ stock: p.stock, stock_minimo: p.stock_minimo, vendido30: p.vendido30, dias_sin_venta });
    return { ...p, ultima_venta: undefined, dias_sin_venta, dias_restantes: p.stock != null && p.stock > 0 && vel > 0 ? Math.round((p.stock / vel) * 10) / 10 : null, estado };
  });
  const res = { controlados: 0, sin_control: 0, agotados: 0, bajos: 0, negativos: 0, sin_movimiento: 0, capital: 0, capital_parado: 0 };
  for (const p of filas) {
    if (p.estado === 'sin_control') { res.sin_control++; continue; }
    res.controlados++;
    if (p.estado === 'agotado') res.agotados++;
    if (p.estado === 'bajo') res.bajos++;
    if (p.estado === 'negativo') res.negativos++;
    if (p.estado === 'sin_movimiento') res.sin_movimiento++;
    const cap = p.stock > 0 && p.precio_costo > 0 ? p.stock * p.precio_costo : 0;
    res.capital += cap;
    if (p.estado === 'sin_movimiento') res.capital_parado += cap;
  }
  res.capital = Math.round(res.capital); res.capital_parado = Math.round(res.capital_parado);
  return { productos: filas, resumen: res };
}

module.exports = { asegurar, mover, descontarVenta, sumarCompra, revertirCompra, contar, listar, estadoDe, unidadSirve, conSavepoint };
