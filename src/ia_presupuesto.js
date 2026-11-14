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
//   IA_TRIAL_PRESUPUESTO_USD  presupuesto de IA de toda la prueba gratis (por defecto 0.60)
//   IA_TRIAL_TOPE_USD         tope duro de la prueba gratis: pasado esto el chat avisa que hay que activar el plan (por defecto 1.00)
//
// Cuentas "internas" (subscription_status = 'interna'): sin limite de IA, nunca se bloquean ni se cobran.
// Prueba gratis de 5 dias: presupuesto propio y tope duro, porque ese cliente todavia no paga.
const { AsyncLocalStorage } = require('async_hooks');
const pool = require('./db');

const als = new AsyncLocalStorage();

const ECONOMICO = 'claude-haiku-4-5-20251001';
const PRECIO_PLAN_ARS = Number(process.env.IA_PRECIO_PLAN_ARS) || 45000;
const PCT = Number(process.env.IA_PRESUPUESTO_PCT) || 0.10;
const DOLAR = Number(process.env.IA_DOLAR_ARS) || 2000;
const PRESUPUESTO_USD = (PRECIO_PLAN_ARS * PCT) / DOLAR; // por negocio y por mes
const TRIAL_USD = Number(process.env.IA_TRIAL_PRESUPUESTO_USD) || 0.60;   // toda la prueba gratis
const TRIAL_TOPE_USD = Number(process.env.IA_TRIAL_TOPE_USD) || 1.00;     // tope duro de la prueba

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
  const base = Number(u.input_tokens || 0);
  const creacion = Number(u.cache_creation_input_tokens || 0); // escribir caché: 1.25x
  const lectura = Number(u.cache_read_input_tokens || 0);      // leer caché: 0.1x
  const tin = base + creacion + lectura;
  const tout = Number(u.output_tokens || 0);
  return { tin, tout, costo: ((base + creacion * 1.25 + lectura * 0.1) * pin + tout * pout) / 1e6 };
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

async function condicion(negocioId) {
  try {
    const est = await require('./plan_gate').estadoPlan(null, negocioId);
    return { interna: !!est.interna, esTrial: est.estado === 'trial' && !est.sin_vencimiento };
  } catch (e) {
    return { interna: false, esTrial: false };
  }
}

// En la prueba gratis se cuenta todo lo gastado; en un plan, lo del mes.
async function gasto(negocioId, esTrial) {
  const k = negocioId + ':' + (esTrial ? 't' : 'm');
  const c = cache.get(k);
  if (c && Date.now() - c.ts < TTL_MS) return c.valor;
  await asegurarTabla();
  const r = await pool.query(
    esTrial
      ? 'SELECT COALESCE(SUM(costo_usd), 0) AS g FROM ia_uso WHERE negocio_id = $1'
      : "SELECT COALESCE(SUM(costo_usd), 0) AS g FROM ia_uso WHERE negocio_id = $1 AND creado >= date_trunc('month', NOW())",
    [negocioId]
  );
  const valor = Number(r.rows[0].g);
  cache.set(k, { valor, ts: Date.now() });
  return valor;
}

// Devuelve el modelo a usar: el preferido, o el economico si el negocio ya llego a su presupuesto.
//   - cuenta interna: siempre el preferido
//   - prueba gratis: con opciones.bloquearSiTope devuelve null al llegar al tope duro (el que llama avisa que hay que activar el plan)
// Si algo falla, devuelve el preferido (nunca frena una respuesta por un problema de este modulo).
async function modeloPara(preferido, negocioId, opciones) {
  try {
    const id = negocioId || negocioActual();
    if (!id) return preferido;
    const { interna, esTrial } = await condicion(id);
    if (interna) return preferido;
    const g = await gasto(id, esTrial);
    if (esTrial && opciones && opciones.bloquearSiTope && g >= TRIAL_TOPE_USD) return null;
    if (preferido === ECONOMICO) return preferido;
    const presupuesto = esTrial ? TRIAL_USD : PRESUPUESTO_USD;
    if (g >= presupuesto) {
      const clave = id + ':' + (esTrial ? 't' : new Date().toISOString().slice(0, 7));
      if (!avisados.has(clave)) {
        avisados.add(clave);
        console.warn(`[ia] negocio ${id} llego a su presupuesto de IA (USD ${g.toFixed(2)} de ${presupuesto.toFixed(2)}${esTrial ? ', prueba gratis' : ''}): pasa al modelo economico`);
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
        for (const suf of [':t', ':m']) {
          const c = id ? cache.get(id + suf) : null;
          if (c) c.valor += costo;
        }
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

module.exports = { correrConNegocio, negocioActual, modeloPara, registrarUso, resumenMes, costoUsd, PRESUPUESTO_USD, TRIAL_USD, TRIAL_TOPE_USD, ECONOMICO };
