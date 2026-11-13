// mp_sync.js — Sincronizacion automatica de pagos de Mercado Pago.
//
// Cada pocos minutos (job externo -> POST /api/job/sync-mp) trae los pagos nuevos o modificados de la cuenta de
// Mercado Pago de cada negocio conectado y los guarda en la tabla APARTE pagos_mp.
//
// IMPORTANTE: NO escribe en "transacciones". Los pagos de Mercado Pago se usan para COMPARAR contra las ventas
// y la caja (fuga "Mercado Pago contra caja") y para mostrar ventas digitales en vivo. Si se mezclaran con las
// ventas, un negocio que sube su archivo de ventas Y conecta Mercado Pago contaria dos veces cada cobro digital.
//
// Reglas:
//  - Sin duplicados: UNIQUE(negocio_id, mp_payment_id). Un pago que cambia de estado (ej. reembolso) se ACTUALIZA.
//  - Nunca se escribe ni se devuelve un token en los logs ni en la respuesta.
//  - Si un negocio falla (token vencido, error de Mercado Pago), se registra y se sigue con los demas.
//  - Fechas: se guardan como timestamp UTC sin zona (igual que transacciones.fecha).

const pool = require('./db');

const MP_PAY_URL = 'https://api.mercadopago.com/v1/payments/search';
const MP_TOKEN_URL = 'https://api.mercadopago.com/oauth/token';
const DIAS_PRIMERA = 7;       // la primera vez trae la ultima semana (el historial largo lo trae /api/mp/importar)
const SOLAPE_HORAS = 2;       // cada corrida mira un poco hacia atras para no perder pagos que cambian de estado
const LIMITE = 100;
const MAX_PAGINAS = 10;       // tope por negocio y por corrida

async function asegurarTablas(db) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS pagos_mp(
       id SERIAL PRIMARY KEY,
       negocio_id INTEGER NOT NULL,
       mp_payment_id BIGINT NOT NULL,
       monto NUMERIC(14,2) NOT NULL,
       comision NUMERIC(14,2),
       neto NUMERIC(14,2),
       metodo TEXT,
       estado TEXT,
       fecha TIMESTAMP NOT NULL,
       creado TIMESTAMP DEFAULT NOW(),
       actualizado TIMESTAMP DEFAULT NOW(),
       UNIQUE (negocio_id, mp_payment_id))`
  );
  await db.query('CREATE INDEX IF NOT EXISTS idx_pagos_mp_negocio_fecha ON pagos_mp(negocio_id, fecha)');
  await db.query(
    `CREATE TABLE IF NOT EXISTS sync_mp_estado(
       negocio_id INTEGER PRIMARY KEY,
       ultimo_ok TIMESTAMP,
       ultimo_error TEXT,
       ultimo_error_fecha TIMESTAMP)`
  );
}

const aUtcNaive = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
const num = (x) => (x === null || x === undefined || x === '' || isNaN(Number(x)) ? null : Number(x));

// Comision real: lo que Mercado Pago informa. Si no viene el neto, se suman las comisiones del pago.
function comisionDe(p) {
  const bruto = num(p.transaction_amount);
  const neto = num(p.transaction_details && p.transaction_details.net_received_amount);
  if (bruto !== null && neto !== null && neto > 0) return { comision: Math.round((bruto - neto) * 100) / 100, neto };
  if (Array.isArray(p.fee_details) && p.fee_details.length) {
    const c = p.fee_details.reduce((s, f) => s + (num(f.amount) || 0), 0);
    return { comision: Math.round(c * 100) / 100, neto: bruto !== null ? Math.round((bruto - c) * 100) / 100 : null };
  }
  return { comision: null, neto: neto };
}

async function negocioDe(db, fila) {
  if (fila.negocio_id) return Number(fila.negocio_id);
  if (!fila.usuario_id) return null;
  const r = await db.query(
    `SELECT negocio_id FROM negocio_usuarios WHERE usuario_id=$1 AND rol='owner' AND COALESCE(activo,true)=true ORDER BY negocio_id LIMIT 1`,
    [fila.usuario_id]
  );
  return r.rows[0] ? Number(r.rows[0].negocio_id) : null;
}

async function tokenVigente(db, fila, opts) {
  if (fila.fecha_expiracion && new Date(fila.fecha_expiracion) > new Date(Date.now() + 60000)) return fila.mp_access_token;
  if (!fila.mp_refresh_token) throw new Error('El token de Mercado Pago venció y no hay forma de renovarlo: el dueño tiene que volver a conectar su cuenta.');
  if (!process.env.MP_CLIENT_ID && !opts.clientId) throw new Error('Faltan MP_CLIENT_ID / MP_CLIENT_SECRET para renovar el token.');
  const f = opts.fetch || fetch;
  const resp = await f(MP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: opts.clientId || process.env.MP_CLIENT_ID,
      client_secret: opts.clientSecret || process.env.MP_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: fila.mp_refresh_token,
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('No se pudo renovar el token de Mercado Pago: el dueño tiene que volver a conectar su cuenta.');
  const expira = new Date(Date.now() + (data.expires_in || 15552000) * 1000);
  await db.query(
    'UPDATE integraciones_mp SET mp_access_token=$1, mp_refresh_token=$2, fecha_expiracion=$3 WHERE id=$4',
    [data.access_token, data.refresh_token || fila.mp_refresh_token, expira, fila.id]
  );
  return data.access_token;
}

async function sincronizarNegocio(db, negocioId, token, opts) {
  const f = opts.fetch || fetch;
  // se lee como TEXTO para no depender de la zona horaria del servidor (el timestamp se guarda siempre en UTC)
  const est = await db.query('SELECT ultimo_ok::text AS ultimo_ok FROM sync_mp_estado WHERE negocio_id=$1', [negocioId]);
  const ahora = opts.ahora || new Date();
  const uo = est.rows[0] && est.rows[0].ultimo_ok;
  const uoMs = uo ? new Date(String(uo).replace(' ', 'T') + 'Z').getTime() : null;
  const desde = uoMs && !isNaN(uoMs)
    ? new Date(uoMs - SOLAPE_HORAS * 3600000)
    : new Date(ahora.getTime() - DIAS_PRIMERA * 86400000);
  let nuevos = 0, actualizados = 0, offset = 0;
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const params = new URLSearchParams({
      range: 'date_last_updated',
      begin_date: aUtcNaive(desde).replace(' ', 'T') + 'Z',
      end_date: aUtcNaive(ahora).replace(' ', 'T') + 'Z',
      sort: 'date_last_updated', criteria: 'desc',
      limit: String(LIMITE), offset: String(offset),
    });
    const resp = await f(`${MP_PAY_URL}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();
    if (!resp.ok) throw new Error(`Mercado Pago respondió ${resp.status}: ${String(data && data.message || '').slice(0, 160)}`);
    const pagos = data.results || [];
    for (const p of pagos) {
      const monto = num(p.transaction_amount);
      const fecha = p.date_approved || p.date_created;
      if (monto === null || !p.id || !fecha) continue;
      const { comision, neto } = comisionDe(p);
      const r = await db.query(
        `INSERT INTO pagos_mp(negocio_id, mp_payment_id, monto, comision, neto, metodo, estado, fecha)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (negocio_id, mp_payment_id) DO UPDATE
           SET monto=$3, comision=$4, neto=$5, metodo=$6, estado=$7, fecha=$8, actualizado=NOW()
         RETURNING (xmax = 0) AS nuevo`,
        [negocioId, p.id, monto, comision, neto, p.payment_type_id || null, p.status || null, aUtcNaive(fecha)]
      );
      if (r.rows[0] && r.rows[0].nuevo) nuevos++; else actualizados++;
    }
    if (pagos.length < LIMITE) break;
    offset += LIMITE;
  }
  await db.query(
    `INSERT INTO sync_mp_estado(negocio_id, ultimo_ok, ultimo_error, ultimo_error_fecha) VALUES($1,$2,NULL,NULL)
     ON CONFLICT (negocio_id) DO UPDATE SET ultimo_ok=$2, ultimo_error=NULL, ultimo_error_fecha=NULL`,
    [negocioId, aUtcNaive(ahora)]
  );
  return { nuevos, actualizados };
}

// opts: { fetch, ahora, clientId, clientSecret } (inyectables para pruebas)
async function correrSyncMP(db = pool, opts = {}) {
  await asegurarTablas(db);
  const filas = (await db.query('SELECT * FROM integraciones_mp')).rows;
  const resumen = { negocios: 0, nuevos: 0, actualizados: 0, errores: [] };
  for (const fila of filas) {
    let negocioId = null;
    try {
      negocioId = await negocioDe(db, fila);
      if (!negocioId) throw new Error('La conexión de Mercado Pago no está asociada a ningún negocio.');
      const token = await tokenVigente(db, fila, opts);
      const r = await sincronizarNegocio(db, negocioId, token, opts);
      resumen.negocios++; resumen.nuevos += r.nuevos; resumen.actualizados += r.actualizados;
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      resumen.errores.push({ negocio_id: negocioId, error: msg });
      console.error('[MP-SYNC] negocio', negocioId, msg);
      if (negocioId) {
        await db.query(
          `INSERT INTO sync_mp_estado(negocio_id, ultimo_error, ultimo_error_fecha) VALUES($1,$2,NOW())
           ON CONFLICT (negocio_id) DO UPDATE SET ultimo_error=$2, ultimo_error_fecha=NOW()`,
          [negocioId, msg]
        ).catch(() => {});
      }
    }
  }
  return resumen;
}

module.exports = { correrSyncMP, comisionDe, tokenVigente };
