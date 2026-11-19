// vencimientos.js — LumoBi · calendario de gastos que se repiten cada mes (punto 9 del plan).
//
//   GET    /api/vencimientos        -> próximos pagos con días que faltan, totales de 7 y 30 días y cuánto hay que vender para cubrirlos
//   POST   /api/vencimientos        { nombre, monto, dia_mes }  -> agrega un gasto mensual (alquiler, luz, sueldos, cuotas...)
//   DELETE /api/vencimientos/:id    -> lo saca
//
// Lo que el dueño carga es lo que se muestra. "Lo que hay que vender" compara contra VENTAS promedio, no contra ganancia:
// LumoBi no sabe cuánto de cada venta se va en mercadería sin los costos completos, y no lo estima acá.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');
const { FL, REAL } = require('./ventas_sql');

async function asegurarTabla(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS gastos_fijos (
    id SERIAL PRIMARY KEY, negocio_id INTEGER NOT NULL, nombre TEXT NOT NULL, monto NUMERIC(14,2) NOT NULL,
    dia_mes INTEGER NOT NULL CHECK (dia_mes BETWEEN 1 AND 31), activo BOOLEAN NOT NULL DEFAULT true,
    creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_gastos_fijos_neg ON gastos_fijos (negocio_id) WHERE activo`);
}

// Próxima fecha de pago (hora Argentina). Si el mes no tiene ese día (31 en abril), vence el último día del mes.
// Devuelve { fecha: 'YYYY-MM-DD', dias } con dias = días desde hoy (0 = hoy).
function proximoVencimiento(diaMes, ahora = new Date()) {
  const ar = new Date(ahora.getTime() - 3 * 3600 * 1000);
  const y = ar.getUTCFullYear(), m = ar.getUTCMonth(), hoy = ar.getUTCDate();
  const ultimo = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  let yy = y, mm = m, d = Math.min(diaMes, ultimo(y, m));
  if (d < hoy) { mm = m + 1; if (mm > 11) { mm = 0; yy = y + 1; } d = Math.min(diaMes, ultimo(yy, mm)); }
  const fecha = new Date(Date.UTC(yy, mm, d));
  const base = new Date(Date.UTC(y, m, hoy));
  return { fecha: fecha.toISOString().slice(0, 10), dias: Math.round((fecha - base) / 86400000) };
}

async function estado(negocioId, db = pool, ahora = new Date()) {
  await asegurarTabla(db);
  const [g, v] = await Promise.all([
    db.query(`SELECT id, nombre, monto::float AS monto, dia_mes FROM gastos_fijos WHERE negocio_id = $1 AND activo ORDER BY dia_mes`, [negocioId]),
    db.query(`SELECT COALESCE(SUM(monto),0)::float AS total, COUNT(DISTINCT ${FL}::date)::int AS dias
                FROM transacciones WHERE negocio_id = $1 AND ${REAL} AND fecha >= $2::timestamptz - INTERVAL '28 days' AND fecha < $2::timestamptz`,
      [negocioId, ahora.toISOString()]).catch(() => ({ rows: [{ total: 0, dias: 0 }] })),
  ]);
  const items = g.rows.map((x) => ({ ...x, monto: Math.round(x.monto), ...proximoVencimiento(x.dia_mes, ahora) })).sort((a, b) => a.dias - b.dias);
  const suma = (hasta) => items.filter((x) => x.dias <= hasta).reduce((s, x) => s + x.monto, 0);
  const diasConDatos = v.rows[0].dias;
  // Promedio de venta por día calendario en 28 días; solo si hay al menos 7 días con ventas
  const ventaDiaria = diasConDatos >= 7 ? Math.round(v.rows[0].total / 28) : null;
  const t30 = suma(30);
  return {
    items, total_7: suma(7), total_30: t30, total_mensual: items.reduce((s, x) => s + x.monto, 0),
    venta_diaria: ventaDiaria,
    dias_de_venta_para_cubrir: ventaDiaria && t30 > 0 ? Math.round(t30 / ventaDiaria * 10) / 10 : null,
    nota: 'Se compara con lo que vendés (ventas), no con lo que ganás: de cada venta una parte se va en mercadería.',
  };
}

router.get('/', auth, async (req, res) => {
  try { res.json(await estado(req.user.negocio_id)); }
  catch (e) { console.error('vencimientos:', e.message); res.status(500).json({ error: 'No pude leer los vencimientos.' }); }
});

router.post('/', auth, async (req, res) => {
  try {
    await asegurarTabla();
    const nombre = String((req.body && req.body.nombre) || '').trim().slice(0, 80);
    const monto = Number(req.body && req.body.monto);
    const dia = parseInt(req.body && req.body.dia_mes, 10);
    if (!nombre) return res.status(400).json({ error: 'Poné el nombre del gasto, por ejemplo "Alquiler".' });
    if (!Number.isFinite(monto) || monto <= 0 || monto > 1e10) return res.status(400).json({ error: 'Poné un monto válido.' });
    if (!(dia >= 1 && dia <= 31)) return res.status(400).json({ error: 'El día del mes tiene que estar entre 1 y 31.' });
    const n = (await pool.query(`SELECT COUNT(*)::int AS n FROM gastos_fijos WHERE negocio_id = $1 AND activo`, [req.user.negocio_id])).rows[0].n;
    if (n >= 60) return res.status(400).json({ error: 'Llegaste al máximo de gastos cargados.' });
    await pool.query(`INSERT INTO gastos_fijos (negocio_id, nombre, monto, dia_mes) VALUES ($1,$2,$3,$4)`, [req.user.negocio_id, nombre, Math.round(monto), dia]);
    res.json(await estado(req.user.negocio_id));
  } catch (e) { console.error('vencimientos POST:', e.message); res.status(500).json({ error: 'No pude guardar el gasto.' }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await asegurarTabla();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Gasto inválido.' });
    await pool.query(`UPDATE gastos_fijos SET activo = false WHERE id = $1 AND negocio_id = $2`, [id, req.user.negocio_id]);
    res.json(await estado(req.user.negocio_id));
  } catch (e) { console.error('vencimientos DELETE:', e.message); res.status(500).json({ error: 'No pude sacar el gasto.' }); }
});

// Para Qué hacer: lo que vence hoy o mañana
async function itemsParaQueHacer(negocioId, db = pool, ahora = new Date()) {
  const e = await estado(negocioId, db, ahora);
  const fmt = (n) => '$' + Math.round(n).toLocaleString('es-AR');
  return e.items.filter((x) => x.dias <= 1).map((x) => ({
    id: 'v:' + x.id, origen: 'vencimiento', hid: null, detector: null,
    titulo: `${x.dias === 0 ? 'Hoy' : 'Mañana'} vence ${x.nombre}: ${fmt(x.monto)}`,
    detalle: 'Un gasto fijo que cargaste.', evidencia: [], pesos: x.monto, pesos_texto: null, urgente: false,
    estado: 'nuevo', veces: 1, acciones: [], accion_texto: 'Ver los vencimientos', url: '/vencimientos', puede_responder: false,
  }));
}

module.exports = { router, estado, proximoVencimiento, itemsParaQueHacer, asegurarTabla };
