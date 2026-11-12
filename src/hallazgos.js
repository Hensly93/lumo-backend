// hallazgos.js — el "cerebro" de LumoBi.
//   Guarda lo que el sistema detecta (cada hallazgo con su plata y su evidencia), decide cuáles merecen un
//   aviso (filtro de calidad) y aprende de lo que dice el dueño ("me sirvió", "no me sirve", "ya lo resolví").
//   · No hay tope de avisos por día: manda el filtro de calidad. Lo que no tiene plata, evidencia o datos
//     suficientes no se avisa nunca; lo que el dueño descartó se silencia.
//   · El Vigilante (vigilante.js) es quien manda los avisos: usa paraAvisar() y no repite lo mismo
//     salvo que empeore.
// Todas las consultas filtran por negocio_id.
const pool = require('./db');

const MIN_ABS = 5000;           // por debajo de este monto mensual nunca se avisa
const PCT_CALCULADO = 0.015;    // un hallazgo medido o calculado tiene que valer al menos 1,5% de las ventas del mes
const PCT_ESTIMADO = 0.03;      // una estimación (más especulativa) tiene que valer 3%
const MIN_DIAS_ESTIMADO = 2;    // una estimación tiene que verse en 2 días distintos antes de avisarla
const DIAS_AUMENTOS = 45;
const TTL_MS = 10 * 60 * 1000;
const SILENCIO_DIAS = { no_sirve: 60, ya_lo_sabia: 30, resuelto: 30 };
const ESTADO_DE = { util: 'util', no_sirve: 'descartado', ya_lo_sabia: 'sabido', resuelto: 'resuelto' };
const ACCIONES = Object.keys(ESTADO_DE);
// Plata recuperada: solo para hallazgos con monto MENSUAL comparable. A los 28 dias de marcado como resuelto se mide cuanto bajo.
const { receta } = require('./acciones');
const MENSUALES = ['dia_debil', 'franja_floja', 'comisiones_cobro', 'ticket_baja', 'precio_bajo_costo', 'marca_margen_bajo'];
const DIAS_MEDIR = 28;
const MIN_MEJORA = 0.2;
const ACCION_TEXTO = {
  dia_debil: 'Ver ventas por día', franja_floja: 'Ver ventas por hora', ticket_baja: 'Ver tu ticket promedio', ticket_sube: 'Ver tu ticket promedio',
  comisiones_cobro: 'Ver cobros por medio de pago', aumentos_proveedor: 'Revisar las facturas', fuga: 'Ver cómo cerrar la fuga',
  precio_bajo_costo: 'Revisar tus precios y costos', marca_margen_bajo: 'Revisar los precios de esta marca',
};
const fmt = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('es-AR');

let tablaLista = null;
function asegurarTabla(db = pool) {
  if (!tablaLista) {
    tablaLista = (async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS hallazgos (
        id SERIAL PRIMARY KEY,
        negocio_id INTEGER NOT NULL,
        clave TEXT NOT NULL,
        detector TEXT NOT NULL,
        titulo TEXT NOT NULL,
        detalle TEXT,
        evidencia JSONB NOT NULL DEFAULT '[]',
        monto NUMERIC(14,2) NOT NULL DEFAULT 0,
        monto_texto TEXT,
        tipo TEXT NOT NULL,
        url TEXT,
        positivo BOOLEAN NOT NULL DEFAULT false,
        ignora_suficiente BOOLEAN NOT NULL DEFAULT false,
        vigente BOOLEAN NOT NULL DEFAULT true,
        estado TEXT NOT NULL DEFAULT 'nuevo',
        primera_vez TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ultima_vez TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        veces INTEGER NOT NULL DEFAULT 1,
        silenciado_hasta TIMESTAMPTZ,
        feedback TEXT,
        feedback_en TIMESTAMPTZ,
        UNIQUE (negocio_id, clave)
      )`);
      await db.query('CREATE INDEX IF NOT EXISTS idx_hallazgos_neg ON hallazgos (negocio_id, vigente)');
      await db.query(`ALTER TABLE hallazgos ADD COLUMN IF NOT EXISTS resuelto_en TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS monto_al_resolver NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS monto_al_medir NUMERIC(14,2), ADD COLUMN IF NOT EXISTS recuperado NUMERIC(14,2), ADD COLUMN IF NOT EXISTS evaluado_en TIMESTAMPTZ`);
      await db.query(`ALTER TABLE hallazgos ADD COLUMN IF NOT EXISTS accion_id TEXT, ADD COLUMN IF NOT EXISTS accion_titulo TEXT, ADD COLUMN IF NOT EXISTS accion_en TIMESTAMPTZ`);
    })().catch((e) => { tablaLista = null; throw e; });
  }
  return tablaLista;
}

const detectorDe = (id) => (String(id).startsWith('fuga_') ? 'fuga' : String(id).replace(/_\d+$/, ''));

// ── Filtro de calidad (puro) ─────────────────────────────────────────────────
// h: fila del hallazgo. ctx: { suficiente, ventas_mes }. Devuelve { pasa, motivo }.
// ── Aprendizaje: el piso de monto se ajusta por tipo de hallazgo según lo que dice el dueño ──────────────────────
// Si marca seguido "no me sirve" / "ya lo sabía" en un tipo, ese tipo solo se muestra con montos más altos.
// Si le sirven seguido ("me sirvió" / "ya lo resolví"), se muestra con montos algo menores. Nunca baja de la mitad del piso.
function factorSensibilidad(neg, pos) {
  if (neg >= 4 && pos === 0) return 3;
  if (neg >= 2 && neg > 2 * pos) return 2;
  if (pos >= 2 && pos > neg) return 0.7;
  return 1;
}

async function calcularSensibilidad(negocioId, db = pool) {
  const r = await db.query(
    `SELECT detector, COUNT(*) FILTER (WHERE feedback IN ('no_sirve', 'ya_lo_sabia'))::int AS neg,
            COUNT(*) FILTER (WHERE feedback IN ('util', 'resuelto'))::int AS pos
       FROM hallazgos WHERE negocio_id = $1 AND feedback IS NOT NULL GROUP BY detector`, [negocioId]);
  const out = {};
  for (const x of r.rows) { const f = factorSensibilidad(x.neg, x.pos); if (f !== 1) out[x.detector] = f; }
  return out;
}

function puerta(h, ctx, ahora = new Date()) {
  if (h.positivo) return { pasa: false, motivo: 'positivo' };
  if (!ctx.suficiente && !h.ignora_suficiente) return { pasa: false, motivo: 'pocos_datos' };
  if (!Array.isArray(h.evidencia) || !h.evidencia.length) return { pasa: false, motivo: 'sin_evidencia' };
  const monto = Number(h.monto) || 0;
  const factor = (ctx.sensibilidad && ctx.sensibilidad[h.detector || detectorDe(h.clave || h.id || '')]) || 1;
  const base = Math.max(MIN_ABS, (Number(ctx.ventas_mes) || 0) * (h.tipo === 'estimado' ? PCT_ESTIMADO : PCT_CALCULADO));
  const piso = Math.max(MIN_ABS / 2, base * factor);
  if (monto < piso) return { pasa: false, motivo: 'monto_bajo', piso };
  if (h.silenciado_hasta && new Date(h.silenciado_hasta) > ahora) return { pasa: false, motivo: 'silenciado' };
  if (h.tipo === 'estimado' && (Number(h.veces) || 1) < MIN_DIAS_ESTIMADO) return { pasa: false, motivo: 'recien_visto' };
  return { pasa: true, motivo: 'ok', piso };
}

// ── Detector nuevo: proveedores que subieron precios (sale de las facturas cargadas) ──
async function detectarAumentos(negocioId, db = pool) {
  let r;
  try {
    r = await db.query(
      `WITH x AS (
         SELECT i.descripcion, c.proveedor, c.fecha, i.cantidad::float AS cantidad, i.precio_unitario::float AS precio,
                LAG(i.precio_unitario) OVER w AS ant
           FROM compras_items i JOIN compras c ON c.id = i.compra_id
          WHERE c.negocio_id = $1 AND i.precio_unitario > 0
         WINDOW w AS (PARTITION BY i.clave ORDER BY c.fecha, c.id))
       SELECT descripcion, proveedor, cantidad, precio, ant::float AS ant
         FROM x WHERE ant > 0 AND fecha >= (NOW() - INTERVAL '3 hours')::date - $2::int AND precio / ant::float - 1 >= 0.05`,
      [negocioId, DIAS_AUMENTOS]);
  } catch (e) {
    if (e.code === '42P01') return null;   // todavía no cargó ninguna factura
    throw e;
  }
  if (!r.rows.length) return null;
  const filas = r.rows.map((x) => ({ ...x, extra: (x.precio - x.ant) * x.cantidad, pct: Math.round((x.precio / x.ant - 1) * 100) }));
  const extra = Math.round(filas.reduce((s, x) => s + x.extra, 0));
  if (extra <= 0) return null;
  return {
    id: 'aumentos_proveedor', tipo: 'calculado', ignora_suficiente: true,
    titulo: `Tus proveedores te subieron precios: pagaste ${fmt(extra)} más que en la compra anterior`,
    detalle: `${filas.length} ${filas.length === 1 ? 'producto subió' : 'productos subieron'} en los últimos ${DIAS_AUMENTOS} días.`,
    evidencia: [
      ...filas.sort((a, b) => b.extra - a.extra).slice(0, 3).map((x) => `${x.descripcion}: +${x.pct}% (de ${fmt(x.ant)} a ${fmt(x.precio)}), ${x.proveedor}.`),
      'Es la diferencia de precio multiplicada por la cantidad de tu última compra de cada producto.',
    ],
    monto: extra, monto_texto: `${fmt(extra)} de más en tu última compra`, url: '/compras',
  };
}

// ── Detectar + guardar ───────────────────────────────────────────────────────
async function detectar(negocioId, db = pool, opts = {}) {
  const calc = opts.radiografia || ((id) => require('./radiografia').calcularRadiografia(id, db, { completo: true, fuentes: opts.fuentes }));
  const rad = await calc(negocioId);
  const lista = (rad.hallazgos || []).map((h) => ({ ...h }));
  try { const a = await (opts.aumentos || detectarAumentos)(negocioId, db); if (a) lista.push(a); }
  catch (e) { console.error('hallazgos/aumentos:', e.message); }
  try { for (const m of await (opts.marcas || require('./detector_marcas').detectarMarcas)(negocioId, db)) lista.push(m); }
  catch (e) { console.error('hallazgos/marcas:', e.message); }
  return { lista, ctx: {
    suficiente: !!rad.suficiente, ventas_mes: Number(rad.ventas_mes) || 0,
    dias_con_ventas: Number(rad.dias_con_ventas) || 0, dias_necesarios: Number(rad.dias_necesarios) || 14, faltan_dias: Number(rad.faltan_dias) || 0,
  } };
}

const cache = new Map();   // negocio_id -> { ts, ctx }

async function procesar(negocioId, db = pool, opts = {}) {
  await asegurarTabla(db);
  const { lista, ctx } = await detectar(negocioId, db, opts);
  const claves = [];
  for (const h of lista) {
    claves.push(h.id);
    await db.query(
      `INSERT INTO hallazgos (negocio_id, clave, detector, titulo, detalle, evidencia, monto, monto_texto, tipo, url, positivo, ignora_suficiente)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (negocio_id, clave) DO UPDATE SET
         titulo = EXCLUDED.titulo, detalle = EXCLUDED.detalle, evidencia = EXCLUDED.evidencia, monto = EXCLUDED.monto,
         monto_texto = EXCLUDED.monto_texto, tipo = EXCLUDED.tipo, url = EXCLUDED.url, positivo = EXCLUDED.positivo,
         ignora_suficiente = EXCLUDED.ignora_suficiente, vigente = true,
         veces = hallazgos.veces + CASE WHEN (hallazgos.ultima_vez - INTERVAL '3 hours')::date < (NOW() - INTERVAL '3 hours')::date THEN 1 ELSE 0 END,
         ultima_vez = NOW()`,
      [negocioId, h.id, detectorDe(h.id), String(h.titulo).slice(0, 300), h.detalle || null, JSON.stringify(h.evidencia || []),
       Number(h.monto) || 0, h.monto_texto || null, h.tipo || 'calculado', h.url || null, !!h.positivo, !!h.ignora_suficiente]);
  }
  await db.query('UPDATE hallazgos SET vigente = false WHERE negocio_id = $1 AND vigente AND NOT (clave = ANY($2::text[]))', [negocioId, claves]);
  ctx.sensibilidad = await calcularSensibilidad(negocioId, db).catch(() => ({}));
  cache.set(negocioId, { ts: Date.now(), ctx });
  return ctx;
}

async function leerVigentes(negocioId, db, ctx, ahora) {
  const r = await db.query(
    `SELECT id, clave, detector, titulo, detalle, evidencia, monto::float AS monto, monto_texto, tipo, url, positivo, ignora_suficiente,
            estado, veces, primera_vez, ultima_vez, silenciado_hasta, feedback
       FROM hallazgos WHERE negocio_id = $1 AND vigente ORDER BY monto DESC`, [negocioId]);
  return r.rows.map((h) => ({ ...h, puerta: puerta(h, ctx, ahora) }));
}

// Hallazgos vigentes del negocio, cada uno con lo que decidió el filtro de calidad.
async function obtener(negocioId, db = pool, opts = {}) {
  await asegurarTabla(db);
  const c = cache.get(negocioId);
  const ctx = !opts.forzar && c && Date.now() - c.ts < TTL_MS ? c.ctx : await procesar(negocioId, db, opts);
  return leerVigentes(negocioId, db, ctx, opts.ahora || new Date());
}

// Lo que el Vigilante puede avisar ahora: el mejor hallazgo que pasa el filtro (las fugas tienen su propio aviso).
async function paraAvisar(negocioId, db = pool, opts = {}) {
  await asegurarTabla(db);
  const ctx = await procesar(negocioId, db, opts);
  const filas = await leerVigentes(negocioId, db, ctx, opts.ahora || new Date());
  return filas.filter((h) => h.puerta.pasa && h.detector !== 'fuga').slice(0, 1);
}

// Lo que muestra la Radiografía: los 3 hallazgos más valiosos de los vigentes, sin los que el dueño descartó o resolvió.
// Cada uno trae "hid" (su número) para poder responder "me sirvió / no me sirve / ya lo resolví".
async function radiografia(negocioId, db = pool, opts = {}) {
  const filas = await obtener(negocioId, db, opts);
  const ctx = (cache.get(negocioId) || {}).ctx || { suficiente: false, dias_con_ventas: 0, dias_necesarios: 14, faltan_dias: 14 };
  const ahora = opts.ahora || new Date();
  const visibles = filas.filter((h) => !(h.silenciado_hasta && new Date(h.silenciado_hasta) > ahora));
  const top = require('./radiografia').elegir(visibles, 3);
  return {
    suficiente: ctx.suficiente, dias_con_ventas: ctx.dias_con_ventas, dias_necesarios: ctx.dias_necesarios, faltan_dias: ctx.faltan_dias,
    hallazgos: top.map((h) => ({
      id: h.clave, hid: h.id, accion_texto: ACCION_TEXTO[h.detector] || undefined, acciones: h.positivo ? [] : receta(h.detector, h.clave), tipo: h.tipo, titulo: h.titulo, detalle: h.detalle || '', evidencia: h.evidencia || [],
      monto: h.monto, monto_texto: h.monto_texto || undefined, url: h.url || '/', positivo: h.positivo || undefined,
    })),
  };
}

// ── Aprendizaje: lo que dice el dueño ────────────────────────────────────────
async function registrarFeedback(negocioId, id, accion, db = pool) {
  if (!ACCIONES.includes(accion)) throw Object.assign(new Error('Acción inválida'), { status: 400 });
  await asegurarTabla(db);
  const dias = SILENCIO_DIAS[accion] || 0;
  const r = await db.query(
    `UPDATE hallazgos SET estado = $3, feedback = $4, feedback_en = NOW(),
            silenciado_hasta = CASE WHEN $5::int > 0 THEN NOW() + ($5::int * INTERVAL '1 day') ELSE silenciado_hasta END,
            resuelto_en = CASE WHEN $4 = 'resuelto' THEN NOW() ELSE resuelto_en END,
            monto_al_resolver = CASE WHEN $4 = 'resuelto' THEN monto ELSE monto_al_resolver END,
            recuperado = CASE WHEN $4 = 'resuelto' THEN NULL ELSE recuperado END,
            monto_al_medir = CASE WHEN $4 = 'resuelto' THEN NULL ELSE monto_al_medir END,
            evaluado_en = CASE WHEN $4 = 'resuelto' THEN NULL ELSE evaluado_en END,
            accion_id = CASE WHEN $4 = 'resuelto' THEN NULL ELSE accion_id END,
            accion_titulo = CASE WHEN $4 = 'resuelto' THEN NULL ELSE accion_titulo END
      WHERE id = $1 AND negocio_id = $2 RETURNING id, estado, silenciado_hasta`,
    [id, negocioId, ESTADO_DE[accion], accion, dias]);
  if (!r.rows.length) throw Object.assign(new Error('No encontrado'), { status: 404 });
  return r.rows[0];
}

// El dueño elige una acción para probar: queda anotada y arranca la medición de 28 días (igual que "ya lo resolví").
async function elegirAccion(negocioId, id, accionId, db = pool) {
  await asegurarTabla(db);
  const r = await db.query('SELECT detector, clave, positivo FROM hallazgos WHERE id = $1 AND negocio_id = $2', [id, negocioId]);
  if (!r.rows.length) throw Object.assign(new Error('No encontrado'), { status: 404 });
  const acc = receta(r.rows[0].detector, r.rows[0].clave).find((x) => x.id === accionId);
  if (!acc || r.rows[0].positivo) throw Object.assign(new Error('Acción inválida'), { status: 400 });
  await registrarFeedback(negocioId, id, 'resuelto', db);
  await db.query('UPDATE hallazgos SET accion_id = $3, accion_titulo = $4, accion_en = NOW() WHERE id = $1 AND negocio_id = $2', [id, negocioId, acc.id, acc.titulo]);
  return { ok: true, accion_titulo: acc.titulo };
}

// LumoBi arma la promo con las ventas, precios y costos del negocio (promo.js). No guarda nada: el dueño decide si la prueba.
async function promoParaHallazgo(negocioId, id, accionId, db = pool) {
  await asegurarTabla(db);
  const r = await db.query('SELECT detector, clave, monto::float AS monto, positivo FROM hallazgos WHERE id = $1 AND negocio_id = $2', [id, negocioId]);
  if (!r.rows.length) throw Object.assign(new Error('No encontrado'), { status: 404 });
  const acc = receta(r.rows[0].detector, r.rows[0].clave).find((x) => x.id === accionId && x.arma);
  if (!acc || r.rows[0].positivo) throw Object.assign(new Error('Acción inválida'), { status: 400 });
  return require('./promo').armar(negocioId, r.rows[0], accionId, db);
}

// ── Plata recuperada ─────────────────────────────────────────────────────────
// Un hallazgo marcado como "resuelto" se mide 28 días después: si el mismo problema bajó al menos 20%, la diferencia
// (por mes) cuenta como recuperada. Si no mejoró, cuenta cero. No se mide si hoy no hay datos suficientes de ventas:
// un hallazgo que "desaparece" porque dejaron de entrar ventas no es plata recuperada.
async function evaluarRecuperos(negocioId, db = pool, ahora = new Date(), ctx = null) {
  await asegurarTabla(db);
  if (!ctx || !ctx.suficiente) return 0;
  const r = await db.query(
    `SELECT id, detector, monto_al_resolver::float AS antes, monto::float AS actual, vigente FROM hallazgos
      WHERE negocio_id = $1 AND estado = 'resuelto' AND resuelto_en IS NOT NULL AND evaluado_en IS NULL
        AND resuelto_en <= $2::timestamptz - ($3::int * INTERVAL '1 day')`, [negocioId, ahora, DIAS_MEDIR]);
  let n = 0;
  for (const h of r.rows) {
    let rec = null, medir = null;
    if (MENSUALES.includes(h.detector) && h.antes > 0) {
      medir = h.vigente ? h.actual : 0;
      const mejora = h.antes - medir;
      rec = mejora >= h.antes * MIN_MEJORA ? Math.round(mejora) : 0;
    }
    await db.query('UPDATE hallazgos SET recuperado = $2, monto_al_medir = $3, evaluado_en = NOW() WHERE id = $1', [h.id, rec, medir]);
    n++;
  }
  return n;
}

async function resumenRecuperado(negocioId, db = pool, opts = {}) {
  await obtener(negocioId, db, opts);
  const ahora = opts.ahora || new Date();
  await evaluarRecuperos(negocioId, db, ahora, (cache.get(negocioId) || {}).ctx);
  const med = await db.query(
    `SELECT id, titulo, accion_titulo, monto_al_resolver::float AS antes, monto_al_medir::float AS ahora, recuperado::float AS recuperado
       FROM hallazgos WHERE negocio_id = $1 AND evaluado_en IS NOT NULL AND recuperado > 0
        AND resuelto_en >= $2::timestamptz - INTERVAL '12 months' ORDER BY recuperado DESC`, [negocioId, ahora]);
  const seg = await db.query(
    `SELECT id, titulo, accion_titulo, monto_al_resolver::float AS antes,
            GREATEST(0, $2::int - FLOOR(EXTRACT(EPOCH FROM ($3::timestamptz - resuelto_en)) / 86400))::int AS dias_faltan
       FROM hallazgos WHERE negocio_id = $1 AND estado = 'resuelto' AND resuelto_en IS NOT NULL AND evaluado_en IS NULL
        AND detector = ANY($4::text[]) ORDER BY resuelto_en`, [negocioId, DIAS_MEDIR, ahora, MENSUALES]);
  return { total_mensual: Math.round(med.rows.reduce((s, x) => s + x.recuperado, 0)), medidos: med.rows, en_seguimiento: seg.rows };
}

module.exports = { puerta, factorSensibilidad, calcularSensibilidad, radiografia, elegirAccion, promoParaHallazgo, evaluarRecuperos, resumenRecuperado, detectarAumentos, detectar, procesar, obtener, paraAvisar, registrarFeedback, detectorDe, ACCIONES, MIN_ABS };
