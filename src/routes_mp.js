const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { actualizarBaselineNegocio } = require('./baseline_negocio');
const { authWithQuery } = require('./authMiddleware');

const MP_AUTH_URL   = 'https://auth.mercadopago.com.ar/authorization';
const MP_TOKEN_URL  = 'https://api.mercadopago.com/oauth/token';
const MP_PAY_URL    = 'https://api.mercadopago.com/v1/payments/search';
const MP_USERS_URL  = 'https://api.mercadopago.com/users';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapMetodoPago(paymentTypeId) {
  const MAP = {
    credit_card:   'TARJETA',
    debit_card:    'TARJETA',
    prepaid_card:  'TARJETA',
    ticket:        'EFECTIVO',
    bank_transfer: 'TRANSFERENCIA',
    account_money: 'CUENTA_MP',
  };
  return MAP[paymentTypeId] || (paymentTypeId ? paymentTypeId.toUpperCase() : 'OTRO');
}

function calcularTurno(fechaStr) {
  const hora = new Date(fechaStr).getHours();
  if (hora >= 6  && hora < 12) return 'MANANA';
  if (hora >= 12 && hora < 18) return 'TARDE';
  return 'NOCHE';
}

async function refreshAccessToken(negocioId, refreshToken) {
  const resp = await fetch(MP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.MP_CLIENT_ID,
      client_secret: process.env.MP_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const data = await resp.json();
  if (!data.access_token) return null;
  const expira = new Date(Date.now() + data.expires_in * 1000);
  await pool.query(
    `UPDATE integraciones_mp
     SET mp_access_token=$1, mp_refresh_token=$2, fecha_expiracion=$3
     WHERE negocio_id=$4`,
    [data.access_token, data.refresh_token || refreshToken, expira, negocioId]
  );
  return data.access_token;
}

async function getAccessToken(negocioId) {
  const result = await pool.query(
    'SELECT mp_access_token, mp_refresh_token, fecha_expiracion FROM integraciones_mp WHERE negocio_id=$1',
    [negocioId]
  );
  if (result.rows.length === 0) return null;
  const { mp_access_token, mp_refresh_token, fecha_expiracion } = result.rows[0];
  if (new Date(fecha_expiracion) > new Date()) return mp_access_token;
  return refreshAccessToken(negocioId, mp_refresh_token);
}

// ─── GET /api/mp/conectar ─────────────────────────────────────────────────────
// El browser navega a esta URL con el JWT en ?token=
// Genera state firmado (contiene userId) y redirige a MP.
router.get('/conectar', authWithQuery, (req, res) => {
  if (!process.env.MP_CLIENT_ID || !process.env.MP_REDIRECT_URI) {
    return res.status(500).json({ error: 'MP_CLIENT_ID y MP_REDIRECT_URI no configurados' });
  }
  const state = jwt.sign({ userId: req.user.id, negocioId: req.user.negocio_id }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.MP_CLIENT_ID,
    redirect_uri:  process.env.MP_REDIRECT_URI,
    scope:         'offline_access payments',
    state,
  });
  res.redirect(`${MP_AUTH_URL}?${params}`);
});

// ─── GET /api/mp/callback ─────────────────────────────────────────────────────
// MP redirige aquí con ?code=AUTH_CODE&state=STATE
router.get('/callback', async (req, res) => {
  const FRONTEND = process.env.FRONTEND_URL || '/';
  const { code, state, error } = req.query;

  if (error) return res.redirect(`${FRONTEND}?mp_error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${FRONTEND}?mp_error=parametros_faltantes`);

  let userId, negocioId;
  try {
    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    userId = decoded.userId;
    negocioId = decoded.negocioId;
  } catch(e) {
    return res.redirect(`${FRONTEND}?mp_error=state_invalido`);
  }

  try {
    // Intercambiar code por tokens
    const tokenResp = await fetch(MP_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.MP_CLIENT_ID,
        client_secret: process.env.MP_CLIENT_SECRET,
        code,
        grant_type:    'authorization_code',
        redirect_uri:  process.env.MP_REDIRECT_URI,
      }),
    });
    const tokens = await tokenResp.json();

    if (!tokens.access_token) {
      return res.redirect(`${FRONTEND}?mp_error=${encodeURIComponent(tokens.message || 'token_error')}`);
    }

    // Obtener email del usuario de MP
    const userResp = await fetch(`${MP_USERS_URL}/${tokens.user_id}`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const mpUser = await userResp.json();

    const expira = new Date(Date.now() + (tokens.expires_in || 15552000) * 1000);

    await pool.query(
      `INSERT INTO integraciones_mp(negocio_id, mp_access_token, mp_refresh_token, mp_user_id, mp_email, fecha_expiracion)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (negocio_id) DO UPDATE SET
         mp_access_token=$2, mp_refresh_token=$3, mp_user_id=$4, mp_email=$5, fecha_expiracion=$6`,
      [negocioId, tokens.access_token, tokens.refresh_token || null, tokens.user_id, mpUser.email || null, expira]
    );

    await pool.query('UPDATE usuarios SET onboarding_done=true WHERE id=$1', [userId]);

    res.redirect(`${FRONTEND}/onboarding?mp_conectado=true`);
  } catch(e) {
    console.error('MP callback error:', e.message);
    res.redirect(`${FRONTEND}?mp_error=server_error`);
  }
});

// ─── GET /api/mp/estado ───────────────────────────────────────────────────────
router.get('/estado', authWithQuery, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT mp_email, mp_user_id, fecha_expiracion FROM integraciones_mp WHERE negocio_id=$1',
      [req.user.negocio_id]
    );
    if (result.rows.length === 0) return res.json({ conectado: false });
    const { mp_email, mp_user_id, fecha_expiracion } = result.rows[0];
    const activo = new Date(fecha_expiracion) > new Date();
    res.json({ conectado: activo, mp_email, mp_user_id, fecha_expiracion });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/mp/importar ─────────────────────────────────────────────────────
// Importa pagos aprobados de los últimos 18 meses con paginación automática.
router.get('/importar', authWithQuery, async (req, res) => {
  try {
    const accessToken = await getAccessToken(req.user.negocio_id);
    if (!accessToken) {
      return res.status(401).json({ error: 'Mercado Pago no conectado o token expirado. Reconectá desde /api/mp/conectar' });
    }

    const beginDate = new Date();
    beginDate.setMonth(beginDate.getMonth() - 18);

    let importados = 0;
    let omitidos = 0;
    let offset = 0;
    const limit = 100;

    while (true) {
      const params = new URLSearchParams({
        begin_date: beginDate.toISOString().split('.')[0] + 'Z',
        end_date:   new Date().toISOString().split('.')[0] + 'Z',
        sort:       'date_approved',
        criteria:   'desc',
        limit:      String(limit),
        offset:     String(offset),
      });

      const resp = await fetch(`${MP_PAY_URL}?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await resp.json();

      if (!resp.ok) {
        throw new Error(`MP API ${resp.status}: ${data.message || JSON.stringify(data)}`);
      }

      const pagos = data.results || [];
      if (pagos.length === 0) break;

      for (const pago of pagos) {
        if (pago.status !== 'approved') { omitidos++; continue; }

        const fecha  = pago.date_approved || pago.date_created;
        const turno  = calcularTurno(fecha);
        const metodo = mapMetodoPago(pago.payment_type_id);

        const ins = await pool.query(
          `INSERT INTO transacciones(negocio_id, monto, tipo, empleado, turno, fecha, metodo_pago, mp_payment_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [req.user.negocio_id, pago.transaction_amount, 'venta', 'importado_mp', turno, fecha, metodo, pago.id]
        );
        if (ins.rowCount > 0) importados++;
      }

      if (pagos.length < limit) break;
      offset += limit;
    }

    // Recalcular baseline con los datos frescos
    if (importados > 0) {
      const todas = await pool.query(
        'SELECT * FROM transacciones WHERE negocio_id=$1 ORDER BY fecha ASC',
        [req.user.negocio_id]
      );
      await actualizarBaselineNegocio(req.user.negocio_id, null, todas.rows);
    }

    res.json({
      ok: true,
      importados,
      omitidos,
      mensaje: `${importados} transacciones importadas de Mercado Pago.`,
    });
  } catch(e) {
    console.error('MP importar error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
