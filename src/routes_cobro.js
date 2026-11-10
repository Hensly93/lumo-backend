// routes_cobro.js — Cobro del abono de LumoBi con Mercado Pago Suscripciones (debito automatico mensual).
//
//   GET  /api/plan/cobro     (con login) precio del negocio con IVA y desglose
//   POST /api/plan/checkout  (con login) crea la suscripcion en Mercado Pago y devuelve el link para autorizarla
//   POST /api/plan/webhook   (lo llama Mercado Pago) confirma el pago y activa o baja el plan
//
// Reglas: la tarjeta se carga SOLO en Mercado Pago. Las cuentas "interna" nunca se tocan.
// El webhook no confia en lo que llega: vuelve a preguntarle a Mercado Pago con el MP_ACCESS_TOKEN.

const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');
const { calcularPrecio, efectivo } = require('./precios');
const { estadoPlan } = require('./plan_gate');

const MP_API = 'https://api.mercadopago.com';
const IVA = 0.21;
const ORIGENES = ['https://lumo-psi.vercel.app', 'https://lumobi.com.ar', 'https://www.lumobi.com.ar'];

pool
  .query(`CREATE TABLE IF NOT EXISTS cobros_lumobi(
    id SERIAL PRIMARY KEY, negocio_id INTEGER, usuario_id INTEGER,
    mp_preapproval_id TEXT, mp_pago_id TEXT, monto NUMERIC, estado TEXT, creado TIMESTAMP DEFAULT NOW())`)
  .catch((e) => console.error('[COBRO] no se pudo crear cobros_lumobi:', e.message));

async function precioDelNegocio(nid) {
  const suc = await pool.query('SELECT cajas FROM mis_sucursales WHERE negocio_id=$1 AND activo=true ORDER BY id', [nid]);
  const emp = await pool.query('SELECT COUNT(*)::int AS n FROM empleados_negocio WHERE negocio_id=$1 AND activo=true', [nid]);
  const neg = await pool.query('SELECT locales_declarados, cajas_declaradas, empleados_declarados FROM negocios WHERE id=$1', [nid]);
  const n = neg.rows[0] || {};
  const ef = efectivo(suc.rows.map((r) => r.cajas), emp.rows[0].n, {
    locales: n.locales_declarados, cajas: n.cajas_declaradas, empleados: n.empleados_declarados,
  });
  const c = calcularPrecio(ef.cajas, ef.empleados);
  if (c.precio == null) return Object.assign({}, c, { neto: null, iva: null, total: null });
  const iva = Math.round(c.precio * IVA);
  return Object.assign({}, c, { neto: c.precio, iva: iva, total: c.precio + iva });
}

async function mpGet(ruta) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return null;
  const r = await fetch(MP_API + ruta, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) { console.error('[COBRO] MP GET', ruta, r.status); return null; }
  return r.json();
}

// ─── GET /api/plan/cobro ─────────────────────────────────────────────────────
router.get('/cobro', auth, async (req, res) => {
  try {
    const p = await precioDelNegocio(req.user.negocio_id);
    const est = await estadoPlan(pool, req.user.negocio_id);
    const u = await pool.query('SELECT email FROM usuarios WHERE id=$1', [req.user.id]);
    res.json(Object.assign({}, p, { estado: est.estado, interna: !!est.interna, email: (u.rows[0] && u.rows[0].email) || '' }));
  } catch (e) {
    console.error('[COBRO] cobro:', e.message);
    res.status(500).json({ error: 'No se pudo calcular el precio' });
  }
});

// ─── POST /api/plan/checkout ─────────────────────────────────────────────────
router.post('/checkout', auth, async (req, res) => {
  try {
    const token = process.env.MP_ACCESS_TOKEN;
    if (!token) return res.status(503).json({ error: 'El cobro online todavía no está disponible. Escribinos y lo activamos a mano.' });
    const nid = req.user.negocio_id, uid = req.user.id;
    const est = await estadoPlan(pool, nid);
    if (est.interna) return res.status(400).json({ error: 'Tu cuenta es interna: no se cobra.' });
    if (est.estado === 'activa') return res.status(400).json({ error: 'ya_activa' });
    const p = await precioDelNegocio(nid);
    if (p.plan === 'empresarial') return res.status(400).json({ error: 'empresarial' });
    // emailMP: Mercado Pago solo acepta el email de una cuenta de Mercado Pago (un alias de Gmail, por ejemplo, devuelve "User bad request")
    const u = await pool.query('SELECT email FROM usuarios WHERE id=$1', [uid]);
    const pedido = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (pedido && !(pedido.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(pedido))) {
      return res.status(400).json({ error: 'Ese email no parece válido. Revisalo y probá de nuevo.' });
    }
    const payerEmail = pedido || (u.rows[0] && u.rows[0].email);
    const origen = ORIGENES.includes(req.body && req.body.origen) ? req.body.origen : ORIGENES[0];
    const r = await fetch(MP_API + '/preapproval', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'LumoBi - abono mensual',
        external_reference: uid + ':' + nid,
        payer_email: payerEmail,
        back_url: origen + '/?pago=ok',
        status: 'pending',
        auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: p.total, currency_id: 'ARS' },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.init_point) {
      if (r.status === 400 && j && j.message === 'User bad request') {
        console.error('[COBRO] checkout MP: email rechazado por Mercado Pago');
        return res.status(400).json({ error: 'Mercado Pago no aceptó el email ' + payerEmail + '. Tiene que ser el email de tu cuenta de Mercado Pago, la misma con la que vas a pagar.' });
      }
      console.error('[COBRO] checkout MP:', r.status, JSON.stringify(j).slice(0, 300));
      return res.status(502).json({ error: 'No pudimos abrir Mercado Pago. Probá de nuevo en un rato.' });
    }
    await pool.query('UPDATE negocios SET mp_subscription_id=$1 WHERE id=$2', [j.id, nid]);
    await pool.query(
      "INSERT INTO cobros_lumobi(negocio_id, usuario_id, mp_preapproval_id, monto, estado) VALUES($1,$2,$3,$4,'pendiente')",
      [nid, uid, j.id, p.total]
    );
    res.json({ init_point: j.init_point });
  } catch (e) {
    console.error('[COBRO] checkout:', e.message);
    res.status(500).json({ error: 'No se pudo iniciar el pago' });
  }
});

// Vuelve a leer la suscripcion en Mercado Pago y deja el plan como corresponde.
async function sincronizar(preId) {
  const p = await mpGet('/preapproval/' + encodeURIComponent(preId));
  if (!p) return;
  const ref = String(p.external_reference || '').split(':');
  const uid = parseInt(ref[0], 10), nid = parseInt(ref[1], 10);
  if (!uid || !nid) return;
  const u = await pool.query('SELECT subscription_status AS st FROM usuarios WHERE id=$1', [uid]);
  if (!u.rows[0] || u.rows[0].st === 'interna') return;   // las cuentas internas no se tocan nunca

  if (p.status === 'authorized') {
    await pool.query("UPDATE usuarios SET subscription_status='active' WHERE id=$1", [uid]);
    await pool.query(
      "UPDATE negocios SET subscription_status='active', mp_subscription_id=$1, updated_at=NOW() WHERE id=$2", [preId, nid]);
    if (p.next_payment_date) {
      try { await pool.query('UPDATE negocios SET subscription_end_date=$1 WHERE id=$2', [p.next_payment_date, nid]); } catch (e) { /* opcional */ }
      try { await pool.query('UPDATE usuarios SET subscription_end_date=$1 WHERE id=$2', [p.next_payment_date, uid]); } catch (e) { /* opcional */ }
    }
    await pool.query("UPDATE cobros_lumobi SET estado='autorizada' WHERE mp_preapproval_id=$1 AND mp_pago_id IS NULL", [preId]);
    console.log('[COBRO] plan activado: negocio', nid);
  } else if (p.status === 'cancelled' || p.status === 'paused') {
    // Solo baja a quien estaba pagando; si el dueño canceló desde la app, ese flujo ya marcó su estado.
    await pool.query("UPDATE usuarios SET subscription_status='expired' WHERE id=$1 AND subscription_status='active'", [uid]);
    await pool.query("UPDATE negocios SET subscription_status='expired', updated_at=NOW() WHERE id=$1 AND subscription_status='active'", [nid]);
    console.log('[COBRO] plan dado de baja (' + p.status + '): negocio', nid);
  }
}

async function registrarPago(ap) {
  const idPago = String(ap.id);
  const ya = await pool.query('SELECT id FROM cobros_lumobi WHERE mp_pago_id=$1', [idPago]);
  if (ya.rows.length) {
    await pool.query('UPDATE cobros_lumobi SET estado=$1 WHERE mp_pago_id=$2', [String(ap.status || ''), idPago]);
    return;
  }
  const n = await pool.query('SELECT id FROM negocios WHERE mp_subscription_id=$1', [String(ap.preapproval_id || '')]);
  await pool.query(
    'INSERT INTO cobros_lumobi(negocio_id, mp_preapproval_id, mp_pago_id, monto, estado) VALUES($1,$2,$3,$4,$5)',
    [n.rows[0] ? n.rows[0].id : null, String(ap.preapproval_id || ''), idPago, ap.transaction_amount || null, String(ap.status || '')]
  );
}

// ─── POST /api/plan/webhook ──────────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
  res.sendStatus(200);   // Mercado Pago quiere respuesta rapida
  try {
    const q = req.query || {}, b = req.body || {};
    const tipo = b.type || q.type || b.topic || q.topic;
    const id = (b.data && b.data.id) || q['data.id'] || q.id || b.id;
    if (!id) return;
    if (tipo === 'subscription_preapproval' || tipo === 'preapproval') {
      await sincronizar(String(id));
    } else if (tipo === 'subscription_authorized_payment' || tipo === 'authorized_payment') {
      const ap = await mpGet('/authorized_payments/' + encodeURIComponent(id));
      if (ap) {
        await registrarPago(ap);
        if (ap.preapproval_id) await sincronizar(String(ap.preapproval_id));
      }
    }
  } catch (e) {
    console.error('[COBRO] webhook:', e.message);
  }
});

module.exports = router;
