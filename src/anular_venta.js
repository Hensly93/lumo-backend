// anular_venta.js — anular una venta (o devolverla) desde la caja (14/11/2026).
// No se borra nada: se agrega una transacción "anulacion" con el monto en negativo, el mismo medio de pago
// y el mismo turno. Así todas las sumas de LumoBi (ventas del día, caja esperada, productos, períodos)
// quedan bien solas, y la venta original sigue guardada para ver qué pasó.
// El stock vuelve a sumar lo que se había descontado.
// Anular es libre mientras sea lo habitual; si es grande, vieja o se repite, pide autorización del dueño
// (mismo sistema que sacar productos del carrito o bajar precios: autorizacion_caja.js).
const pool = require('./db');

let listo = null;
function asegurar(db = pool) {
  if (!listo) {
    listo = (async () => {
      await db.query(`ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS anula_id INTEGER`);
      await db.query(`ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS motivo TEXT`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_transacciones_anula ON transacciones(anula_id) WHERE anula_id IS NOT NULL`);
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

// Ventas del turno que todavía se pueden anular (las más nuevas primero)
async function ventasDelTurno(turnoId, db = pool) {
  await asegurar(db);
  const r = await db.query(
    `SELECT t.id, t.monto::float AS monto, t.metodo_pago, to_char(t.fecha - INTERVAL '3 hours','HH24:MI') AS hora,
            (SELECT string_agg(COALESCE(p.nombre, d.producto_nombre, 'Producto') || CASE WHEN d.cantidad <> 1 THEN ' x' || trim(to_char(d.cantidad,'FM999990.###')) ELSE '' END, ', ')
               FROM transacciones_detalle d LEFT JOIN productos p ON p.id = d.producto_id WHERE d.transaccion_id = t.id) AS items,
            EXISTS (SELECT 1 FROM transacciones a WHERE a.anula_id = t.id) AS anulada
       FROM transacciones t
      WHERE t.turno_id = $1 AND t.tipo = 'venta'
      ORDER BY t.fecha DESC LIMIT 20`, [turnoId]);
  return r.rows;
}

// Lo que necesita autorizacion_caja para decidir si pedir permiso
async function datosParaGuardia(turno, transaccionId, db = pool) {
  await asegurar(db);
  const r = await db.query(
    `SELECT t.id, t.monto::float AS monto, EXTRACT(EPOCH FROM (NOW() - t.fecha))/60 AS minutos,
            EXISTS (SELECT 1 FROM transacciones a WHERE a.anula_id = t.id) AS anulada
       FROM transacciones t WHERE t.id = $1 AND t.turno_id = $2 AND t.tipo = 'venta'`, [transaccionId, turno.id]);
  return r.rows[0] || null;
}

async function anular(turno, transaccionId, motivo, db = pool) {
  await asegurar(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(
      `SELECT * FROM transacciones WHERE id = $1 AND turno_id = $2 AND tipo = 'venta' FOR UPDATE`, [transaccionId, turno.id])).rows[0];
    if (!o) { await client.query('ROLLBACK'); return { ok: false, error: 'Esa venta no es de este turno.' }; }
    const ya = await client.query(`SELECT 1 FROM transacciones WHERE anula_id = $1`, [o.id]);
    if (ya.rows.length) { await client.query('ROLLBACK'); return { ok: false, error: 'Esa venta ya estaba anulada.' }; }

    const nueva = (await client.query(
      `INSERT INTO transacciones (negocio_id, monto, tipo, empleado, turno, metodo_pago, sucursal_id, fecha, turno_id, anula_id, motivo)
       VALUES ($1, $2, 'anulacion', $3, $4, $5, $6, NOW(), $7, $8, $9) RETURNING id`,
      [o.negocio_id, -Number(o.monto), o.empleado, o.turno, o.metodo_pago, o.sucursal_id, turno.id, o.id, motivo || null])).rows[0];

    // El detalle también en negativo: así "lo que más se vende" y la ganancia por producto descuentan la anulación
    const det = (await client.query(`SELECT * FROM transacciones_detalle WHERE transaccion_id = $1`, [o.id])).rows;
    for (const d of det) {
      await client.query(
        `INSERT INTO transacciones_detalle (transaccion_id, producto_id, cantidad, precio_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5)`,
        [nueva.id, d.producto_id, -Number(d.cantidad), d.precio_unitario, -Number(d.subtotal)]);
    }
    await client.query(
      `UPDATE transacciones_detalle n SET producto_nombre = o.producto_nombre, producto_marca = o.producto_marca, costo_unitario = o.costo_unitario
         FROM transacciones_detalle o WHERE n.transaccion_id = $1 AND o.transaccion_id = $2 AND o.producto_id IS NOT DISTINCT FROM n.producto_id`,
      [nueva.id, o.id]).catch(() => {});

    // El stock vuelve
    const S = require('./stock');
    await S.conSavepoint(client, 'stock_anulacion', async () => {
      const juntos = new Map();
      for (const d of det) if (d.producto_id) juntos.set(d.producto_id, (juntos.get(d.producto_id) || 0) + Number(d.cantidad));
      for (const [productoId, cant] of juntos) {
        await S.mover(client, { negocioId: o.negocio_id, productoId, tipo: 'anulacion', cantidad: cant, refId: nueva.id, origen: 'caja', empleado: turno.nombre_empleado });
      }
    });
    await client.query('COMMIT');

    require('./registro_hechos').registrar({
      negocio_id: o.negocio_id, turno_id: turno.id, empleado: turno.nombre_empleado, tipo: 'venta_anulada',
      valor: Number(o.monto), detalle: { transaccion_id: o.id, metodo_pago: o.metodo_pago, motivo: motivo || null },
    }).catch(() => {});
    return { ok: true, anulacion_id: nueva.id, monto: Number(o.monto), metodo_pago: o.metodo_pago };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

module.exports = { asegurar, ventasDelTurno, datosParaGuardia, anular };
