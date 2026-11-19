// proveedores.js — LumoBi · ficha de cada proveedor, armada sola con las facturas que el dueño ya cargó (punto 5 del plan).
//
//   GET /api/proveedores            -> lista: cuánto le comprás, cuántas facturas, última compra
//   GET /api/proveedores/ficha?nombre=...  -> detalle: qué productos te vende, cuánto subió cada uno y dónde otro proveedor lo cobra menos
//
// No inventa nada: todo sale de compras / compras_items. El proveedor es el texto de la factura (sin mayúsculas ni espacios de más).
// Solo se comparan precios del mismo producto (misma "clave" de la factura) y de la misma unidad.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');

const DIAS = 90;
const SUBA_MIN_PCT = 5;      // una suba menor al 5% no se marca
const AHORRO_MIN_PCT = 5;    // una diferencia menor al 5% entre proveedores no se marca
const norm = (s) => String(s || '').trim().toLowerCase();

async function lista(negocioId, db = pool) {
  const r = await db.query(
    `SELECT LOWER(TRIM(proveedor)) AS clave, MAX(proveedor) AS nombre, MAX(NULLIF(proveedor_cuit,'')) AS cuit,
            COUNT(*)::int AS facturas, COALESCE(SUM(total),0)::float AS total, MAX(fecha) AS ultima
       FROM compras WHERE negocio_id = $1 AND fecha >= (CURRENT_DATE - $2::int)
      GROUP BY 1 ORDER BY total DESC`, [negocioId, DIAS]);
  const total = r.rows.reduce((s, x) => s + x.total, 0);
  return {
    dias: DIAS, total: Math.round(total),
    proveedores: r.rows.map((x) => ({ ...x, total: Math.round(x.total), pct: total > 0 ? Math.round(x.total / total * 100) : 0 })),
  };
}

async function ficha(negocioId, nombre, db = pool) {
  const clave = norm(nombre);
  const cab = await db.query(
    `SELECT MAX(proveedor) AS nombre, MAX(NULLIF(proveedor_cuit,'')) AS cuit, COUNT(*)::int AS facturas,
            COALESCE(SUM(total),0)::float AS total, MAX(fecha) AS ultima
       FROM compras WHERE negocio_id = $1 AND LOWER(TRIM(proveedor)) = $2 AND fecha >= (CURRENT_DATE - $3::int)`, [negocioId, clave, DIAS]);
  if (!cab.rows[0] || !cab.rows[0].facturas) return null;

  // Cada producto de este proveedor: primer y último precio unitario dentro de la ventana
  const prods = await db.query(
    `WITH it AS (
       SELECT i.clave, i.descripcion, COALESCE(NULLIF(LOWER(TRIM(i.unidad)),''),'u') AS unidad, i.precio_unitario::float AS precio,
              i.cantidad::float AS cantidad, COALESCE(i.subtotal, i.precio_unitario * i.cantidad)::float AS subtotal, c.fecha, c.id AS compra_id
         FROM compras_items i JOIN compras c ON c.id = i.compra_id
        WHERE c.negocio_id = $1 AND LOWER(TRIM(c.proveedor)) = $2 AND c.fecha >= (CURRENT_DATE - $3::int) AND i.precio_unitario > 0)
     SELECT clave, MAX(descripcion) AS descripcion, MAX(unidad) AS unidad, COUNT(DISTINCT compra_id)::int AS compras,
            SUM(cantidad)::float AS cantidad, SUM(subtotal)::float AS gastado,
            (ARRAY_AGG(precio ORDER BY fecha ASC, compra_id ASC))[1] AS precio_primero,
            (ARRAY_AGG(precio ORDER BY fecha DESC, compra_id DESC))[1] AS precio_ultimo
       FROM it GROUP BY clave ORDER BY gastado DESC NULLS LAST LIMIT 60`, [negocioId, clave, DIAS]);

  // Último precio de OTROS proveedores para los mismos productos
  const otros = await db.query(
    `SELECT DISTINCT ON (i.clave, LOWER(TRIM(c.proveedor)))
            i.clave, MAX(c.proveedor) OVER (PARTITION BY i.clave, LOWER(TRIM(c.proveedor))) AS proveedor,
            COALESCE(NULLIF(LOWER(TRIM(i.unidad)),''),'u') AS unidad, i.precio_unitario::float AS precio, c.fecha
       FROM compras_items i JOIN compras c ON c.id = i.compra_id
      WHERE c.negocio_id = $1 AND LOWER(TRIM(c.proveedor)) <> $2 AND c.fecha >= (CURRENT_DATE - $3::int) AND i.precio_unitario > 0
        AND i.clave = ANY($4::text[])
      ORDER BY i.clave, LOWER(TRIM(c.proveedor)), c.fecha DESC, c.id DESC`, [negocioId, clave, DIAS, prods.rows.map((p) => p.clave)]);

  let ahorro = 0;
  const productos = prods.rows.map((p) => {
    const cambio = p.compras >= 2 && p.precio_primero > 0 ? (p.precio_ultimo - p.precio_primero) / p.precio_primero * 100 : null;
    const mejor = otros.rows
      .filter((o) => o.clave === p.clave && o.unidad === p.unidad && o.precio < p.precio_ultimo * (1 - AHORRO_MIN_PCT / 100))
      .sort((a, b) => a.precio - b.precio)[0] || null;
    const ahorroProd = mejor ? Math.round((p.precio_ultimo - mejor.precio) * p.cantidad) : 0;
    ahorro += ahorroProd;
    return {
      clave: p.clave, descripcion: p.descripcion, unidad: p.unidad, compras: p.compras, cantidad: Math.round(p.cantidad * 100) / 100,
      gastado: Math.round(p.gastado || 0), precio_primero: p.precio_primero, precio_ultimo: p.precio_ultimo,
      cambio_pct: cambio == null ? null : Math.round(cambio * 10) / 10,
      subio: cambio != null && cambio >= SUBA_MIN_PCT,
      mas_barato: mejor ? { proveedor: mejor.proveedor, precio: mejor.precio, menos_pct: Math.round((1 - mejor.precio / p.precio_ultimo) * 100), ahorro_90d: ahorroProd } : null,
    };
  });
  const c = cab.rows[0];
  return {
    dias: DIAS, nombre: c.nombre, cuit: c.cuit, facturas: c.facturas, total: Math.round(c.total), ultima: c.ultima,
    productos, subas: productos.filter((p) => p.subio).length,
    ahorro_posible_90d: ahorro,
    aviso: 'Compara precios por unidad de las facturas que cargaste. Si dos proveedores venden presentaciones distintas, revisalo antes de cambiar.',
  };
}

router.get('/', auth, async (req, res) => {
  try { res.json(await lista(req.user.negocio_id)); }
  catch (e) { console.error('proveedores:', e.message); res.status(500).json({ error: 'No pude armar la lista de proveedores.' }); }
});
router.get('/ficha', auth, async (req, res) => {
  try {
    const nombre = String(req.query.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'Falta el proveedor.' });
    const f = await ficha(req.user.negocio_id, nombre);
    if (!f) return res.status(404).json({ error: 'No hay facturas de ese proveedor en los últimos 90 días.' });
    res.json(f);
  } catch (e) { console.error('proveedores/ficha:', e.message); res.status(500).json({ error: 'No pude armar la ficha.' }); }
});

module.exports = { router, lista, ficha };
