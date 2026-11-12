// catalogo_marca.js — la marca de cada producto y el autocompletado por código de barras.
// - Agrega la columna marca a productos, y a cada línea de venta guarda nombre, marca y costo del momento (así el historial no cambia si después se edita el producto).
// - Al escanear un código que el negocio no conoce, busca nombre y marca en Open Food Facts (base abierta) para completar la alta sin tipear.
const pool = require('./db');

let listo = null;
function asegurar(db = pool) {
  if (!listo) {
    listo = (async () => {
      await db.query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS marca TEXT');
      await db.query(`ALTER TABLE transacciones_detalle ADD COLUMN IF NOT EXISTS producto_nombre TEXT, ADD COLUMN IF NOT EXISTS producto_marca TEXT,
                      ADD COLUMN IF NOT EXISTS costo_unitario NUMERIC(14,2)`);
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

function limpiarMarca(m) {
  const s = String(m == null ? '' : m).split(',')[0].replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || null;
}

function normalizarCodigo(c) {
  const d = String(c == null ? '' : c).replace(/\D/g, '');
  return d.length >= 8 && d.length <= 14 ? d : null;
}

const cache = new Map();   // codigo -> { ts, dato }
const TTL_OK = 7 * 24 * 3600 * 1000, TTL_NO = 3600 * 1000, MAX_CACHE = 2000;

async function buscarCodigo(codigo, opts = {}) {
  const cod = normalizarCodigo(codigo);
  if (!cod) return null;
  const c = cache.get(cod);
  if (c && Date.now() - c.ts < (c.dato ? TTL_OK : TTL_NO)) return c.dato;
  const f = opts.fetch || fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs || 3500);
  let dato = null;
  try {
    const r = await f(`https://world.openfoodfacts.org/api/v2/product/${cod}.json?fields=product_name,brands,quantity`,
      { headers: { 'User-Agent': 'LumoBi/1.0 (lumobi.com.ar)' }, signal: ctl.signal });
    if (r.ok) {
      const j = await r.json();
      if (j && j.status === 1 && j.product) {
        const nombre = String(j.product.product_name || '').replace(/\s+/g, ' ').trim().slice(0, 150) || null;
        const marca = limpiarMarca(j.product.brands);
        const cantidad = String(j.product.quantity || '').trim().slice(0, 40) || null;
        if (nombre || marca) dato = { nombre, marca, cantidad, fuente: 'Open Food Facts' };
      }
    }
  } catch (e) { return null; }   // sin red o demora: no se guarda en cache, se reintenta la próxima vez
  finally { clearTimeout(t); }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(cod, { ts: Date.now(), dato });
  return dato;
}

module.exports = { asegurar, buscarCodigo, limpiarMarca, normalizarCodigo };
