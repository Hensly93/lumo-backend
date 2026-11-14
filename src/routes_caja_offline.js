// routes_caja_offline.js — La caja sigue vendiendo sin internet.
//
//   GET  /api/caja-offline/catalogo  (turno)  los productos del negocio para guardar en el aparato (nombre, código, precio)
//   POST /api/caja-offline/venta     (turno)  una venta hecha sin internet; se manda cuando vuelve la conexión
//
// Reglas:
//  - Cada venta trae un id propio (uuid): si el aparato la manda dos veces, queda UNA sola.
//  - Los productos tienen que ser del negocio del turno. El precio es el que se le cobró al cliente: si no coincide con el precio
//    de lista de hoy, se anota (precios_distintos) para que el cerebro pueda mirarlo, pero la venta se registra igual.
//  - La fecha es la de la venta real (no la del envío), sin salir del turno: no antes de que abriera ni en el futuro.
//  - Sin internet solo se cobra en efectivo, débito, crédito o transferencia (el QR de Mercado Pago necesita conexión).

const express = require('express');
const router = express.Router();
const pool = require('./db');
const { authTurno } = require('./sesion_empleado');
const { cerrarVenta } = require('./venta_core');

const METODOS = ['efectivo', 'debito', 'credito', 'transferencia'];
const UUID = /^[A-Za-z0-9-]{16,64}$/;

let listo = null;
function asegurar() {
  if (!listo) {
    listo = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS ventas_offline(
        uuid TEXT PRIMARY KEY, negocio_id INTEGER NOT NULL, turno_id INTEGER, transaccion_id INTEGER,
        precios_distintos INTEGER NOT NULL DEFAULT 0, fecha_local TIMESTAMPTZ, creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_ventas_offline_neg ON ventas_offline(negocio_id, creado DESC)');
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

router.get('/catalogo', authTurno, async (req, res) => {
  try {
    await require('./catalogo_marca').asegurar();
    const r = await pool.query(
      `SELECT id, nombre, marca, codigo_barras, precio_venta::float AS precio, unidad
         FROM productos WHERE negocio_id = $1 AND COALESCE(activo, true) = true AND precio_venta IS NOT NULL
        ORDER BY id LIMIT 8000`, [req.turno.negocio_id]);
    // otros códigos de barras de un mismo producto (si el negocio los cargó)
    let alias = [];
    try {
      const a = await pool.query('SELECT codigo, producto_id FROM producto_codigos WHERE negocio_id = $1 LIMIT 20000', [req.turno.negocio_id]);
      alias = a.rows;
    } catch (e) { /* la tabla puede no existir todavía */ }
    res.json({ productos: r.rows, codigos_extra: alias, generado: new Date().toISOString() });
  } catch (e) {
    console.error('[CAJA-OFFLINE] catalogo:', e.message);
    res.status(500).json({ error: 'No se pudo preparar el catálogo' });
  }
});

router.post('/venta', authTurno, async (req, res) => {
  const b = req.body || {};
  const uuid = String(b.uuid || '');
  const metodo = String(b.metodo_pago || '');
  if (!UUID.test(uuid)) return res.status(400).json({ error: 'Falta el id de la venta' });
  if (!METODOS.includes(metodo)) return res.status(400).json({ error: 'Medio de pago no válido para una venta sin internet' });
  const crudos = Array.isArray(b.items) ? b.items : [];
  if (!crudos.length || crudos.length > 100) return res.status(400).json({ error: 'La venta no tiene productos' });
  const items = [];
  for (const i of crudos) {
    const producto_id = parseInt(i && i.producto_id, 10);
    const cantidad = Number(i && i.cantidad);
    const precio_unitario = Number(i && i.precio_unitario);
    if (!producto_id || !(cantidad > 0 && cantidad <= 10000) || !(precio_unitario >= 0 && precio_unitario <= 1e8)) {
      return res.status(400).json({ error: 'Hay un producto con datos inválidos' });
    }
    items.push({ producto_id, cantidad, precio_unitario });
  }
  const client = await pool.connect();
  try {
    await asegurar();
    await require('./catalogo_marca').asegurar();
    try { await require('./stock').asegurar(); } catch (e) { console.error('stock/asegurar:', e.message); }
    const t = req.turno;
    await client.query('BEGIN');
    const ins = await client.query(
      'INSERT INTO ventas_offline(uuid, negocio_id, turno_id) VALUES($1,$2,$3) ON CONFLICT (uuid) DO NOTHING RETURNING uuid', [uuid, t.negocio_id, t.id]);
    if (!ins.rows.length) {
      const ya = await client.query('SELECT negocio_id, transaccion_id FROM ventas_offline WHERE uuid=$1', [uuid]);
      await client.query('COMMIT');
      if (!ya.rows[0] || ya.rows[0].negocio_id !== t.negocio_id) return res.status(409).json({ error: 'Esa venta ya existe' });
      return res.json({ ok: true, duplicada: true, transaccion_id: ya.rows[0].transaccion_id });
    }
    const ids = [...new Set(items.map((i) => i.producto_id))];
    const ps = await client.query('SELECT id, precio_venta::float AS precio FROM productos WHERE id = ANY($1::int[]) AND negocio_id = $2', [ids, t.negocio_id]);
    if (ps.rows.length !== ids.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Hay un producto que no es de este negocio' }); }
    const lista = new Map(ps.rows.map((p) => [p.id, p.precio]));
    const distintos = items.filter((i) => Math.abs((lista.get(i.producto_id) || 0) - i.precio_unitario) > 0.009).length;
    // fecha real de la venta, dentro del turno
    let fecha = null;
    const f = Date.parse(b.fecha);
    if (!isNaN(f)) {
      const a = await client.query('SELECT EXTRACT(EPOCH FROM hora_apertura)*1000 AS ms FROM turnos_caja WHERE id=$1', [t.id]);
      const ap = a.rows[0] ? Number(a.rows[0].ms) : f;
      fecha = new Date(Math.min(Date.now(), Math.max(f, ap || f))).toISOString();
    }
    const v = await cerrarVenta(client, t.id, metodo, { items, fecha });
    await client.query('UPDATE ventas_offline SET transaccion_id=$2, precios_distintos=$3, fecha_local=$4 WHERE uuid=$1', [uuid, v.transaccion_id, distintos, fecha]);
    await client.query('COMMIT');
    res.json({ ok: true, transaccion_id: v.transaccion_id, monto_total: v.monto_total, precios_distintos: distintos });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (x) { /* nada */ }
    console.error('[CAJA-OFFLINE] venta:', e.message);
    res.status(500).json({ error: 'No se pudo registrar la venta' });
  } finally {
    client.release();
  }
});

module.exports = router;
