// routes_mp_cobro.js — Cobro con QR de Mercado Pago desde la caja de LumoBi (monto exacto, la venta se cierra sola).
//
//   GET  /api/mp-cobro/disponible   (turno)  ¿el negocio tiene Mercado Pago conectado?
//   POST /api/mp-cobro/qr           (turno)  crea la orden en Mercado Pago con el total del carrito y devuelve el QR
//   GET  /api/mp-cobro/estado/:id   (turno)  mira si ya pagó (y si pagó, cierra la venta)
//   POST /api/mp-cobro/cancelar/:id (turno)  cancela la orden si todavía no se pagó
//   POST /api/mp-cobro/webhook      (lo llama Mercado Pago) avisa que una orden cambió; no se confía en el aviso: se vuelve a preguntar
//
// Reglas:
//  - La venta se cierra UNA sola vez aunque lleguen el aviso y la consulta de la caja a la vez (la fila del cobro se bloquea).
//  - Si Mercado Pago cobró pero la venta ya no se puede cerrar (carrito vacío, turno cerrado) queda "pagado_sin_venta":
//    la plata entró, y la sincronización de pagos la va a mostrar como cobro sin venta.
//  - Nunca se escribe un token en los logs.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('./db');
const { authTurno } = require('./sesion_empleado');
const { tokenVigente } = require('./mp_sync');
const { cerrarVenta } = require('./venta_core');

const MP = 'https://api.mercadopago.com';
const ESPERA = 'PT10M';   // vigencia del QR

let listo = null;
function asegurar() {
  if (!listo) {
    listo = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS mp_cajas(
        id SERIAL PRIMARY KEY, negocio_id INTEGER NOT NULL, sucursal_id INTEGER,
        store_id TEXT, external_store_id TEXT NOT NULL, pos_id TEXT, external_pos_id TEXT NOT NULL,
        creado TIMESTAMP DEFAULT NOW())`);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_mp_cajas_neg_suc ON mp_cajas(negocio_id, COALESCE(sucursal_id, 0))');
      await pool.query(`CREATE TABLE IF NOT EXISTS cobros_mp(
        id SERIAL PRIMARY KEY, negocio_id INTEGER NOT NULL, turno_id INTEGER, sucursal_id INTEGER,
        order_id TEXT, ref TEXT, monto NUMERIC(14,2) NOT NULL, estado TEXT NOT NULL DEFAULT 'esperando',
        transaccion_id INTEGER, mp_payment_id BIGINT, metodo TEXT, detalle TEXT,
        creado TIMESTAMP DEFAULT NOW(), actualizado TIMESTAMP DEFAULT NOW())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_cobros_mp_order ON cobros_mp(order_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_cobros_mp_turno ON cobros_mp(turno_id, estado)');
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

async function mp(token, metodo, ruta, cuerpo, idem) {
  const h = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  if (idem) h['X-Idempotency-Key'] = idem;
  const r = await fetch(MP + ruta, { method: metodo, headers: h, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}

async function conexion(negocioId) {
  const r = await pool.query('SELECT * FROM integraciones_mp WHERE negocio_id=$1 ORDER BY id DESC LIMIT 1', [negocioId]);
  return r.rows[0] || null;
}

// Crea (una sola vez por local) la sucursal y la caja en la cuenta de Mercado Pago del negocio.
async function asegurarCaja(negocioId, sucursalId, fila, token) {
  const ya = await pool.query('SELECT * FROM mp_cajas WHERE negocio_id=$1 AND COALESCE(sucursal_id,0)=$2', [negocioId, sucursalId || 0]);
  if (ya.rows[0]) return ya.rows[0];
  const uid = fila.mp_user_id;
  if (!uid) throw new Error('Falta el usuario de Mercado Pago. Volvé a conectar la cuenta desde Ajustes.');
  const extStore = 'LUMO' + negocioId + 'S' + (sucursalId || 0);
  const extPos = extStore + 'C1';

  let storeId = null;
  const bus = await mp(token, 'GET', '/users/' + uid + '/stores/search?external_id=' + encodeURIComponent(extStore));
  if (bus.ok && bus.j && Array.isArray(bus.j.results) && bus.j.results[0]) storeId = String(bus.j.results[0].id);
  if (!storeId) {
    let suc = null;
    if (sucursalId) suc = (await pool.query('SELECT * FROM mis_sucursales WHERE id=$1 AND negocio_id=$2', [sucursalId, negocioId])).rows[0] || null;
    const dir = String((suc && suc.direccion) || '').trim();
    const m = dir.match(/^(.*?)(\d+)/);
    const calle = ((m ? m[1] : dir) || 'Sin calle').replace(/[,.]+\s*$/, '').trim().slice(0, 100) || 'Sin calle';
    const num = m ? m[2] : 's/n';
    const lat = Number(suc && (suc.latitud != null ? suc.latitud : suc.lat));
    const lng = Number(suc && (suc.longitud != null ? suc.longitud : (suc.lng != null ? suc.lng : suc.lon)));
    const cr = await mp(token, 'POST', '/users/' + uid + '/stores', {
      name: ((suc && suc.nombre) || 'Local') .slice(0, 60),
      external_id: extStore,
      location: {
        street_number: String(num), street_name: calle, city_name: 'Buenos Aires', state_name: 'Buenos Aires',
        latitude: isFinite(lat) && lat ? lat : -34.6037, longitude: isFinite(lng) && lng ? lng : -58.3816,
        reference: 'LumoBi',
      },
    });
    if (!cr.ok || !cr.j || !cr.j.id) {
      console.error('[MP-COBRO] crear sucursal:', cr.status, JSON.stringify(cr.j).slice(0, 300));
      throw new Error('Mercado Pago no nos dejó crear la sucursal (' + cr.status + '). ' + String((cr.j && cr.j.message) || '').slice(0, 120));
    }
    storeId = String(cr.j.id);
  }

  let posId = null;
  const pb = await mp(token, 'GET', '/pos?external_id=' + encodeURIComponent(extPos));
  if (pb.ok && pb.j && Array.isArray(pb.j.results) && pb.j.results[0]) posId = String(pb.j.results[0].id);
  if (!posId) {
    let pc = await mp(token, 'POST', '/pos', {
      name: 'Caja LumoBi', fixed_amount: true, store_id: Number(storeId), external_store_id: extStore, external_id: extPos, category: 621102,
    });
    if (!pc.ok && pc.status !== 409) {
      // la API vieja de cajas puede no estar disponible: se prueba la nueva
      pc = await mp(token, 'POST', '/v2/pos', {
        name: 'Caja LumoBi', store_id: storeId, external_store_id: extStore, external_id: extPos, config: { qr: { operating_mode: 'pdv' } },
      }, crypto.randomUUID());
    }
    if (pc.ok && pc.j && pc.j.id) posId = String(pc.j.id);
    else if (pc.status !== 409) {
      console.error('[MP-COBRO] crear caja:', pc.status, JSON.stringify(pc.j).slice(0, 300));
      throw new Error('Mercado Pago no nos dejó crear la caja (' + pc.status + '). ' + String((pc.j && pc.j.message) || '').slice(0, 120));
    }
  }
  await pool.query(
    `INSERT INTO mp_cajas(negocio_id, sucursal_id, store_id, external_store_id, pos_id, external_pos_id)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [negocioId, sucursalId || null, storeId, extStore, posId, extPos]);
  return { store_id: storeId, external_store_id: extStore, pos_id: posId, external_pos_id: extPos };
}

const redondear = (n) => Math.round(Number(n) * 100) / 100;

// Cierra la venta del carrito con lo que confirmó Mercado Pago. Segura ante avisos repetidos.
async function finalizar(cobroId, orden) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const l = await client.query('SELECT * FROM cobros_mp WHERE id=$1 FOR UPDATE', [cobroId]);
    const c = l.rows[0];
    if (!c || c.estado !== 'esperando') { await client.query('COMMIT'); return c || null; }
    const pago = (orden.transactions && orden.transactions.payments && orden.transactions.payments[0]) || {};
    const tipo = pago.payment_method && pago.payment_method.type;
    const metodo = tipo === 'credit_card' ? 'credito' : tipo === 'debit_card' ? 'debito' : 'qr';
    const payId = /^\d{1,18}$/.test(String(pago.id || '')) ? String(pago.id) : null;
    let v = null, nota = null;
    await client.query('SAVEPOINT venta');
    try {
      v = await cerrarVenta(client, c.turno_id, metodo, { mp_payment_id: payId });
      if (Math.abs(v.monto_total - Number(c.monto)) > 0.5) nota = 'El carrito cambió: el cliente pagó ' + c.monto + ' y la venta quedó en ' + v.monto_total + '.';
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT venta');
      nota = String(e.message || e).slice(0, 200);
    }
    const estado = v ? 'pagado' : 'pagado_sin_venta';
    await client.query(
      `UPDATE cobros_mp SET estado=$2, transaccion_id=$3, mp_payment_id=$4, metodo=$5, detalle=$6, actualizado=NOW() WHERE id=$1`,
      [cobroId, estado, v ? v.transaccion_id : null, payId, metodo, nota || (pago.id ? 'pago ' + pago.id : null)]);
    await client.query('COMMIT');
    if (!v) console.error('[MP-COBRO] cobro', cobroId, 'cobrado en MP pero la venta no se pudo cerrar:', nota);
    return Object.assign({}, c, { estado, transaccion_id: v ? v.transaccion_id : null, detalle: nota });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (x) { /* nada */ }
    console.error('[MP-COBRO] finalizar:', e.message);
    return null;
  } finally {
    client.release();
  }
}

// Vuelve a preguntarle a Mercado Pago por la orden y deja el cobro como corresponde.
async function revisar(cobroId) {
  const r = await pool.query('SELECT * FROM cobros_mp WHERE id=$1', [cobroId]);
  const c = r.rows[0];
  if (!c || c.estado !== 'esperando' || !c.order_id) return c || null;
  try {
    const fila = await conexion(c.negocio_id);
    if (!fila) return c;
    const token = await tokenVigente(pool, fila, {});
    const o = await mp(token, 'GET', '/v1/orders/' + encodeURIComponent(c.order_id));
    if (!o.ok) return c;
    if (o.j.external_reference && o.j.external_reference !== c.ref) return c;   // no es la nuestra
    if (o.j.status === 'processed') return (await finalizar(c.id, o.j)) || c;
    if (o.j.status === 'canceled' || o.j.status === 'expired') {
      const est = o.j.status === 'expired' ? 'vencido' : 'cancelado';
      await pool.query("UPDATE cobros_mp SET estado=$2, actualizado=NOW() WHERE id=$1 AND estado='esperando'", [c.id, est]);
      return Object.assign({}, c, { estado: est });
    }
  } catch (e) {
    console.error('[MP-COBRO] revisar:', e.message);
  }
  return c;
}

async function cancelarEnMP(c) {
  try {
    const fila = await conexion(c.negocio_id);
    if (!fila || !c.order_id) return;
    const token = await tokenVigente(pool, fila, {});
    await mp(token, 'POST', '/v1/orders/' + encodeURIComponent(c.order_id) + '/cancel', null, crypto.randomUUID());
  } catch (e) { console.error('[MP-COBRO] cancelar:', e.message); }
}

router.get('/disponible', authTurno, async (req, res) => {
  try {
    const fila = await conexion(req.turno.negocio_id);
    res.json({ disponible: !!(fila && fila.mp_user_id) });
  } catch (e) { res.json({ disponible: false }); }
});

router.post('/qr', authTurno, async (req, res) => {
  try {
    await asegurar();
    const t = req.turno;
    const fila = await conexion(t.negocio_id);
    if (!fila) return res.status(400).json({ error: 'Mercado Pago no está conectado. El dueño lo conecta desde Ajustes.' });
    const car = await pool.query(
      `SELECT ci.cantidad::float AS cantidad, ci.precio_unitario::float AS precio, COALESCE(p.nombre, 'Producto') AS nombre
         FROM carrito_items ci LEFT JOIN productos p ON p.id = ci.producto_id WHERE ci.turno_id=$1`, [t.id]);
    if (!car.rows.length) return res.status(400).json({ error: 'El carrito está vacío.' });
    const total = redondear(car.rows.reduce((s, i) => s + i.cantidad * i.precio, 0));
    if (!(total > 0)) return res.status(400).json({ error: 'El total tiene que ser mayor a cero.' });
    // el detalle viaja a Mercado Pago solo si cierra exacto; si no, va como una sola línea
    const limpio = car.rows.every((i) => Number.isInteger(i.cantidad) && Math.abs(i.precio * 100 - Math.round(i.precio * 100)) < 1e-6);
    const items = limpio && redondear(car.rows.reduce((s, i) => s + i.cantidad * i.precio, 0)) === total
      ? car.rows.map((i) => ({ title: String(i.nombre).slice(0, 150), unit_price: i.precio.toFixed(2), quantity: i.cantidad, unit_measure: 'unit' }))
      : [{ title: 'Compra', unit_price: total.toFixed(2), quantity: 1, unit_measure: 'unit' }];

    // un solo QR abierto por caja: si había otro esperando, se cancela
    const prev = await pool.query("SELECT * FROM cobros_mp WHERE turno_id=$1 AND estado='esperando'", [t.id]);
    for (const p of prev.rows) {
      const rr = await revisar(p.id);
      if (rr && rr.estado === 'esperando') { await cancelarEnMP(p); await pool.query("UPDATE cobros_mp SET estado='cancelado', actualizado=NOW() WHERE id=$1 AND estado='esperando'", [p.id]); }
    }

    const token = await tokenVigente(pool, fila, {});
    const caja = await asegurarCaja(t.negocio_id, t.sucursal_id, fila, token);
    const ref = 'L' + t.id + '-' + crypto.randomBytes(5).toString('hex');
    const o = await mp(token, 'POST', '/v1/orders', {
      type: 'qr', external_reference: ref, total_amount: total.toFixed(2), description: 'Compra en el local',
      expiration_time: ESPERA,
      config: { qr: { external_pos_id: caja.external_pos_id, mode: 'dynamic' } },
      transactions: { payments: [{ amount: total.toFixed(2) }] },
      items,
    }, crypto.randomUUID());
    const qr = o.j && o.j.type_response && o.j.type_response.qr_data;
    if (!o.ok || !qr || !o.j.id) {
      console.error('[MP-COBRO] crear orden:', o.status, JSON.stringify(o.j).slice(0, 400));
      return res.status(502).json({ error: 'Mercado Pago no pudo generar el QR (' + o.status + '). Cobrá con otro medio y avisale al dueño.' });
    }
    const ins = await pool.query(
      `INSERT INTO cobros_mp(negocio_id, turno_id, sucursal_id, order_id, ref, monto) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [t.negocio_id, t.id, t.sucursal_id || null, o.j.id, ref, total]);
    res.json({ cobro_id: ins.rows[0].id, qr, monto: total });
  } catch (e) {
    console.error('[MP-COBRO] qr:', e.message);
    res.status(500).json({ error: e.message && e.message.startsWith('Mercado Pago') ? e.message : 'No se pudo generar el QR. Probá de nuevo.' });
  }
});

async function delTurno(req, id) {
  const r = await pool.query('SELECT * FROM cobros_mp WHERE id=$1 AND negocio_id=$2 AND turno_id=$3', [id, req.turno.negocio_id, req.turno.id]);
  return r.rows[0] || null;
}

router.get('/estado/:id', authTurno, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || !(await delTurno(req, id))) return res.status(404).json({ error: 'No encontrado' });
    const c = await revisar(id);
    res.json({ estado: c.estado, transaccion_id: c.transaccion_id || null, monto: Number(c.monto) });
  } catch (e) { res.status(500).json({ error: 'No se pudo consultar el cobro' }); }
});

router.post('/cancelar/:id', authTurno, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const c0 = id ? await delTurno(req, id) : null;
    if (!c0) return res.status(404).json({ error: 'No encontrado' });
    let c = await revisar(id);
    if (c.estado === 'esperando') {
      await cancelarEnMP(c0);
      c = await revisar(id);
      if (c.estado === 'esperando') {
        await pool.query("UPDATE cobros_mp SET estado='cancelado', actualizado=NOW() WHERE id=$1 AND estado='esperando'", [id]);
        c = Object.assign({}, c, { estado: 'cancelado' });
      }
    }
    res.json({ estado: c.estado, transaccion_id: c.transaccion_id || null });
  } catch (e) { res.status(500).json({ error: 'No se pudo cancelar' }); }
});

// Mercado Pago avisa que una orden cambió. El aviso solo dice "mirá esta orden": todo lo demás se pregunta de nuevo con el token del negocio.
router.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    await asegurar();
    const q = req.query || {}, b = req.body || {};
    const id = String((b.data && b.data.id) || q['data.id'] || q.id || b.id || '');
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return;
    const r = await pool.query("SELECT id FROM cobros_mp WHERE order_id=$1 AND estado='esperando'", [id]);
    for (const f of r.rows) await revisar(f.id);
  } catch (e) { console.error('[MP-COBRO] webhook:', e.message); }
});

module.exports = router;
