// routes_analitica.js — Analitica propia de LumoBi (embudo + uso de la app).
//   POST /api/analitica/evento   (publico) recibe lotes de eventos anonimos desde el navegador
//   GET  /api/analitica/resumen  (solo vos, con la clave) ?dias=7  -> embudo, pantallas, acciones, errores, origen
//
// Privacidad: no se guarda IP, ni textos escritos por el usuario, ni montos. Solo nombres de pantallas,
// botones y endpoints. El visitante es un codigo al azar guardado en el navegador (sin cookies de terceros).
// La clave del resumen es ANALITICA_KEY (si no existe, usa VIGILANTE_KEY o INTERNAL_KEY).

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('./db');

const TIPOS = new Set([
  'pantalla', 'tiempo', 'click', 'cta_landing', 'scroll', 'accion_api',
  'registro_envio', 'registro_ok', 'registro_error', 'login_ok', 'login_error', 'error', 'api_error',
]);
const TZ = 'America/Argentina/Buenos_Aires';

let listo = null;
function asegurarTabla() {
  if (!listo) {
    listo = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS analitica_eventos (
        id BIGSERIAL PRIMARY KEY,
        creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        visitante VARCHAR(40) NOT NULL,
        sesion VARCHAR(40),
        usuario_id VARCHAR(64),
        negocio_id VARCHAR(64),
        tipo VARCHAR(24) NOT NULL,
        ruta VARCHAR(120),
        d JSONB,
        disp VARCHAR(4),
        ref VARCHAR(80),
        utm VARCHAR(120)
      )`);
      await pool.query('CREATE INDEX IF NOT EXISTS analitica_eventos_creado ON analitica_eventos (creado)');
      await pool.query('CREATE INDEX IF NOT EXISTS analitica_eventos_tipo ON analitica_eventos (tipo, creado)');
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

function txt(x, max) {
  if (x === undefined || x === null) return null;
  const s = String(x).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  return s || null;
}

function limpiarD(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(d)) {
    if (n++ >= 8) break;
    const v = d[k];
    if (typeof v === 'number' && isFinite(v)) out[k.slice(0, 12)] = v;
    else if (typeof v === 'boolean') out[k.slice(0, 12)] = v;
    else if (typeof v === 'string') out[k.slice(0, 12)] = v.slice(0, 80);
  }
  return Object.keys(out).length ? out : null;
}

// Freno simple por IP (en memoria). La IP no se guarda.
const frenos = new Map();
function pasaFreno(clave, limite, ventanaMs) {
  const ahora = Date.now();
  const f = frenos.get(clave);
  if (!f || ahora - f.t0 > ventanaMs) { frenos.set(clave, { t0: ahora, n: 1 }); return true; }
  f.n += 1;
  return f.n <= limite;
}
setInterval(() => { const l = Date.now() - 120000; for (const [k, v] of frenos) if (v.t0 < l) frenos.delete(k); }, 60000).unref();
function ipDe(req) { return String((req.headers['x-forwarded-for'] || req.ip || '')).split(',')[0].trim(); }

router.post('/evento', express.text({ type: '*/*', limit: '32kb' }), async (req, res) => {
  try {
    if (!pasaFreno('e:' + ipDe(req), 240, 60000)) return res.status(429).end();
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    if (!b || typeof b !== 'object' || !Array.isArray(b.e)) return res.status(400).end();
    const v = txt(b.v, 40);
    if (!v) return res.status(400).end();
    const s = txt(b.s, 40), u = txt(b.u, 64), n = txt(b.n, 64);
    const disp = txt(b.disp, 4), ref = txt(b.ref, 80), utm = txt(b.utm, 120);
    const filas = [];
    for (const e of b.e.slice(0, 25)) {
      if (!e || !TIPOS.has(e.t)) continue;
      filas.push([v, s, u, n, e.t, txt(e.r, 120), limpiarD(e.d), disp, ref, utm]);
    }
    res.status(204).end();
    if (!filas.length) return;
    await asegurarTabla();
    const vals = [];
    const ph = filas.map((f, i) => {
      const o = i * 10;
      vals.push(f[0], f[1], f[2], f[3], f[4], f[5], f[6] ? JSON.stringify(f[6]) : null, f[7], f[8], f[9]);
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7}::jsonb,$${o + 8},$${o + 9},$${o + 10})`;
    });
    await pool.query(
      'INSERT INTO analitica_eventos (visitante,sesion,usuario_id,negocio_id,tipo,ruta,d,disp,ref,utm) VALUES ' + ph.join(','),
      vals
    );
  } catch (e) {
    console.error('[ANALITICA] evento:', e.message);
    if (!res.headersSent) res.status(500).end();
  }
});

function claveOk(req) {
  const esperada = process.env.ANALITICA_KEY || process.env.VIGILANTE_KEY || process.env.INTERNAL_KEY;
  if (!esperada) return 'sin_clave';
  const h = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-internal-key'] || '');
  const a = crypto.createHash('sha256').update(h).digest();
  const b = crypto.createHash('sha256').update(esperada).digest();
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'mal';
}

async function resumen(dias) {
  await asegurarTabla();
  const desde = new Date(Date.now() - dias * 86400000);
  const P = [desde];
  const q = async (sql, p) => (await pool.query(sql, p || P)).rows;
  const DIA = `(creado AT TIME ZONE '${TZ}')::date`;
  const quien = 'COALESCE(usuario_id, visitante)';

  const [tot] = await q(`SELECT COUNT(DISTINCT visitante)::int visitantes, COUNT(DISTINCT sesion)::int sesiones,
      COUNT(*)::int eventos, COUNT(DISTINCT usuario_id)::int usuarios, COUNT(DISTINCT negocio_id)::int negocios
    FROM analitica_eventos WHERE creado >= $1`);

  const [f] = await q(`SELECT
      COUNT(DISTINCT visitante) FILTER (WHERE tipo='pantalla' AND ruta='/landing')::int landing,
      COUNT(DISTINCT visitante) FILTER (WHERE tipo='scroll' AND ruta='/landing' AND (d->>'pct')::int >= 50)::int scroll50,
      COUNT(DISTINCT visitante) FILTER (WHERE tipo='cta_landing')::int cta,
      COUNT(DISTINCT visitante) FILTER (WHERE tipo='pantalla' AND ruta='/login')::int login,
      COUNT(DISTINCT visitante) FILTER (WHERE tipo='registro_envio')::int envio,
      COUNT(DISTINCT visitante) FILTER (WHERE tipo='registro_ok')::int registrados,
      COUNT(DISTINCT visitante) FILTER (WHERE tipo='pantalla' AND ruta IN ('/dashboard','/'))::int dashboard,
      COUNT(DISTINCT visitante) FILTER (WHERE tipo='pantalla' AND ruta='/fugas')::int fugas,
      COUNT(DISTINCT visitante) FILTER (WHERE tipo='click' AND d->>'t' ILIKE 'activar%')::int activar
    FROM analitica_eventos WHERE creado >= $1`);
  const [vuelven] = await q(`SELECT COUNT(*)::int n FROM (
      SELECT usuario_id FROM analitica_eventos WHERE creado >= $1 AND usuario_id IS NOT NULL
      GROUP BY usuario_id HAVING COUNT(DISTINCT ${DIA}) >= 2) x`);
  const embudo = [
    { paso: 'Vieron la landing', n: f.landing },
    { paso: 'Bajaron hasta la mitad de la landing', n: f.scroll50 },
    { paso: 'Tocaron "Probar gratis"', n: f.cta },
    { paso: 'Llegaron al login o registro', n: f.login },
    { paso: 'Enviaron el registro', n: f.envio },
    { paso: 'Se registraron', n: f.registrados },
    { paso: 'Vieron el dashboard', n: f.dashboard },
    { paso: 'Vieron Fugas', n: f.fugas },
    { paso: 'Volvieron otro día (usuarios)', n: vuelven.n },
    { paso: 'Tocaron "Activar plan"', n: f.activar },
  ];

  const pantallas = await q(`
    WITH v AS (SELECT ruta, COUNT(*)::int vistas, COUNT(DISTINCT ${quien})::int personas
               FROM analitica_eventos WHERE creado >= $1 AND tipo='pantalla' GROUP BY ruta),
         t AS (SELECT ruta, ROUND(AVG((d->>'seg')::numeric))::int seg_medio
               FROM analitica_eventos WHERE creado >= $1 AND tipo='tiempo' AND d ? 'seg' GROUP BY ruta),
         u AS (SELECT ruta, COUNT(*)::int salidas FROM (
                 SELECT DISTINCT ON (sesion) sesion, ruta FROM analitica_eventos
                 WHERE creado >= $1 AND tipo='pantalla' AND sesion IS NOT NULL ORDER BY sesion, creado DESC) z GROUP BY ruta)
    SELECT v.ruta, v.vistas, v.personas, COALESCE(t.seg_medio,0) seg_medio, COALESCE(u.salidas,0) salidas
    FROM v LEFT JOIN t USING (ruta) LEFT JOIN u USING (ruta) ORDER BY v.vistas DESC LIMIT 60`);

  const acciones = await q(`
    SELECT tipo, ruta, COALESCE(d->>'t', d->>'p') AS que, COUNT(*)::int veces, COUNT(DISTINCT ${quien})::int personas
    FROM analitica_eventos WHERE creado >= $1 AND tipo IN ('click','accion_api','cta_landing') AND COALESCE(d->>'t', d->>'p') IS NOT NULL
    GROUP BY tipo, ruta, que ORDER BY veces DESC LIMIT 60`);

  const porDia = await q(`
    SELECT ${DIA}::text dia, COUNT(DISTINCT visitante)::int visitantes, COUNT(DISTINCT usuario_id)::int usuarios,
           COUNT(DISTINCT visitante) FILTER (WHERE tipo='registro_ok')::int registros
    FROM analitica_eventos WHERE creado >= $1 GROUP BY 1 ORDER BY 1`);

  const origen = await q(`
    SELECT COALESCE(NULLIF(utm,''), NULLIF(ref,''), 'directo') AS origen, COUNT(DISTINCT visitante)::int visitantes,
           COUNT(DISTINCT visitante) FILTER (WHERE tipo='registro_ok')::int registros
    FROM analitica_eventos WHERE creado >= $1 GROUP BY 1 ORDER BY visitantes DESC LIMIT 15`);

  const dispositivos = await q(`SELECT COALESCE(disp,'?') disp, COUNT(DISTINCT visitante)::int visitantes
    FROM analitica_eventos WHERE creado >= $1 GROUP BY 1 ORDER BY 2 DESC`);

  const errores = await q(`
    SELECT tipo, ruta, COALESCE(d->>'m', d->>'p') AS detalle, COALESCE(d->>'st','') AS estado, COUNT(*)::int veces, COUNT(DISTINCT ${quien})::int personas
    FROM analitica_eventos WHERE creado >= $1 AND tipo IN ('error','api_error','registro_error','login_error')
    GROUP BY 1,2,3,4 ORDER BY veces DESC LIMIT 25`);

  const scroll = await q(`
    SELECT (d->>'pct')::int pct, COUNT(DISTINCT visitante)::int visitantes
    FROM analitica_eventos WHERE creado >= $1 AND tipo='scroll' AND ruta='/landing' GROUP BY 1 ORDER BY 1`);

  let negocios = await q(`
    SELECT negocio_id, MAX(creado) ultimo, COUNT(DISTINCT ${DIA})::int dias_activos,
           COUNT(DISTINCT ruta) FILTER (WHERE tipo='pantalla')::int pantallas, COUNT(*)::int eventos
    FROM analitica_eventos WHERE creado >= $1 AND negocio_id IS NOT NULL
    GROUP BY negocio_id ORDER BY ultimo DESC LIMIT 25`);
  try {
    const ids = negocios.map((x) => x.negocio_id);
    if (ids.length) {
      const nom = await pool.query('SELECT id::text AS id, nombre FROM negocios WHERE id::text = ANY($1)', [ids]);
      const m = new Map(nom.rows.map((r) => [r.id, r.nombre]));
      negocios = negocios.map((x) => Object.assign({}, x, { nombre: m.get(x.negocio_id) || null }));
    }
  } catch (_) { /* si la tabla no tiene esa columna, se muestran los ids */ }

  // Cuentas y planes: se leen de la base de usuarios (el cobro automatico todavia no existe)
  let cuentas = null;
  const SQL_E = (filtro) => `SELECT COALESCE(subscription_status,'sin_estado') AS estado, COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE trial_inicio >= $1)::int AS nuevas FROM usuarios ${filtro} GROUP BY 1 ORDER BY n DESC`;
  const SQL_V = (filtro) => `SELECT COUNT(*)::int AS n FROM usuarios WHERE subscription_status='trial' AND trial_fin IS NOT NULL AND trial_fin < NOW() ${filtro}`;
  for (const filtro of ["(rol IS NULL OR rol='owner')", null]) {
    try {
      const g = await pool.query(SQL_E(filtro ? 'WHERE ' + filtro : ''), [desde]);
      const v = await pool.query(SQL_V(filtro ? 'AND ' + filtro : ''));
      cuentas = { por_estado: g.rows, trial_vencido_sin_pagar: v.rows[0].n };
      break;
    } catch (_) { /* prueba sin el filtro de rol */ }
  }

  return { dias, desde, totales: tot, embudo, cuentas, pantallas, acciones, por_dia: porDia, origen, dispositivos, errores, scroll_landing: scroll, negocios };
}

router.get('/resumen', async (req, res) => {
  try {
    if (!pasaFreno('r:' + ipDe(req), 30, 60000)) return res.status(429).json({ error: 'Demasiados intentos' });
    const c = claveOk(req);
    if (c === 'sin_clave') return res.status(503).json({ error: 'Falta configurar ANALITICA_KEY en el servidor' });
    if (c !== 'ok') return res.status(401).json({ error: 'Clave incorrecta' });
    const dias = Math.min(90, Math.max(1, parseInt(req.query.dias, 10) || 7));
    res.json(await resumen(dias));
  } catch (e) {
    console.error('[ANALITICA] resumen:', e.message);
    res.status(500).json({ error: 'No se pudo calcular el resumen' });
  }
});

router.resumen = resumen;
module.exports = router;
