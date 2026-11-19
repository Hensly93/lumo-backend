// peso_lumobi.js — LumoBi · "cuánto pesa LumoBi" en cada negocio (punto 6 del plan). SOLO lo ve el dueño de LumoBi.
//
// Mide cuánto vive el negocio adentro de LumoBi: cuanto más pesa, más cuesta irse Y más valor recibe el cliente.
// Es una señal interna para acompañar a mano a quien se está soltando; el cliente nunca ve este número.
// Puntaje de 0 a 100, sumando seis cosas medibles (nada se estima ni se inventa):
//   historia 20   días con ventas en los últimos 30
//   caja     20   turnos cerrados en la última semana
//   costos   15   % de productos con costo cargado
//   facturas 15   facturas de proveedor cargadas en los últimos 30 días
//   acciones 20   consejos ejecutados (10) y medidos con plata recuperada (10), últimos 90 días
//   meta     10   meta del mes definida (5) y ventas en los últimos 7 días (5)
// Una foto por negocio por semana-día (tabla peso_lumobi). Si baja dos semanas seguidas, avisa al dueño de LumoBi.
const pool = require('./db');
const { FL, REAL, cuentaDePrueba } = require('./ventas_sql');

async function asegurarTabla(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS peso_lumobi (
    negocio_id INTEGER NOT NULL, fecha DATE NOT NULL, puntaje INTEGER NOT NULL, detalle JSONB,
    PRIMARY KEY (negocio_id, fecha))`);
}

const tope = (x, max) => Math.max(0, Math.min(max, x));

// Piezas puras (se prueban sin base)
function puntuar(m) {
  const historia = tope(m.dias_con_ventas_30 / 30 * 20, 20);
  const caja = tope(m.turnos_cerrados_7 / 5 * 20, 20);
  const costos = m.productos > 0 ? tope(m.con_costo / m.productos * 15, 15) : 0;
  const facturas = tope(m.facturas_30 / 4 * 15, 15);
  const acciones = tope(m.acciones_ejecutadas_90 >= 1 ? 10 : 0, 10) + (m.acciones_medidas_90 >= 1 ? 10 : 0);
  const meta = (m.meta ? 5 : 0) + (m.ventas_7 > 0 ? 5 : 0);
  const partes = { historia, caja, costos, facturas, acciones, meta };
  const redondeadas = Object.fromEntries(Object.entries(partes).map(([k, v]) => [k, Math.round(v)]));
  return { puntaje: Math.round(Object.values(partes).reduce((s, v) => s + v, 0)), partes: redondeadas };
}

// Baja dos semanas seguidas = las últimas 3 fotos (una por semana) bajan una tras otra, y en total al menos 8 puntos
function bajaDosSemanas(serie) {
  if (serie.length < 3) return false;
  const [a, b, c] = serie.slice(-3);
  return a > b && b > c && (a - c) >= 8;
}

async function medir(negocioId, db = pool) {
  const q = (sql, args = [negocioId]) => db.query(sql, args).then((r) => r.rows[0] || {}).catch(() => ({}));
  const [v, t, p, f, h, me] = await Promise.all([
    q(`SELECT COUNT(DISTINCT ${FL}::date)::int AS dias_30, COUNT(*) FILTER (WHERE fecha >= NOW() - INTERVAL '7 days')::int AS ventas_7
         FROM transacciones WHERE negocio_id = $1 AND ${REAL} AND COALESCE(tipo,'venta') = 'venta' AND fecha >= NOW() - INTERVAL '30 days'`),
    q(`SELECT COUNT(*)::int AS n FROM turnos_caja WHERE negocio_id = $1 AND estado = 'cerrado' AND hora_apertura >= NOW() - INTERVAL '7 days'`),
    q(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE precio_costo > 0)::int AS con_costo FROM productos WHERE negocio_id = $1 AND COALESCE(activo, true)`),
    q(`SELECT COUNT(*)::int AS n FROM compras WHERE negocio_id = $1 AND creado >= NOW() - INTERVAL '30 days'`),
    q(`SELECT COUNT(*) FILTER (WHERE resuelto_en >= NOW() - INTERVAL '90 days')::int AS ejecutadas,
              COUNT(*) FILTER (WHERE evaluado_en IS NOT NULL AND recuperado > 0 AND resuelto_en >= NOW() - INTERVAL '90 days')::int AS medidas
         FROM hallazgos WHERE negocio_id = $1`),
    q(`SELECT 1 AS ok FROM metas_negocio WHERE negocio_id = $1`),
  ]);
  const metricas = {
    dias_con_ventas_30: v.dias_30 || 0, ventas_7: v.ventas_7 || 0, turnos_cerrados_7: t.n || 0,
    productos: p.total || 0, con_costo: p.con_costo || 0, facturas_30: f.n || 0,
    acciones_ejecutadas_90: h.ejecutadas || 0, acciones_medidas_90: h.medidas || 0, meta: !!me.ok,
  };
  return { metricas, ...puntuar(metricas) };
}

// Foto de hoy para todos los negocios reales (cuentas de prueba afuera). Lo corre el job nocturno.
async function snapshotNocturno(db = pool) {
  await asegurarTabla(db);
  const negs = await db.query(
    `SELECT DISTINCT n.id FROM negocios n
       JOIN negocio_usuarios nu ON nu.negocio_id = n.id AND nu.rol = 'owner' AND nu.activo = true
       JOIN usuarios u ON u.id = nu.usuario_id
      WHERE n.deletion_scheduled_at IS NULL AND u.deletion_scheduled_at IS NULL AND NOT ${cuentaDePrueba('u')}`);
  let guardados = 0;
  for (const { id } of negs.rows) {
    try {
      const m = await medir(id, db);
      await db.query(
        `INSERT INTO peso_lumobi (negocio_id, fecha, puntaje, detalle) VALUES ($1, (NOW() - INTERVAL '3 hours')::date, $2, $3)
         ON CONFLICT (negocio_id, fecha) DO UPDATE SET puntaje = EXCLUDED.puntaje, detalle = EXCLUDED.detalle`,
        [id, m.puntaje, JSON.stringify({ partes: m.partes, metricas: m.metricas })]);
      guardados++;
    } catch (e) { console.error('[PESO] negocio', id, e.message); }
  }
  const avisos = await avisarBajas(db);
  return { paso: 'peso_lumobi', negocios: negs.rows.length, guardados, avisos };
}

// Una foto por semana (la más reciente de cada semana) para ver la tendencia
async function serieSemanal(negocioId, db = pool, semanas = 8) {
  const r = await db.query(
    `SELECT DISTINCT ON (date_trunc('week', fecha)) fecha, puntaje FROM peso_lumobi
      WHERE negocio_id = $1 AND fecha >= CURRENT_DATE - ($2::int * 7)
      ORDER BY date_trunc('week', fecha), fecha DESC`, [negocioId, semanas]);
  return r.rows.map((x) => ({ fecha: x.fecha, puntaje: x.puntaje }));
}

async function avisarBajas(db = pool) {
  let n = 0;
  try {
    const { avisarFundador } = require('./aviso_fundador');
    const negs = await db.query(`SELECT DISTINCT negocio_id FROM peso_lumobi WHERE fecha >= CURRENT_DATE - 21`);
    for (const { negocio_id } of negs.rows) {
      const serie = (await serieSemanal(negocio_id, db, 4)).map((x) => x.puntaje);
      if (!bajaDosSemanas(serie)) continue;
      const nom = (await db.query(`SELECT COALESCE(NULLIF(n.nombre,''), u.negocio) AS nombre FROM negocios n LEFT JOIN negocio_usuarios nu ON nu.negocio_id = n.id AND nu.rol='owner' LEFT JOIN usuarios u ON u.id = nu.usuario_id WHERE n.id = $1 LIMIT 1`, [negocio_id]).catch(() => ({ rows: [] }))).rows[0];
      const semana = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
      n += await avisarFundador({
        tipo: 'peso_baja', clave: `semana:${semana}`, negocioId: negocio_id,
        titulo: 'Un cliente se está soltando',
        mensaje: `${(nom && nom.nombre) || 'Un negocio'} usa cada vez menos LumoBi (${serie.slice(-3).join(' → ')} sobre 100). Es momento de escribirle.`,
        url: '/admin/embudo',
      }, db);
    }
  } catch (e) { console.error('[PESO] avisos:', e.message); }
  return n;
}

// Para el panel del dueño de LumoBi: último puntaje y tendencia de cada negocio
async function panel(db = pool) {
  await asegurarTabla(db);
  const r = await db.query(
    `SELECT DISTINCT ON (p.negocio_id) p.negocio_id, p.fecha, p.puntaje, p.detalle,
            COALESCE(NULLIF(n.nombre,''), 'Negocio ' || p.negocio_id) AS nombre
       FROM peso_lumobi p LEFT JOIN negocios n ON n.id = p.negocio_id
      ORDER BY p.negocio_id, p.fecha DESC`);
  const filas = [];
  for (const x of r.rows) {
    const serie = await serieSemanal(x.negocio_id, db, 6);
    const pts = serie.map((s) => s.puntaje);
    filas.push({
      negocio_id: x.negocio_id, nombre: x.nombre, fecha: x.fecha, puntaje: x.puntaje,
      partes: (x.detalle && x.detalle.partes) || null, serie: pts,
      baja: bajaDosSemanas(pts),
      cambio: pts.length >= 2 ? pts[pts.length - 1] - pts[0] : null,
    });
  }
  return { negocios: filas.sort((a, b) => a.puntaje - b.puntaje), nota: 'Interno: el cliente no ve este número. 0 a 100; ordenado de menos a más peso.' };
}

module.exports = { asegurarTabla, puntuar, bajaDosSemanas, medir, snapshotNocturno, serieSemanal, panel };
