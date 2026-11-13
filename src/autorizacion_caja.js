// autorizacion_caja.js — control de la caja que aparece SOLO cuando hay comportamientos sospechosos.
// Mientras el turno se comporte como siempre, la caja funciona normal. Cuando una acción sensible se pasa de lo habitual,
// esa acción puntual pide autorización del dueño: con su PIN en la caja, o con un botón "Aprobar" desde su celular.
//   · sacar_producto   sacar o bajar cantidades del carrito antes de cobrar
//   · bajar_precio     bajar un precio de venta desde la caja
//   · egreso           sacar plata de la caja
// Cada pedido queda guardado (aprobado, rechazado, vencido o cancelado): así también queda registrado lo que se intentó.
// Si algo falla acá adentro, la caja sigue funcionando (nunca se frena una venta por un error del control).
const pool = require('./db');
const bcrypt = require('bcryptjs');
const { registrar: registrarHecho } = require('./registro_hechos');

const VENCE_MIN = 10;          // un pedido sin respuesta vence a los 10 minutos
const USO_MIN = 15;            // una vez aprobado hay 15 minutos para usarlo
const VENTANA_PIN_MIN = 5;     // con el PIN del dueño en la caja, 5 minutos sin volver a pedir para ese tipo de acción
const MAX_INTENTOS_PIN = 5;
const BLOQUEO_PIN_MIN = 15;
const DIAS_BASE = 30;
const TTL_RIESGO_MS = 30 * 60 * 1000;

const TIPOS = ['sacar_producto', 'bajar_precio', 'egreso'];
const fmt = (n) => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('es-AR');
const mediana = (v) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

let lista = null;
function asegurar(db = pool) {
  if (!lista) {
    lista = (async () => {
      await require('./registro_hechos').asegurar(db);
      await db.query(`CREATE TABLE IF NOT EXISTS autorizaciones_caja (
        id SERIAL PRIMARY KEY,
        negocio_id INTEGER NOT NULL,
        usuario_id INTEGER,
        turno_id INTEGER NOT NULL,
        empleado TEXT,
        tipo TEXT NOT NULL,
        clave TEXT NOT NULL,
        producto_id INTEGER,
        producto_nombre TEXT,
        valor NUMERIC(14,2) NOT NULL DEFAULT 0,
        motivo TEXT,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        metodo TEXT,
        intentos INTEGER NOT NULL DEFAULT 0,
        usada BOOLEAN NOT NULL DEFAULT false,
        creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resuelto_en TIMESTAMPTZ,
        ventana_hasta TIMESTAMPTZ
      )`);
      await db.query('CREATE INDEX IF NOT EXISTS idx_aut_caja_neg ON autorizaciones_caja (negocio_id, creado DESC)');
      await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pin_autorizacion_hash TEXT,
        ADD COLUMN IF NOT EXISTS pin_autorizacion_fallos INTEGER NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS pin_autorizacion_bloqueo TIMESTAMPTZ`);
    })().catch((e) => { lista = null; throw e; });
  }
  return lista;
}

// ── Qué es "lo habitual": se aprende de los últimos 30 días del propio negocio ───────────────────
const cacheRiesgo = new Map();   // negocio_id -> { ts, niveles: Map(empleado -> nivel) }
async function enRiesgo(negocioId, empleado, opts = {}) {
  try {
    const c = cacheRiesgo.get(negocioId);
    let niveles;
    if (c && Date.now() - c.ts < TTL_RIESGO_MS && !opts.erm) niveles = c.niveles;
    else {
      const erm = await (opts.erm || ((id) => require('./erm').calcularERMNegocio(id, null)))(negocioId);
      niveles = new Map(((erm && erm.empleados) || []).map((e) => [e.empleado, e.nivel]));
      if (!opts.erm) cacheRiesgo.set(negocioId, { ts: Date.now(), niveles });
    }
    const n = niveles.get(empleado);
    return n === 'rojo' || n === 'amarillo';
  } catch (e) { return false; }
}

// accion: { tipo, valor, pct?, turno_id, empleado, negocio_id }. Devuelve { requiere, motivo }.
async function evaluar(accion, db = pool, opts = {}) {
  const { negocio_id, turno_id, empleado, tipo } = accion;
  const valor = Number(accion.valor) || 0;
  const riesgo = await enRiesgo(negocio_id, empleado, opts);
  const f = riesgo ? 0.5 : 1;     // con faltantes de caja recientes, los límites son la mitad

  if (tipo === 'sacar_producto') {
    const turno = (await db.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(valor),0)::float AS valor FROM hechos_caja
        WHERE negocio_id = $1 AND turno_id = $2 AND tipo IN ('item_borrado','cantidad_reducida') AND creado >= NOW() - INTERVAL '3 hours'`,
      [negocio_id, turno_id])).rows[0];
    const base = (await db.query(
      `SELECT turno_id, COUNT(*)::int AS n, SUM(valor)::float AS valor FROM hechos_caja
        WHERE negocio_id = $1 AND tipo IN ('item_borrado','cantidad_reducida') AND turno_id IS NOT NULL AND turno_id <> $2
          AND creado >= NOW() - ($3::int * INTERVAL '1 day') GROUP BY turno_id`, [negocio_id, turno_id, DIAS_BASE])).rows;
    const tk = (await db.query(
      `SELECT COALESCE(AVG(monto),0)::float AS ticket FROM transacciones
        WHERE negocio_id = $1 AND tipo = 'venta' AND fecha >= NOW() - ($2::int * INTERVAL '1 day')`, [negocio_id, DIAS_BASE])).rows[0];
    // Lo "habitual" del negocio solo cuenta con al menos 5 turnos de historia: con menos, un solo turno raro correría el límite.
    const usaBase = base.length >= 5;
    const limN = Math.max(5, usaBase ? 3 * mediana(base.map((b) => b.n)) : 0) * f;
    const limV = Math.max(12000, usaBase ? 3 * mediana(base.map((b) => b.valor)) : 0) * f;
    const grande = Math.max(15000, 4 * (tk.ticket || 0)) * f;
    if (valor >= grande) return { requiere: true, motivo: `Sacar un producto de ${fmt(valor)} del carrito necesita autorización.` };
    if (turno.n + 1 > limN) return { requiere: true, motivo: `Ya se sacaron ${turno.n} productos del carrito en este turno, más de lo habitual.` };
    if (turno.valor + valor > limV) return { requiere: true, motivo: `Ya se sacaron ${fmt(turno.valor)} en productos del carrito en este turno, más de lo habitual.` };
    return { requiere: false };
  }

  if (tipo === 'bajar_precio') {
    const pct = Number(accion.pct) || 0;
    const previos = (await db.query(
      `SELECT COUNT(*)::int AS n FROM hechos_caja WHERE negocio_id = $1 AND turno_id = $2 AND tipo = 'precio_cambiado'`, [negocio_id, turno_id])).rows[0].n;
    if (pct >= 30) return { requiere: true, motivo: `Bajar un precio ${Math.round(pct)}% necesita autorización.` };
    if (pct >= 15 && (previos >= 2 || riesgo)) return { requiere: true, motivo: `Bajar precios ya se hizo ${previos} veces en este turno.` };
    return { requiere: false };
  }

  if (tipo === 'egreso') {
    const turno = (await db.query(
      `SELECT COUNT(*)::int AS n FROM egresos_caja WHERE turno_id = $1`, [turno_id])).rows[0];
    const base = (await db.query(
      `SELECT COALESCE(AVG(e.monto),0)::float AS prom FROM egresos_caja e JOIN turnos_caja t ON t.id = e.turno_id
        WHERE t.negocio_id = $1 AND e.hora >= NOW() - ($2::int * INTERVAL '1 day')`, [negocio_id, DIAS_BASE])).rows[0];
    const limite = Math.max(10000, 3 * (base.prom || 0)) * f;
    if (valor >= limite) return { requiere: true, motivo: `Sacar ${fmt(valor)} de la caja es más de lo habitual.` };
    if (turno.n >= 3 && valor >= 3000 * f) return { requiere: true, motivo: `Ya se hicieron ${turno.n} egresos en este turno.` };
    return { requiere: false };
  }
  return { requiere: false };
}

// ── Pedidos de autorización ────────────────────────────────────────────────────────────────────
async function pedir(p, db = pool, opts = {}) {
  await asegurar(db);
  await db.query(`UPDATE autorizaciones_caja SET estado = 'vencida', resuelto_en = NOW()
                   WHERE negocio_id = $1 AND estado = 'pendiente' AND creado < NOW() - ($2::int * INTERVAL '1 minute')`, [p.negocio_id, VENCE_MIN]);
  const ex = await db.query(
    `SELECT * FROM autorizaciones_caja WHERE turno_id = $1 AND clave = $2 AND estado = 'pendiente' ORDER BY id DESC LIMIT 1`, [p.turno_id, p.clave]);
  if (ex.rows[0]) return ex.rows[0];
  let nombre = p.producto_nombre || null;
  if (!nombre && p.producto_id) {
    const r = await db.query('SELECT nombre FROM productos WHERE id = $1 AND negocio_id = $2', [p.producto_id, p.negocio_id]);
    nombre = r.rows[0] ? r.rows[0].nombre : null;
  }
  const ins = await db.query(
    `INSERT INTO autorizaciones_caja (negocio_id, usuario_id, turno_id, empleado, tipo, clave, producto_id, producto_nombre, valor, motivo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [p.negocio_id, p.usuario_id || null, p.turno_id, p.empleado || null, p.tipo, p.clave, p.producto_id || null, nombre, Number(p.valor) || 0, p.motivo || null]);
  const a = ins.rows[0];
  // aviso al dueño (sin nombres en el celular)
  try {
    if (a.usuario_id) {
      const notificar = opts.notificar || require('./push').notificarUsuario;
      await notificar(a.usuario_id, {
        title: 'Hay una acción en la caja que necesita tu autorización',
        body: `${a.motivo || 'Una acción se salió de lo habitual.'} Aprobala o rechazala desde LumoBi.`,
        url: '/empleados',
      }, db, 'alertas_criticas');
    }
  } catch (e) { console.error('[autorizacion] aviso al dueño:', e.message); }
  return a;
}

// ¿Esta acción ya tiene el visto bueno del dueño? (consume la aprobación, o usa la ventana del PIN)
async function consumir(id, { turno_id, clave, tipo }, db = pool) {
  await asegurar(db);
  if (id) {
    const r = await db.query(
      `UPDATE autorizaciones_caja SET usada = true
        WHERE id = $1 AND turno_id = $2 AND clave = $3 AND estado = 'aprobada' AND usada = false
          AND resuelto_en >= NOW() - ($4::int * INTERVAL '1 minute') RETURNING id`, [id, turno_id, clave, USO_MIN]);
    if (r.rows[0]) return true;
  }
  const v = await db.query(
    `SELECT 1 FROM autorizaciones_caja WHERE turno_id = $1 AND tipo = $2 AND estado = 'aprobada' AND metodo = 'pin' AND ventana_hasta > NOW() LIMIT 1`, [turno_id, tipo]);
  return v.rows.length > 0;
}

async function leer(id, filtro, db = pool) {
  await asegurar(db);
  const r = await db.query(
    `SELECT * FROM autorizaciones_caja WHERE id = $1 AND ($2::int IS NULL OR turno_id = $2) AND ($3::int IS NULL OR negocio_id = $3)`,
    [id, filtro.turno_id || null, filtro.negocio_id || null]);
  const a = r.rows[0];
  if (!a) return null;
  if (a.estado === 'pendiente' && Date.now() - new Date(a.creado).getTime() > VENCE_MIN * 60000) {
    await db.query(`UPDATE autorizaciones_caja SET estado = 'vencida', resuelto_en = NOW() WHERE id = $1 AND estado = 'pendiente'`, [id]);
    a.estado = 'vencida';
  }
  return a;
}

async function hayPin(usuarioId, db = pool) {
  await asegurar(db);
  const r = await db.query('SELECT pin_autorizacion_hash FROM usuarios WHERE id = $1', [usuarioId]);
  return !!(r.rows[0] && r.rows[0].pin_autorizacion_hash);
}

async function fijarPin(usuarioId, pin, db = pool) {
  await asegurar(db);
  if (!/^\d{4}$/.test(String(pin))) throw Object.assign(new Error('El PIN tiene que ser de 4 números'), { codigo: 400 });
  const hash = await bcrypt.hash(String(pin), 10);
  await db.query('UPDATE usuarios SET pin_autorizacion_hash = $2, pin_autorizacion_fallos = 0, pin_autorizacion_bloqueo = NULL WHERE id = $1', [usuarioId, hash]);
}

// El dueño pone su PIN en la caja del empleado. Devuelve { ok, error?, restantes? }
async function aprobarConPin(id, turno_id, pin, db = pool) {
  const a = await leer(id, { turno_id }, db);
  if (!a) return { ok: false, error: 'No encontramos el pedido' };
  if (a.estado !== 'pendiente') return { ok: false, error: a.estado === 'aprobada' ? 'Ya está aprobado' : 'Este pedido ya no está disponible' };
  const u = (await db.query('SELECT pin_autorizacion_hash AS h, pin_autorizacion_fallos AS f, pin_autorizacion_bloqueo AS b FROM usuarios WHERE id = $1', [a.usuario_id])).rows[0];
  if (!u || !u.h) return { ok: false, error: 'El dueño todavía no configuró su PIN. Pedile la aprobación desde su celular.' };
  if (u.b && new Date(u.b) > new Date()) return { ok: false, error: 'Demasiados intentos. Probá de nuevo en unos minutos.' };
  const bien = await bcrypt.compare(String(pin || ''), u.h);
  if (!bien) {
    const fallos = (u.f || 0) + 1;
    await db.query('UPDATE autorizaciones_caja SET intentos = intentos + 1 WHERE id = $1', [id]);
    if (fallos >= MAX_INTENTOS_PIN) {
      await db.query(`UPDATE usuarios SET pin_autorizacion_fallos = 0, pin_autorizacion_bloqueo = NOW() + ($2::int * INTERVAL '1 minute') WHERE id = $1`, [a.usuario_id, BLOQUEO_PIN_MIN]);
      return { ok: false, error: 'Demasiados intentos. Probá de nuevo en unos minutos.' };
    }
    await db.query('UPDATE usuarios SET pin_autorizacion_fallos = $2 WHERE id = $1', [a.usuario_id, fallos]);
    return { ok: false, error: 'PIN incorrecto', restantes: MAX_INTENTOS_PIN - fallos };
  }
  await db.query('UPDATE usuarios SET pin_autorizacion_fallos = 0 WHERE id = $1', [a.usuario_id]);
  await db.query(
    `UPDATE autorizaciones_caja SET estado = 'aprobada', metodo = 'pin', resuelto_en = NOW(), ventana_hasta = NOW() + ($2::int * INTERVAL '1 minute') WHERE id = $1`, [id, VENTANA_PIN_MIN]);
  return { ok: true };
}

// El dueño decide desde su celular
async function resolverDueno(id, negocioId, decision, db = pool) {
  const a = await leer(id, { negocio_id: negocioId }, db);
  if (!a) return { ok: false, error: 'No encontramos el pedido', codigo: 404 };
  if (a.estado !== 'pendiente') return { ok: false, error: 'Este pedido ya no está pendiente', codigo: 409 };
  const estado = decision === 'aprobar' ? 'aprobada' : 'rechazada';
  await db.query(`UPDATE autorizaciones_caja SET estado = $2, metodo = 'app', resuelto_en = NOW() WHERE id = $1`, [id, estado]);
  return { ok: true, estado };
}

async function cancelar(id, turno_id, db = pool) {
  await asegurar(db);
  await db.query(`UPDATE autorizaciones_caja SET estado = 'cancelada', resuelto_en = NOW() WHERE id = $1 AND turno_id = $2 AND estado = 'pendiente'`, [id, turno_id]);
}

async function listar(negocioId, db = pool) {
  await asegurar(db);
  await db.query(`UPDATE autorizaciones_caja SET estado = 'vencida', resuelto_en = NOW()
                   WHERE negocio_id = $1 AND estado = 'pendiente' AND creado < NOW() - ($2::int * INTERVAL '1 minute')`, [negocioId, VENCE_MIN]);
  const r = await db.query(
    `SELECT id, empleado, tipo, producto_nombre, valor::float AS valor, motivo, estado, metodo, creado, resuelto_en
       FROM autorizaciones_caja WHERE negocio_id = $1 AND creado >= NOW() - INTERVAL '30 days'
      ORDER BY (estado = 'pendiente') DESC, creado DESC LIMIT 60`, [negocioId]);
  return r.rows;
}

// ── La guardia que usan las rutas de la caja ────────────────────────────────────────────────────
// req.turno viene de authTurno. accion: { tipo, clave, valor, pct?, producto_id?, producto_nombre? }.
// Devuelve true si la acción puede seguir; si no, ya respondió 403 con los datos para pedir autorización.
async function guardia(req, res, accion, opts = {}) {
  try {
    const t = req.turno;
    await asegurar();
    const aid = parseInt(req.headers['x-autorizacion'], 10) || null;
    if (await consumir(aid, { turno_id: t.id, clave: accion.clave, tipo: accion.tipo })) return true;
    const ev = await evaluar({ ...accion, negocio_id: t.negocio_id, turno_id: t.id, empleado: t.nombre_empleado }, pool, opts);
    if (!ev.requiere) return true;
    const a = await pedir({ ...accion, negocio_id: t.negocio_id, usuario_id: t.usuario_id, turno_id: t.id, empleado: t.nombre_empleado, motivo: ev.motivo }, pool, opts);
    res.status(403).json({
      requiere_autorizacion: true, autorizacion_id: a.id, motivo: ev.motivo,
      error: 'Esta acción necesita autorización del dueño.', puede_pin: await hayPin(t.usuario_id),
    });
    return false;
  } catch (e) {
    console.error('[autorizacion] guardia (la caja sigue):', e.message);
    return true;
  }
}

module.exports = { evaluar, pedir, consumir, leer, aprobarConPin, resolverDueno, cancelar, listar, fijarPin, hayPin, guardia, asegurar, TIPOS, VENCE_MIN };
