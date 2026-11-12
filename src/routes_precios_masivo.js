// routes_precios_masivo.js — actualizar precios en bloque (por categoría, marca, proveedor, margen bajo o precios sin tocar).
// Siempre en dos pasos: simular (no guarda nada, muestra precio de hoy → precio nuevo → margen) y aplicar (lo que el dueño confirmó).
// Todo filtra por negocio_id y cada cambio queda en el historial de precios.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');

const MARGEN_BAJO = 0.25;
const MAX_ITEMS = 1000;
const fallo = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Error interno' });
const bad = (m) => Object.assign(new Error(m), { status: 400 });

// Precios que se cobran bien: de a $10 hasta $1000, de a $50 hasta $3000 y de a $100 desde ahí
const paso = (p) => (p >= 3000 ? 100 : p >= 1000 ? 50 : 10);
const arriba = (x) => { const s = paso(x); return Math.ceil(x / s - 1e-9) * s; };
const abajo = (x) => { const s = paso(x); return Math.max(s, Math.floor(x / s + 1e-9) * s); };

function limpiarFiltro(f) {
  f = f && typeof f === 'object' ? f : {};
  const t = (v) => { const s = String(v == null ? '' : v).trim().slice(0, 120); return s || null; };
  const dias = Number(f.sin_tocar_dias);
  return { categoria: t(f.categoria), marca: t(f.marca), proveedor: t(f.proveedor), margen_bajo: !!f.margen_bajo, sin_tocar_dias: Number.isInteger(dias) && dias > 0 && dias <= 730 ? dias : null };
}

async function candidatos(negocioId, f, db) {
  try {
    await require('./catalogo_marca').asegurar(db);
    return (await db.query(
      `SELECT p.id, p.nombre, p.marca, p.categoria, p.precio_venta::float AS pv, p.precio_costo::float AS costo
         FROM productos p
        WHERE p.negocio_id = $1 AND COALESCE(p.activo, true) AND p.precio_venta > 0
          AND ($2::text IS NULL OR p.categoria = $2) AND ($3::text IS NULL OR p.marca = $3)
          AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM compras_items i JOIN compras c ON c.id = i.compra_id WHERE i.producto_id = p.id AND c.negocio_id = $1 AND c.proveedor = $4))
          AND (NOT $5::boolean OR (p.precio_costo > 0 AND p.precio_costo / p.precio_venta > $7::float))
          AND ($6::int IS NULL OR p.updated_at < NOW() - ($6::int * INTERVAL '1 day'))
        ORDER BY p.nombre LIMIT ${MAX_ITEMS}`,
      [negocioId, f.categoria, f.marca, f.proveedor, f.margen_bajo, f.sin_tocar_dias, 1 - MARGEN_BAJO])).rows;
  } catch (e) { if (e.code === '42P01') return []; throw e; }
}

// Puro: calcula el precio nuevo de cada producto según el modo
function calcular(filas, modo, valor) {
  const items = []; let sinCosto = 0, yaCumplen = 0;
  for (const x of filas) {
    let nuevo;
    if (modo === 'porcentaje') {
      const t = x.pv * (1 + valor / 100);
      nuevo = valor > 0 ? arriba(t) : abajo(t);
      if (valor > 0 && nuevo <= x.pv) nuevo = x.pv + paso(x.pv);
    } else {
      if (!(x.costo > 0)) { sinCosto++; continue; }
      nuevo = arriba(x.costo / (1 - valor / 100));
      if (nuevo <= x.pv) { yaCumplen++; continue; }   // solo se sube: nunca se baja un precio que ya cumple
    }
    if (nuevo === x.pv) continue;
    const sube = Math.round((nuevo / x.pv - 1) * 100);
    items.push({
      id: x.id, nombre: x.nombre, marca: x.marca || null, categoria: x.categoria || null,
      precio_actual: x.pv, precio_nuevo: nuevo, subida_pct: sube,
      margen_actual: x.costo > 0 ? Math.round((1 - x.costo / x.pv) * 100) : null,
      margen_nuevo: x.costo > 0 ? Math.round((1 - x.costo / nuevo) * 100) : null,
      alto: sube > 20,
    });
  }
  return { items, sin_costo: sinCosto, ya_cumplen: yaCumplen };
}

router.get('/opciones', auth, async (req, res) => {
  try {
    const n = req.user.negocio_id;
    await require('./catalogo_marca').asegurar();
    const lista = async (sql) => { try { return (await pool.query(sql, [n])).rows.map((r) => r.v); } catch (e) { if (e.code === '42P01') return []; throw e; } };
    res.json({
      categorias: await lista(`SELECT DISTINCT categoria AS v FROM productos WHERE negocio_id=$1 AND COALESCE(activo,true) AND categoria IS NOT NULL AND categoria<>'' ORDER BY 1 LIMIT 100`),
      marcas: await lista(`SELECT DISTINCT marca AS v FROM productos WHERE negocio_id=$1 AND COALESCE(activo,true) AND marca IS NOT NULL AND marca<>'' ORDER BY 1 LIMIT 200`),
      proveedores: await lista(`SELECT DISTINCT proveedor AS v FROM compras WHERE negocio_id=$1 AND proveedor IS NOT NULL ORDER BY 1 LIMIT 100`),
    });
  } catch (e) { fallo(res, e); }
});

router.post('/simular', auth, async (req, res) => {
  try {
    const modo = req.body && req.body.modo;
    const valor = Number(req.body && req.body.valor);
    if (modo !== 'porcentaje' && modo !== 'margen') throw bad('Elegí cómo cambiar los precios');
    if (!Number.isFinite(valor)) throw bad('Escribí un número');
    if (modo === 'porcentaje' && (valor === 0 || valor < -50 || valor > 100)) throw bad('El porcentaje tiene que estar entre -50 y 100 (y no ser 0)');
    if (modo === 'margen' && (valor < 5 || valor > 80)) throw bad('El margen tiene que estar entre 5% y 80%');
    const f = limpiarFiltro(req.body.filtro);
    const filas = await candidatos(req.user.negocio_id, f, pool);
    const r = calcular(filas, modo, valor);
    res.json({ items: r.items, resumen: { revisados: filas.length, con_cambio: r.items.length, sin_costo: r.sin_costo, ya_cumplen: r.ya_cumplen, tope: filas.length >= MAX_ITEMS } });
  } catch (e) { fallo(res, e); }
});

router.post('/aplicar', auth, async (req, res) => {
  try {
    const items = req.body && req.body.items;
    if (!Array.isArray(items) || !items.length) throw bad('No hay cambios para aplicar');
    if (items.length > MAX_ITEMS) throw bad('Demasiados cambios juntos');
    const lim = items.map((x) => ({ id: Number(x && x.id), precio: Number(x && x.precio_nuevo) }));
    if (lim.some((x) => !Number.isInteger(x.id) || !Number.isFinite(x.precio) || x.precio <= 0 || x.precio > 10000000)) throw bad('Hay un precio inválido');
    const n = req.user.negocio_id;
    const cx = await pool.connect();
    try {
      await cx.query('BEGIN');
      let hechos = 0;
      for (const x of lim) {
        const cur = await cx.query('SELECT precio_venta FROM productos WHERE id=$1 AND negocio_id=$2 AND COALESCE(activo,true) FOR UPDATE', [x.id, n]);
        if (!cur.rows.length) continue;
        const ant = cur.rows[0].precio_venta;
        if (ant != null && parseFloat(ant) === x.precio) continue;
        await cx.query('UPDATE productos SET precio_venta=$3, updated_at=NOW() WHERE id=$1 AND negocio_id=$2', [x.id, n, x.precio]);
        await cx.query(`INSERT INTO productos_historico_precios(producto_id, negocio_id, precio_anterior, precio_nuevo, origen) VALUES($1,$2,$3,$4,'ajuste_masivo')`, [x.id, n, ant, x.precio]);
        hechos++;
      }
      await cx.query('COMMIT');
      res.json({ ok: true, actualizados: hechos });
    } catch (e) { await cx.query('ROLLBACK').catch(() => {}); throw e; }
    finally { cx.release(); }
  } catch (e) { fallo(res, e); }
});

module.exports = router;
module.exports.calcular = calcular;
module.exports.arriba = arriba;
