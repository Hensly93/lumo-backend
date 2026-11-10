// ia_presupuesto.js — presupuesto de IA por negocio (limite invisible, medido en plata).
//
// Regla: lo que gasta NICOLE en IA por cada negocio no puede pasar del 10% de lo que ese negocio paga.
//   - Cada llamada a la IA se anota (tabla ia_uso) con su costo estimado en dolares.
//   - Cuando el gasto del mes de un negocio llega a su presupuesto, NICOLE pasa al modelo economico.
//     No se corta nada y el cliente no ve ningun contador.
//
// Ajustes por variables de entorno (Render), todas opcionales:
//   IA_PRECIO_PLAN_ARS   precio mensual de referencia en pesos (por defecto 45000)
//   IA_PRESUPUESTO_PCT   porcentaje del abono para IA (por defecto 0.10)
//   IA_DOLAR_ARS         dolar tarjeta de referencia (por defecto 2000)
const { AsyncLocalStorage } = require('async_hooks');
const pool = require('./db');

const als = new AsyncLocalStorage();

const ECONOMICO = 'claude-haiku-4-5-20251001';
const PRECIO_PLAN_ARS = Number(process.env.IA_PRECIO_PLAN_ARS) || 45000;
const PCT = Number(process.env.IA_PRESUPUESTO_PCT) || 0.10;
const DOLAR = Number(process.env.IA_DOLAR_ARS) || 2000;
const PRESUPUESTO_USD = (PRECIO_PLAN_ARS * PCT) / DOLAR; // por negocio y por mes

// Dolares por millon de tokens [entrada, salida]. Lo que no se reconoce se cuenta como Sonnet (conservador).
function preciosDe(modelo) {
  const m = String(modelo || '').toLowerCase();
  if (m.includes('haiku')) return [1, 5];
  if (m.includes('opus')) return [5, 25];
  return [3, 15];
}

function costoUsd(modelo, usage) {
  const u = usage || {};
  const [pin, pout] = preciosDe(modelo);
  const tin = Number(u.input_tokens || 0) + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
  const tout = Number(u.output_tokens || 0);
  return { tin, tout, costo: (tin * pin + tout * pout) / 1e6 };
}

function correrConNegocio(negocioId, fn) {
  const id = Number(negocioId);
  return als.run({ negocioId: Number.isFinite(id) ? id : null }, fn);
}

function negocioActual() {
  const s = als.getStore();
  return s && s.negocioId ? s.negocioId : null;
}

let tablaLista = null;
function asegurarTabla() {
  if (!tablaLista) {
    tablaLista = pool.query(`CREATE TABLE IF NOT EXISTS ia_uso (
      id SERIAL PRIMARY KEY,
      negocio_id INTEGER,
      funcion VARCHAR(60),
      modelo VARCHAR(80),
      tokens_in INTEGER,
      tokens_out INTEGER,
      costo_usd NUMERIC(12,6),
      creado TIMESTAMPTZ DEFAULT NOW()
    )`).then(() => pool.query('CREATE INDEX IF NOT EXISTS idx_ia_uso_negocio ON ia_uso(negocio_id, creado)'))
      .catch(e => { tablaLista = null; throw e; });
  }
  return tablaLista;
}

const cache = new Map(); // negocio_id -> { valor, ts }
const TTL_MS = 60 * 1000;
const avisados = new Set();

async function gastoMes(negocioId) {
  const c = cache.get(negocioId);
  if (c && Date.now() - c.ts < TTL_MS) return c.valor;
  await asegurarTabla();
  const r = await pool.query(
    "SELECT COALESCE(SUM(costo_usd), 0) AS g FROM ia_uso WHERE negocio_id = $1 AND creado >= date_trunc('month', NOW())",
    [negocioId]
  );
  const valor = Number(r.rows[0].g);
  cache.set(negocioId, { valor, ts: Date.now() });
  return valor;
}

// Devuelve el modelo a usar: el preferido, o el economico si el negocio ya llego a su presupuesto del mes.
// Si algo falla, devuelve el preferido (nunca frena una respuesta por un problema de este modulo).
async function modeloPara(preferido, negocioId) {
  try {
    const id = negocioId || negocioActual();
    if (!id || preferido === ECONOMICO) return preferido;
    const g = await gastoMes(id);
    if (g >= PRESUPUESTO_USD) {
      const clave = id + ':' + new Date().toISOString().slice(0, 7);
      if (!avisados.has(clave)) {
        avisados.add(clave);
        console.warn(`[ia] negocio ${id} llego a su presupuesto de IA del mes (USD ${g.toFixed(2)} de ${PRESUPUESTO_USD.toFixed(2)}): pasa al modelo economico`);
      }
      return ECONOMICO;
    }
    return preferido;
  } catch (e) {
    console.error('[ia] modeloPara:', e.message);
    return preferido;
  }
}

// Anota lo que costo una llamada. No devuelve nada y nunca lanza error.
function registrarUso({ funcion, modelo, usage, negocioId }) {
  try {
    if (!usage) return Promise.resolve();
    const id = negocioId || negocioActual();
    const { tin, tout, costo } = costoUsd(modelo, usage);
    return asegurarTabla()
      .then(() => pool.query(
        'INSERT INTO ia_uso(negocio_id, funcion, modelo, tokens_in, tokens_out, costo_usd) VALUES($1,$2,$3,$4,$5,$6)',
        [id, funcion || null, modelo || null, tin, tout, costo]
      ))
      .then(() => {
        const c = id ? cache.get(id) : null;
        if (c) c.valor += costo;
      })
      .catch(e => console.error('[ia] registrarUso:', e.message));
  } catch (e) {
    console.error('[ia] registrarUso:', e.message);
    return Promise.resolve();
  }
}

// Resumen del mes por negocio (para mirar el consumo)
async function resumenMes() {
  await asegurarTabla();
  const r = await pool.query(
    `SELECT negocio_id, COUNT(*) AS llamadas, COALESCE(SUM(costo_usd),0) AS usd
       FROM ia_uso WHERE creado >= date_trunc('month', NOW())
      GROUP BY negocio_id ORDER BY usd DESC`
  );
  return r.rows.map(x => ({
    negocio_id: x.negocio_id,
    llamadas: Number(x.llamadas),
    usd: Number(x.usd),
    pct_presupuesto: Math.round((Number(x.usd) / PRESUPUESTO_USD) * 100),
  }));
}

module.exports = { correrConNegocio, negocioActual, modeloPara, registrarUso, resumenMes, costoUsd, PRESUPUESTO_USD, ECONOMICO };
