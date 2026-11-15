// alerta_instante.js — LumoBi avisa al dueño EN EL MOMENTO cuando la caja hace algo fuera de lo normal (Palantir: alertas en tiempo real).
// Se dispara desde registro_hechos.registrar(), apenas se guarda un hecho. Nunca frena la caja.
//   · "Fuera de lo normal" se mide contra el negocio: el ticket promedio de los últimos 30 días, no un número fijo.
//   · Una alerta por turno y por motivo (alertas_instante): si pasa 5 veces, avisa una sola vez, no 5.
//   · El aviso lleva a la ficha del turno, donde está la prueba.
const pool = require('./db');

const $ = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
let lista = null;
function asegurar(db = pool) {
  if (!lista) {
    lista = (async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS alertas_instante (
        id SERIAL PRIMARY KEY,
        negocio_id INTEGER NOT NULL,
        turno_id INTEGER,
        clave TEXT NOT NULL,
        tipo TEXT NOT NULL,
        empleado TEXT,
        titulo TEXT NOT NULL,
        cuerpo TEXT NOT NULL,
        url TEXT,
        valor NUMERIC(14,2) NOT NULL DEFAULT 0,
        entregados INTEGER NOT NULL DEFAULT 0,
        feedback TEXT,
        feedback_en TIMESTAMPTZ,
        creado TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.query('ALTER TABLE alertas_instante ADD COLUMN IF NOT EXISTS feedback TEXT');
      await db.query('ALTER TABLE alertas_instante ADD COLUMN IF NOT EXISTS feedback_en TIMESTAMPTZ');
      await db.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_alertas_instante ON alertas_instante (negocio_id, COALESCE(turno_id, 0), clave)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_alertas_instante_neg ON alertas_instante (negocio_id, creado DESC)');
    })().catch((e) => { lista = null; throw e; });
  }
  return lista;
}

// Autocalibración: si el dueño dijo seguido que una alerta "no era nada", esa alerta pide más para volver a sonar.
// Misma regla que los hallazgos (hallazgos.factorSensibilidad): nunca baja de la mitad ni sube de 3 veces.
async function factores(negocioId, db = pool) {
  await asegurar(db);
  const r = await db.query(`SELECT clave, COUNT(*) FILTER (WHERE feedback = 'no_era_nada')::int AS neg, COUNT(*) FILTER (WHERE feedback = 'util')::int AS pos
                              FROM alertas_instante WHERE negocio_id = $1 AND feedback IS NOT NULL GROUP BY clave`, [negocioId]);
  const { factorSensibilidad } = require('./hallazgos');
  const out = {};
  for (const x of r.rows) { const f = factorSensibilidad(x.neg, x.pos); if (f !== 1) out[x.clave] = f; }
  return out;
}

async function responder(negocioId, id, respuesta, db = pool) {
  if (!['util', 'no_era_nada'].includes(respuesta)) return false;
  await asegurar(db);
  const r = await db.query('UPDATE alertas_instante SET feedback = $1, feedback_en = NOW() WHERE id = $2 AND negocio_id = $3', [respuesta, parseInt(id, 10) || 0, negocioId]);
  return r.rowCount > 0;
}

// Lo "normal" del negocio: ticket promedio de 30 días (con piso, para negocios nuevos)
async function ticketNormal(negocioId, db) {
  const r = await db.query(
    `SELECT AVG(monto)::float AS t, COUNT(*)::int AS n FROM transacciones
      WHERE negocio_id = $1 AND COALESCE(tipo,'venta') = 'venta' AND monto > 0 AND fecha >= NOW() - INTERVAL '30 days'`, [negocioId]);
  const x = r.rows[0];
  return x && x.n >= 10 && x.t > 0 ? x.t : null;
}

async function cuentaEnTurno(db, negocioId, turnoId, tipo) {
  if (!turnoId) return { n: 0, plata: 0 };
  const r = await db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(valor),0)::float AS plata FROM hechos_caja WHERE negocio_id = $1 AND turno_id = $2 AND tipo = $3`, [negocioId, turnoId, tipo]);
  return r.rows[0];
}

// Devuelve { clave, titulo, cuerpo } si hay que avisar, o null
async function evaluar(h, db) {
  const quien = h.empleado || 'Alguien de la caja';
  const valor = Number(h.valor) || 0;
  const t = await ticketNormal(h.negocio_id, db);
  const veces = (v) => (t ? Math.round((v / t) * 10) / 10 : null);
  const F = await factores(h.negocio_id, db).catch(() => ({}));
  const f = (clave) => F[clave] || 1;
  const grande = (v, min, mult, clave) => v >= Math.max(min, t ? t * mult : min * 2) * f(clave);
  const normal = t ? ` Una venta normal es de unos ${$(t)}.` : '';

  if (h.tipo === 'venta_anulada') {
    const c = await cuentaEnTurno(db, h.negocio_id, h.turno_id, 'venta_anulada');
    if (grande(valor, 3000, 3, 'anulacion_grande')) return { clave: 'anulacion_grande', titulo: 'Se anuló una venta grande',
      cuerpo: `${quien} anuló una venta de ${$(valor)}${h.detalle?.motivo ? ` (motivo: ${h.detalle.motivo})` : ''}.${normal}` };
    if (c.n >= Math.ceil(2 * f('anulaciones_repetidas'))) return { clave: 'anulaciones_repetidas', titulo: 'Varias ventas anuladas en un turno',
      cuerpo: `${quien} ya anuló ${c.n} ventas en este turno (${$(c.plata)} en total). Tocá para ver cuáles.` };
  }
  if (h.tipo === 'descuento') {
    const c = await cuentaEnTurno(db, h.negocio_id, h.turno_id, 'descuento');
    if (grande(valor, 2000, 1.5, 'descuento_grande')) return { clave: 'descuento_grande', titulo: 'Descuento grande en la caja',
      cuerpo: `${quien} hizo un descuento de ${$(valor)}${h.detalle?.pct ? ` (${h.detalle.pct}%)` : ''}${h.detalle?.motivo ? `: ${h.detalle.motivo}` : ''}.${normal}` };
    if (c.n >= Math.ceil(4 * f('descuentos_repetidos'))) return { clave: 'descuentos_repetidos', titulo: 'Muchos descuentos en un turno',
      cuerpo: `${quien} ya hizo ${c.n} descuentos en este turno (${$(c.plata)} en total). Tocá para ver cada uno.` };
  }
  if (h.tipo === 'egreso' && grande(valor, 5000, 4, 'egreso_grande')) {
    return { clave: 'egreso_grande', titulo: 'Salió plata de la caja',
      cuerpo: `${quien} sacó ${$(valor)} de la caja${h.detalle?.motivo ? ` (${h.detalle.motivo})` : ''}.` };
  }
  if (h.tipo === 'espera_descartada' && valor >= 1500 * f('espera_sin_cobrar')) {
    return { clave: 'espera_sin_cobrar', titulo: 'Un turno cerró con una venta sin cobrar',
      cuerpo: `${quien} cerró el turno con una venta en espera de ${$(valor)} que nunca se cobró.` };
  }
  if (h.tipo === 'item_borrado' || h.tipo === 'cantidad_reducida') {
    const a = await cuentaEnTurno(db, h.negocio_id, h.turno_id, 'item_borrado');
    const b = await cuentaEnTurno(db, h.negocio_id, h.turno_id, 'cantidad_reducida');
    if (a.n + b.n >= Math.ceil(6 * f('carrito_sacados'))) return { clave: 'carrito_sacados', titulo: 'Muchos productos sacados del carrito',
      cuerpo: `${quien} sacó o bajó ${a.n + b.n} productos del carrito antes de cobrar en este turno. Tocá para ver cuáles.` };
  }
  return null;
}

async function avisar(h, db = pool) {
  try {
    if (!h || !h.negocio_id) return false;
    await asegurar(db);
    const a = await evaluar(h, db);
    if (!a) return false;
    // Una por turno y por motivo
    const ins = await db.query(
      `INSERT INTO alertas_instante (negocio_id, turno_id, clave, tipo, empleado, titulo, cuerpo, url, valor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
      [h.negocio_id, h.turno_id || null, a.clave, h.tipo, h.empleado || null, a.titulo, a.cuerpo,
       h.turno_id ? `/ficha/turno/${h.turno_id}` : '/en-vivo', Number(h.valor) || 0]);
    if (!ins.rows.length) return false;
    const { ownerDeNegocio } = require('./prediccion_adaptativa');
    const owner = await ownerDeNegocio(h.negocio_id, db);
    if (!owner) return true;
    const entregados = await require('./push').notificarUsuario(owner, { title: a.titulo, body: a.cuerpo, url: h.turno_id ? `/ficha/turno/${h.turno_id}` : '/en-vivo', tag: `instante-${h.negocio_id}-${a.clave}` }, db, 'alertas_criticas').catch((e) => { console.error('[instante] push:', e.message); return 0; });
    await db.query('UPDATE alertas_instante SET entregados = $1 WHERE id = $2', [entregados, ins.rows[0].id]);
    return true;
  } catch (e) { console.error('[instante]', e.message); return false; }
}

module.exports = { avisar, evaluar, asegurar, factores, responder };
