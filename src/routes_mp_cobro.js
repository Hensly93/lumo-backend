// routes_mp_cobro.js — Cobro con QR de Mercado Pago desde la caja de LumoBi (monto exacto, la venta se cierra sola).
//
//   GET  /api/mp-cobro/disponible   (turno)  ¿el negocio tiene Mercado Pago conectado?
//   POST /api/mp-cobro/qr           (turno)  crea la orden en Mercado Pago con el total del carrito y devuelve el QR
//   GET  /api/mp-cobro/estado/:id   (turno)  mira si ya pagó (y si pagó, cierra la venta)
//   POST /api/mp-cobro/cancelar/:id (turno)  cancela la orden si todavía no se pagó
//   GET  /api/mp-cobro/terminales   (turno)  los posnets Point de la cuenta de Mercado Pago y cuál usa este local
//   POST /api/mp-cobro/terminal     (turno)  elige el posnet del local (y lo pasa a modo integrado si hace falta)
//   POST /api/mp-cobro/point        (turno)  manda el total del carrito al posnet (débito o crédito); la venta se cierra sola cuando el cliente paga
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
      await pool.query("ALTER TABLE cobros_mp ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'qr'");
      await pool.query(`CREATE TABLE IF NOT EXISTS mp_terminales(
        id SERIAL PRIMARY KEY, negocio_id INTEGER NOT NULL, sucursal_id INTEGER, terminal_id TEXT NOT NULL, actualizado TIMESTAMP DEFAULT NOW())`);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_mp_term_neg_suc ON mp_terminales(negocio_id, COALESCE(sucursal_id, 0))');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_cobros_mp_order ON cobros_mp(order_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_cobros_mp_turno ON cobros_mp(turno_id, estado)');
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

async function mp(token, metodo, ruta, cuerpo, idem, extra) {
  const h = Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, extra || {});
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
    // en las órdenes de posnet el id del pago de Mercado Pago viene en reference_id (el "id" es PAY0…)
    const payId = [pago.reference_id, pago.id].map((x) => String(x || '')).find((x) => /^\d{1,18}$/.test(x)) || null;
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
    if (o.j.status === 'canceled' || o.j.status === 'expired' || o.j.status === 'failed') {
      const est = o.j.status === 'expired' ? 'vencido' : o.j.status === 'failed' ? 'rechazado' : 'cancelado';
      await pool.query("UPDATE cobros_mp SET estado=$2, actualizado=NOW() WHERE id=$1 AND estado='esperando'", [c.id, est]);
      return Object.assign({}, c, { estado: est });
    }
  } catch (e) {
    console.error('[MP-COBRO] revisar:', e.message);
  }
  return c;
}

// Pide cancelar la orden. En el posnet, si ya la tiene en pantalla, Mercado Pago contesta 202 y se confirma después (hay que cancelarla también ahí).
async function cancelarEnMP(c) {
  try {
    const fila = await conexion(c.negocio_id);
    if (!fila || !c.order_id) return 0;
    const token = await tokenVigente(pool, fila, {});
    const extra = c.tipo === 'point' ? { 'x-allow-cancelable-status': 'at_terminal' } : null;
    const r = await mp(token, 'POST', '/v1/orders/' + encodeURIComponent(c.order_id) + '/cancel', null, crypto.randomUUID(), extra);
    return r.status;
  } catch (e) { console.error('[MP-COBRO] cancelar:', e.message); return 0; }
}

// Cancela los cobros que quedaron esperando en este turno. false si alguno sigue vivo en el posnet (hay que cancelarlo ahí).
async function cerrarPrevios(t) {
  const prev = await pool.query("SELECT * FROM cobros_mp WHERE turno_id=$1 AND estado='esperando'", [t.id]);
  let libre = true;
  for (const p of prev.rows) {
    const rr = await revisar(p.id);
    if (rr && rr.estado === 'esperando') {
      const st = await cancelarEnMP(p);
      const r2 = await revisar(p.id);
      if (r2 && r2.estado === 'esperando') {
        if (p.tipo === 'point' && st === 202) { libre = false; continue; }
        await pool.query("UPDATE cobros_mp SET estado='cancelado', actualizado=NOW() WHERE id=$1 AND estado='esperando'", [p.id]);
      }
    }
  }
  return libre;
}

router.get('/disponible', authTurno, async (req, res) => {
  try {
    await asegurar();
    const fila = await conexion(req.turno.negocio_id);
    const t = await pool.query('SELECT terminal_id FROM mp_terminales WHERE negocio_id=$1 AND COALESCE(sucursal_id,0)=$2', [req.turno.negocio_id, req.turno.sucursal_id || 0]);
    res.json({ disponible: !!(fila && fila.mp_user_id), terminal_id: t.rows[0] ? t.rows[0].terminal_id : null });
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

    // un solo cobro abierto por caja: si había otro esperando, se cancela
    const libre = await cerrarPrevios(t);
    if (!libre) return res.status(409).json({ error: 'Hay un cobro abierto en el posnet. Cancelalo ahí y probá de nuevo.' });

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
      const st = await cancelarEnMP(c0);
      c = await revisar(id);
      if (c.estado === 'esperando' && c0.tipo === 'point' && st === 202) {
        return res.json({ estado: 'esperando', cancelando: true, transaccion_id: null });   // el posnet ya la tiene: se confirma cuando la cancelen ahí
      }
      if (c.estado === 'esperando') {
        await pool.query("UPDATE cobros_mp SET estado='cancelado', actualizado=NOW() WHERE id=$1 AND estado='esperando'", [id]);
        c = Object.assign({}, c, { estado: 'cancelado' });
      }
    }
    res.json({ estado: c.estado, transaccion_id: c.transaccion_id || null });
  } catch (e) { res.status(500).json({ error: 'No se pudo cancelar' }); }
});


// ───────── Posnet Mercado Pago Point ─────────

const nombreTerminal = (id) => {
  const m = String(id || '').match(/^([A-Z0-9]+(?:_[A-Z0-9]+)*?)__(.+)$/);
  return m ? m[1].replace(/_/g, ' ') + ' · n° ' + m[2] : String(id || '');
};

async function listarTerminales(token) {
  const r = await mp(token, 'GET', '/terminals/v1/list?limit=50&offset=0');
  if (!r.ok) {
    console.error('[MP-COBRO] terminales:', r.status, JSON.stringify(r.j).slice(0, 300));
    throw new Error('Mercado Pago no nos dejó ver tus posnets (' + r.status + '). Reconectá la cuenta desde Ajustes.');
  }
  const arr = (r.j && r.j.data && r.j.data.terminals) || (r.j && r.j.terminals) || [];
  return arr.map((x) => ({ id: String(x.id), nombre: nombreTerminal(x.id), modo: x.operating_mode || null }));
}

router.get('/terminales', authTurno, async (req, res) => {
  try {
    await asegurar();
    const t = req.turno;
    const fila = await conexion(t.negocio_id);
    if (!fila) return res.status(400).json({ error: 'Mercado Pago no está conectado. El dueño lo conecta desde Ajustes.' });
    const token = await tokenVigente(pool, fila, {});
    const lista = await listarTerminales(token);
    const sel = await pool.query('SELECT terminal_id FROM mp_terminales WHERE negocio_id=$1 AND COALESCE(sucursal_id,0)=$2', [t.negocio_id, t.sucursal_id || 0]);
    res.json({ terminales: lista, elegido: sel.rows[0] ? sel.rows[0].terminal_id : null });
  } catch (e) {
    res.status(500).json({ error: e.message && e.message.startsWith('Mercado Pago') ? e.message : 'No se pudieron leer los posnets.' });
  }
});

// Elige el posnet del local y lo deja en modo integrado (PDV), que es el que recibe cobros desde LumoBi.
router.post('/terminal', authTurno, async (req, res) => {
  try {
    await asegurar();
    const t = req.turno;
    const id = String((req.body && req.body.terminal_id) || '');
    if (!/^[A-Za-z0-9_]{6,80}$/.test(id)) return res.status(400).json({ error: 'Posnet no válido' });
    const fila = await conexion(t.negocio_id);
    if (!fila) return res.status(400).json({ error: 'Mercado Pago no está conectado.' });
    const token = await tokenVigente(pool, fila, {});
    const lista = await listarTerminales(token);
    const term = lista.find((x) => x.id === id);
    if (!term) return res.status(404).json({ error: 'Ese posnet no está en tu cuenta de Mercado Pago.' });
    let aviso = null;
    if (term.modo !== 'PDV') {
      const r = await mp(token, 'PATCH', '/terminals/v1/setup', { terminals: [{ id, operating_mode: 'PDV' }] });
      if (!r.ok) {
        console.error('[MP-COBRO] modo PDV:', r.status, JSON.stringify(r.j).slice(0, 300));
        const cod = r.j && (r.j.error || r.j.message);
        aviso = cod === 'store_pos_not_found' || r.status === 403
          ? 'Hay que asignar el posnet a una sucursal y caja en la app de Mercado Pago (Tu negocio → Sucursales y cajas) y volver a elegirlo.'
          : 'Mercado Pago no pudo pasar el posnet a modo integrado (' + r.status + ').';
        return res.status(502).json({ error: aviso });
      }
    }
    await pool.query(
      `INSERT INTO mp_terminales(negocio_id, sucursal_id, terminal_id) VALUES($1,$2,$3)
       ON CONFLICT (negocio_id, COALESCE(sucursal_id, 0)) DO UPDATE SET terminal_id=EXCLUDED.terminal_id, actualizado=NOW()`,
      [t.negocio_id, t.sucursal_id || null, id]);
    res.json({ ok: true, terminal_id: id });
  } catch (e) {
    res.status(500).json({ error: e.message && e.message.startsWith('Mercado Pago') ? e.message : 'No se pudo elegir el posnet.' });
  }
});

// Manda el total del carrito al posnet. tipo: 'debito' | 'credito'. Cuando el cliente paga, Mercado Pago lo marca procesado y la venta se cierra sola.
router.post('/point', authTurno, async (req, res) => {
  try {
    await asegurar();
    const t = req.turno;
    const tipo = req.body && req.body.tipo === 'debito' ? 'debit_card' : req.body && req.body.tipo === 'credito' ? 'credit_card' : null;
    if (!tipo) return res.status(400).json({ error: 'Elegí débito o crédito.' });
    const fila = await conexion(t.negocio_id);
    if (!fila) return res.status(400).json({ error: 'Mercado Pago no está conectado. El dueño lo conecta desde Ajustes.' });
    const sel = await pool.query('SELECT terminal_id FROM mp_terminales WHERE negocio_id=$1 AND COALESCE(sucursal_id,0)=$2', [t.negocio_id, t.sucursal_id || 0]);
    if (!sel.rows[0]) return res.status(409).json({ error: 'Primero elegí el posnet de este local.', falta_terminal: true });
    const car = await pool.query('SELECT cantidad::float AS cantidad, precio_unitario::float AS precio FROM carrito_items WHERE turno_id=$1', [t.id]);
    if (!car.rows.length) return res.status(400).json({ error: 'El carrito está vacío.' });
    const total = redondear(car.rows.reduce((s, i) => s + i.cantidad * i.precio, 0));
    if (!(total > 0)) return res.status(400).json({ error: 'El total tiene que ser mayor a cero.' });
    const libre = await cerrarPrevios(t);
    if (!libre) return res.status(409).json({ error: 'Hay un cobro abierto en el posnet. Cancelalo ahí y probá de nuevo.' });
    const token = await tokenVigente(pool, fila, {});
    const ref = 'L' + t.id + '-' + crypto.randomBytes(5).toString('hex');
    const o = await mp(token, 'POST', '/v1/orders', {
      type: 'point', external_reference: ref, description: 'Compra en el local', expiration_time: ESPERA,
      transactions: { payments: [{ amount: total.toFixed(2) }] },
      config: { point: { terminal_id: sel.rows[0].terminal_id, print_on_terminal: 'no_ticket' }, payment_method: { default_type: tipo } },
    }, crypto.randomUUID());
    if (!o.ok || !o.j || !o.j.id) {
      console.error('[MP-COBRO] orden point:', o.status, JSON.stringify(o.j).slice(0, 400));
      const det = JSON.stringify(o.j || {});
      const msg = /terminal/i.test(det) && (o.status === 403 || o.status === 400 || o.status === 404)
        ? 'El posnet no está listo para recibir cobros (revisá que esté prendido, con internet y en modo integrado).'
        : 'Mercado Pago no pudo mandar el cobro al posnet (' + o.status + ').';
      return res.status(502).json({ error: msg + ' Cobrá a mano y avisale al dueño.' });
    }
    const ins = await pool.query(
      `INSERT INTO cobros_mp(negocio_id, turno_id, sucursal_id, order_id, ref, monto, tipo) VALUES($1,$2,$3,$4,$5,$6,'point') RETURNING id`,
      [t.negocio_id, t.id, t.sucursal_id || null, o.j.id, ref, total]);
    res.json({ cobro_id: ins.rows[0].id, monto: total });
  } catch (e) {
    console.error('[MP-COBRO] point:', e.message);
    res.status(500).json({ error: 'No se pudo mandar el cobro al posnet. Probá de nuevo.' });
  }
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
