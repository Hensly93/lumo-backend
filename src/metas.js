// metas.js — LumoBi · la meta del mes del dueño (punto 4a del plan).
//
//   GET /api/meta?sucursal_id=   -> { definida, tipo, monto, vendido, ... }   (con login)
//   PUT /api/meta  { monto, tipo? } -> guarda la meta (monto 0 o null = la borra)
//
// La meta es del NEGOCIO ENTERO. Si el dueño mira un solo local, devolvemos lo vendido por ese local
// pero sin barra (no tiene sentido comparar un local contra la meta de todos).
// El ritmo esperado es lineal (meta × día / días del mes): es una referencia simple, no una predicción, y se dice así.
// Tipo por ahora: 'ventas'. 'ganancia' queda previsto pero se rechaza hasta tener costos cargados en la mayoría del catálogo.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { auth } = require('./authMiddleware');
const { FL, REAL } = require('./ventas_sql');

const TIPOS = ['ventas'];
const MONTO_MAX = 100000000000;

async function asegurarTabla(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS metas_negocio (
    negocio_id INTEGER PRIMARY KEY,
    tipo TEXT NOT NULL DEFAULT 'ventas',
    monto NUMERIC(16,2) NOT NULL,
    creada_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizada_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

// Fecha/hora Argentina como { anio, mes, dia, diasMes }. `ahora` permite simular en pruebas.
function fechaAR(ahora = new Date()) {
  const ar = new Date(ahora.getTime() - 3 * 3600 * 1000);
  const anio = ar.getUTCFullYear(); const mes = ar.getUTCMonth() + 1; const dia = ar.getUTCDate();
  return { anio, mes, dia, diasMes: new Date(Date.UTC(anio, mes, 0)).getUTCDate() };
}

async function estadoMeta(negocioId, sucursalId = null, db = pool, ahora = new Date()) {
  await asegurarTabla(db);
  const f = fechaAR(ahora);
  const desde = `${f.anio}-${String(f.mes).padStart(2, '0')}-01`;
  const [m, v, nsuc] = await Promise.all([
    db.query(`SELECT tipo, monto::float AS monto FROM metas_negocio WHERE negocio_id = $1`, [negocioId]),
    db.query(
      `SELECT COALESCE(SUM(monto),0)::float AS vendido FROM transacciones
        WHERE negocio_id = $1 AND ${REAL} AND ${FL}::date >= $2::date AND ${FL}::date <= $3::date
          AND ($4::integer IS NULL OR sucursal_id = $4)`,
      [negocioId, desde, `${desde.slice(0, 8)}${String(f.dia).padStart(2, '0')}`, sucursalId]),
    db.query(`SELECT COUNT(*)::int AS n FROM mis_sucursales WHERE negocio_id = $1`, [negocioId]).catch(() => ({ rows: [{ n: 0 }] })),
  ]);
  const vendido = Math.round(v.rows[0].vendido);
  const base = { mes: f.mes, anio: f.anio, dia: f.dia, dias_mes: f.diasMes, vendido };
  const meta = m.rows[0];
  if (!meta) return { ...base, definida: false };
  // Un solo local elegido entre varios: la meta es de todo el negocio, no se compara
  if (sucursalId != null && nsuc.rows[0].n > 1) return { ...base, definida: true, tipo: meta.tipo, monto: Math.round(meta.monto), solo_total: true };

  const monto = Math.round(meta.monto);
  const esperado = Math.round(monto * f.dia / f.diasMes);
  // Si sigue este ritmo, ¿cuánto cierra el mes? (solo con al menos 3 días de datos, antes es ruido)
  const proyeccion = f.dia >= 3 ? Math.round(vendido / f.dia * f.diasMes) : null;
  // Días de adelanto o atraso: cuántos días de ritmo parejo equivale la diferencia
  const ritmoDiario = monto / f.diasMes;
  const dias_adelanto = ritmoDiario > 0 ? Math.round(((vendido - esperado) / ritmoDiario) * 10) / 10 : 0;
  return {
    ...base, definida: true, tipo: meta.tipo, monto, esperado_a_hoy: esperado,
    pct: monto > 0 ? Math.round(vendido / monto * 100) : 0,
    dias_adelanto, proyeccion,
    cumplida: vendido >= monto,
    nota: 'El ritmo esperado es parejo todos los días del mes; no tiene en cuenta que algunos días se vende más que otros.',
  };
}

router.get('/', auth, async (req, res) => {
  try {
    const sid = req.query.sucursal_id ? parseInt(req.query.sucursal_id, 10) : null;
    res.json(await estadoMeta(req.user.negocio_id, Number.isInteger(sid) ? sid : null));
  } catch (e) { console.error('meta GET:', e.message); res.status(500).json({ error: 'No pude leer la meta' }); }
});

router.put('/', auth, async (req, res) => {
  try {
    const tipo = req.body.tipo || 'ventas';
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Por ahora la meta es de ventas.' });
    const monto = Number(req.body.monto);
    await asegurarTabla();
    if (!req.body.monto || monto === 0) {
      await pool.query(`DELETE FROM metas_negocio WHERE negocio_id = $1`, [req.user.negocio_id]);
      return res.json({ ok: true, definida: false });
    }
    if (!Number.isFinite(monto) || monto < 0 || monto > MONTO_MAX) return res.status(400).json({ error: 'Poné un monto válido.' });
    await pool.query(
      `INSERT INTO metas_negocio (negocio_id, tipo, monto) VALUES ($1,$2,$3)
       ON CONFLICT (negocio_id) DO UPDATE SET tipo = EXCLUDED.tipo, monto = EXCLUDED.monto, actualizada_en = NOW()`,
      [req.user.negocio_id, tipo, Math.round(monto)]);
    res.json({ ok: true, ...(await estadoMeta(req.user.negocio_id, null)) });
  } catch (e) { console.error('meta PUT:', e.message); res.status(500).json({ error: 'No pude guardar la meta' }); }
});

module.exports = { router, estadoMeta, asegurarTabla, fechaAR };
