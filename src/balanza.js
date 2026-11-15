// balanza.js — etiquetas de balanza (fiambre, verdura, panadería, carne) (14/11/2026).
// La balanza imprime un código EAN-13 que empieza con 2 y trae adentro:
//   2 X PPPPP VVVVV C   (formato "5-5": PLU de 5 dígitos + valor de 5)   ← el más común en Argentina
//   2 X PPPP VVVVVV C   (formato "4-6": PLU de 4 dígitos + valor de 6)
// PLU = el número de producto que se programa en la balanza. VALOR = el precio en pesos o el peso en gramos,
// según cómo esté configurada (negocios.balanza_modo: 'precio' | 'peso').
// En LumoBi el producto pesable se carga con su precio POR KILO y con el número de la balanza como código.
// Al pasar la etiqueta, la caja agrega el producto con la cantidad en kilos: así el total da exacto
// y "lo que más se vende" cuenta kilos de verdad.
const pool = require('./db');

let listo = null;
function asegurar(db = pool) {
  if (!listo) {
    listo = (async () => {
      await db.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS balanza_modo TEXT NOT NULL DEFAULT 'precio'`);
      await db.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS balanza_formato TEXT NOT NULL DEFAULT '5-5'`);
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

function digitoControlOk(c) {
  const d = c.split('').map(Number);
  const suma = d.slice(0, 12).reduce((s, x, i) => s + x * (i % 2 ? 3 : 1), 0);
  return (10 - (suma % 10)) % 10 === d[12];
}

// Devuelve { plu, valor } o null si no parece una etiqueta de balanza
function leerEtiqueta(codigo, formato = '5-5') {
  const c = String(codigo || '').trim();
  if (!/^2\d{12}$/.test(c) || !digitoControlOk(c)) return null;
  const [np, nv] = formato === '4-6' ? [4, 6] : [5, 5];
  const plu = c.slice(2, 2 + np);
  const valor = parseInt(c.slice(2 + np, 2 + np + nv), 10);
  if (!(valor > 0)) return null;
  return { plu, valor };
}

async function config(negocioId, db = pool) {
  await asegurar(db);
  const r = await db.query(`SELECT balanza_modo, balanza_formato FROM negocios WHERE id = $1`, [negocioId]);
  return { modo: (r.rows[0] && r.rows[0].balanza_modo) || 'precio', formato: (r.rows[0] && r.rows[0].balanza_formato) || '5-5' };
}

async function guardarConfig(negocioId, { modo, formato }, db = pool) {
  await asegurar(db);
  const m = modo === 'peso' ? 'peso' : 'precio';
  const f = formato === '4-6' ? '4-6' : '5-5';
  await db.query(`UPDATE negocios SET balanza_modo = $2, balanza_formato = $3 WHERE id = $1`, [negocioId, m, f]);
  return { modo: m, formato: f };
}

// Busca el producto de la etiqueta. Devuelve { producto, cantidad_kg, importe } o null
async function resolver(negocioId, codigo, db = pool) {
  const cfg = await config(negocioId, db);
  const e = leerEtiqueta(codigo, cfg.formato);
  if (!e) return null;
  // El código del producto puede estar cargado como "00123", "123" o el PLU completo
  const variantes = [...new Set([e.plu, String(parseInt(e.plu, 10))])];
  const r = await db.query(
    `SELECT id, nombre, marca, categoria, precio_venta, unidad, codigo_barras FROM productos
      WHERE negocio_id = $1 AND COALESCE(activo, true) AND codigo_barras = ANY($2::text[]) ORDER BY id LIMIT 1`,
    [negocioId, variantes]);
  const p = r.rows[0];
  if (!p) return { sin_producto: true, plu: String(parseInt(e.plu, 10)) };
  const precioKg = Number(p.precio_venta) || 0;
  let kg, importe;
  if (cfg.modo === 'peso') { kg = e.valor / 1000; importe = kg * precioKg; }
  else {
    if (!(precioKg > 0)) return { sin_precio: true, producto: p };
    importe = e.valor; kg = importe / precioKg;
  }
  // En modo precio la cantidad no se redondea: así kilos × precio da exacto el importe de la etiqueta
  return { producto: p, cantidad_kg: cfg.modo === 'peso' ? Math.round(kg * 1000) / 1000 : kg, importe: Math.round(importe) };
}

module.exports = { asegurar, leerEtiqueta, config, guardarConfig, resolver, digitoControlOk };
