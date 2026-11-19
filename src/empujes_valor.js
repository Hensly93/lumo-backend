// empujes_valor.js — LumoBi · empujes a quien todavía no hizo lo vital (18/11/2026).
//
// Lo vital = lo que le permite a LumoBi detectar o recuperar plata. Si el cliente no lo hace, LumoBi no ve nada.
// Esta pasada corre en el vigilante (cada hora) y, cuando falta algo, manda UN mail o UN push con UN pedido concreto.
//
// Ítems, en orden de prioridad (se empuja solo el primero que falta):
//   ventas   · no hay ventas en los últimos 3 días (o nunca)       -> sin ventas no hay contra qué comparar
//   costos   · menos del 80% de los productos tiene costo           -> sin costo no se ve qué se vende a pérdida
//   facturas · ninguna factura de proveedor en los últimos 30 días  -> sin facturas no se ven subas de precio
//   stock    · menos de la mitad de los productos con stock cargado -> sin stock no se ve la merma
//   caja     · ningún turno cerrado en los últimos 7 días           -> sin cierre no se ve el faltante de caja
//
// Reglas para no molestar:
//   · solo cuentas con 8 días o más (antes escribe el seguimiento de onboarding)
//   · lunes a viernes, de 10 a 19 h de Argentina
//   · máximo un empuje cada 3 días por negocio; el mismo ítem no se repite antes de 7 días
//   · máximo un mail cada 7 días; entre mails, push (si tiene el celular activado)
//   · si se ignoraron 3 empujes seguidos del mismo ítem, se pausa ese ítem 30 días
//   · mismo opt-out que el onboarding (usuarios.mails_onboarding_baja): la baja corta mails y push de empuje
//   · se frena solo apenas el ítem se cumple; nunca cuentas de prueba ni con baja programada
// Todo lo que dice sale de los datos del cliente. Sin porcentajes inventados ni urgencias falsas.
const pool = require('./db');
const BASE_URL = require('./frontend_url').FRONTEND_URL;

const EDAD_MIN_DIAS = 8;
const HORA_DESDE = 10;
const HORA_HASTA = 19;
const ENTRE_EMPUJES_DIAS = 3;
const MISMO_ITEM_DIAS = 7;
const ENTRE_MAILS_DIAS = 7;
const IGNORADOS_PARA_PAUSAR = 3;
const PAUSA_DIAS = 30;
const DIAS_SIN_VENTAS = 3;
const COSTO_OK_PCT = 80;
const STOCK_OK_PCT = 50;
const DIAS_SIN_FACTURAS = 30;
const DIAS_SIN_CIERRE = 7;

const ORDEN = ['ventas', 'costos', 'facturas', 'stock', 'caja'];

async function asegurarTablas(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS empujes_enviados(
    id SERIAL PRIMARY KEY, negocio_id INTEGER NOT NULL, item TEXT NOT NULL, canal TEXT NOT NULL,
    asunto TEXT, enviado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query('CREATE INDEX IF NOT EXISTS idx_empujes_neg ON empujes_enviados (negocio_id, enviado DESC)');
}

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const plural = (c, uno, varios) => (c === 1 ? uno : varios);

// Mide lo vital del negocio. Devuelve { ventas, costos, facturas, stock, caja }, cada uno { hecho, ...datos }
async function medir(negocioId, db = pool) {
  const q = async (sql, p) => (await db.query(sql, p)).rows[0] || {};
  const [v, p, f, c] = await Promise.all([
    q(`SELECT COUNT(*)::int AS total, MAX(fecha) AS ultima,
              COUNT(*) FILTER (WHERE fecha >= NOW() - ($2::int || ' days')::interval)::int AS recientes
         FROM transacciones WHERE negocio_id = $1 AND COALESCE(origin,'real') IN ('real','importado')`, [negocioId, DIAS_SIN_VENTAS]),
    q(`SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE precio_costo > 0)::int AS con_costo,
              COUNT(*) FILTER (WHERE stock IS NOT NULL)::int AS con_stock
         FROM productos WHERE negocio_id = $1 AND COALESCE(activo, true)`, [negocioId]),
    q(`SELECT COUNT(*)::int AS recientes FROM compras WHERE negocio_id = $1 AND fecha >= (CURRENT_DATE - $2::int)`, [negocioId, DIAS_SIN_FACTURAS]),
    q(`SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE hora_cierre >= NOW() - ($2::int || ' days')::interval)::int AS recientes
         FROM turnos_caja WHERE negocio_id = $1 AND estado = 'cerrado'`, [negocioId, DIAS_SIN_CIERRE]),
  ]);
  const prods = n(p.total);
  const pctCosto = prods ? Math.round(n(p.con_costo) / prods * 100) : 0;
  const pctStock = prods ? Math.round(n(p.con_stock) / prods * 100) : 0;
  return {
    ventas: { hecho: n(v.recientes) > 0, nunca: n(v.total) === 0, ultima: v.ultima || null },
    costos: { hecho: prods === 0 ? false : pctCosto >= COSTO_OK_PCT, productos: prods, sin_costo: prods - n(p.con_costo), pct: pctCosto },
    facturas: { hecho: n(f.recientes) > 0 },
    stock: { hecho: prods === 0 ? false : pctStock >= STOCK_OK_PCT, productos: prods, sin_stock: prods - n(p.con_stock), pct: pctStock },
    caja: { hecho: n(c.recientes) > 0, nunca: n(c.total) === 0 },
  };
}

// El primer ítem vital que falta, según la prioridad. Si todo está hecho: null.
// Regla: costos/stock sin productos cargados no se empuja (primero tienen que existir productos: lo cubre ventas/onboarding).
function primerFaltante(m) {
  for (const k of ORDEN) {
    if (m[k].hecho) continue;
    if ((k === 'costos' || k === 'stock') && !m[k].productos) continue;
    return k;
  }
  return null;
}

function diasDesde(fecha, ahora) {
  if (!fecha) return null;
  return Math.max(0, Math.floor((ahora.getTime() - new Date(fecha).getTime()) / 86400000));
}

// Copy de cada ítem. Cada uno dice qué se pierde sin eso, con los números del cliente.
function armar(item, m, { nombre, negocio, ahora }) {
  const nom = String(nombre || '').trim().split(/\s+/)[0] || 'Hola';
  const mm = m[item];
  switch (item) {
    case 'ventas': {
      const d = diasDesde(mm.ultima, ahora);
      const dato = mm.nunca ? 'todavía no hay ninguna venta cargada' : `la última venta que tenemos es de hace ${d} ${plural(d, 'día', 'días')}`;
      return { item, url: `${BASE_URL}/primeros-pasos?paso=ventas`,
        asunto: mm.nunca ? `${nom}, LumoBi todavía no tiene ventas tuyas` : `${nom}, hace ${d} días que LumoBi no ve ventas`,
        preheader: 'Sin ventas al día, LumoBi no puede avisarte de nada.',
        titulo: 'Sin ventas, LumoBi no tiene qué mirar',
        intro: `En ${negocio || 'tu negocio'} ${dato}. LumoBi encuentra dónde se pierde plata comparando lo que vendés con lo que tendría que haber; si las ventas no están al día, esa comparación no se puede hacer.`,
        bloques: [{ titulo: 'Qué te lleva', texto: 'Subir tus ventas o conectar tu medio de cobro lleva unos minutos. Después se mantiene solo.' }],
        boton: 'Poner las ventas al día',
        push: { title: 'LumoBi no ve tus ventas', body: mm.nunca ? 'Cargá tus ventas y empieza a cuidar tu plata.' : `Hace ${d} días que no llegan ventas. Ponelas al día.` } };
    }
    case 'costos':
      return { item, url: `${BASE_URL}/catalogo`,
        asunto: `${nom}, ${mm.sin_costo} ${plural(mm.sin_costo, 'producto', 'productos')} sin costo: ahí no podemos ver si perdés`,
        preheader: 'Con el costo cargado, LumoBi detecta lo que vendés a pérdida.',
        titulo: 'Sin el costo, no sabemos si estás ganando o perdiendo',
        intro: `Tenés ${mm.productos} productos y a ${mm.sin_costo} les falta el costo (${mm.pct}% cargado). Sin el costo, LumoBi no puede decirte qué productos vendés por debajo de lo que te salen ni cuándo un aumento del proveedor te come el margen.`,
        bloques: [{ titulo: 'Cómo avanzar rápido', texto: 'Empezá por los que más vendés. Cargar el costo de los primeros ya cambia lo que LumoBi puede mostrarte. También se completa solo cuando subís una factura de proveedor.' }],
        boton: 'Cargar costos',
        push: { title: `${mm.sin_costo} ${plural(mm.sin_costo, 'producto', 'productos')} sin costo`, body: 'Sin el costo, LumoBi no ve si vendés a pérdida. Cargalos.' } };
    case 'facturas':
      return { item, url: `${BASE_URL}/compras`,
        asunto: `${nom}, hace un mes que LumoBi no ve facturas de tus proveedores`,
        preheader: 'Con las facturas, LumoBi detecta cuando un proveedor te sube el precio.',
        titulo: 'Los proveedores te pueden estar subiendo precios sin que lo notes',
        intro: `No cargaste facturas de proveedores en los últimos ${DIAS_SIN_FACTURAS} días. Cuando subís una, LumoBi compara cada precio con el anterior y te marca las subas y dónde otro proveedor te cobra menos. Sin facturas, eso no se puede ver.`,
        bloques: [{ titulo: 'Qué te lleva', texto: 'Sacarle una foto a la factura alcanza. LumoBi lee los productos y actualiza los costos.' }],
        boton: 'Subir una factura',
        push: { title: 'Subí una factura de proveedor', body: 'LumoBi te marca las subas de precio que hoy no se ven.' } };
    case 'stock':
      return { item, url: `${BASE_URL}/catalogo`,
        asunto: `${nom}, sin stock cargado LumoBi no puede ver la merma`,
        preheader: 'La mercadería que falta sin explicación es plata que se va.',
        titulo: 'La mercadería que falta es plata que se va',
        intro: `Solo el ${mm.pct}% de tus productos tiene el stock cargado (${mm.sin_stock} sin controlar). Con el stock al día, LumoBi compara lo que debería haber con lo que hay y te muestra cuánta mercadería desaparece sin explicación.`,
        bloques: [{ titulo: 'Cómo avanzar rápido', texto: 'No hace falta contar todo. Empezá por los productos de más valor o los que más se venden.' }],
        boton: 'Cargar el stock',
        push: { title: 'Stock sin controlar', body: 'Cargá el stock y LumoBi te muestra la merma que hoy no se ve.' } };
    default:
      return { item, url: `${BASE_URL}/caja`,
        asunto: mm.nunca ? `${nom}, la caja todavía no se controla en LumoBi` : `${nom}, hace una semana que no se cierra un turno de caja`,
        preheader: 'El faltante de caja solo se ve al cerrar el turno.',
        titulo: 'Si no se cierra el turno, un faltante pasa desapercibido',
        intro: mm.nunca
          ? 'Todavía no se cerró ningún turno de caja. Al cerrarlo, LumoBi compara lo que tendría que haber con lo que hay y marca la diferencia: es donde más plata se pierde sin que nadie se dé cuenta.'
          : `No hay turnos cerrados en los últimos ${DIAS_SIN_CIERRE} días. Sin el cierre, LumoBi no puede comparar lo que tendría que haber en la caja con lo que hay, y un faltante pasa sin que nadie lo vea.`,
        bloques: [{ titulo: 'Qué te lleva', texto: 'Cerrar el turno son unos minutos al final del día: se cuenta la plata y listo.' }],
        boton: 'Ir a la caja',
        push: { title: 'Caja sin cerrar', body: 'Cerrá el turno para que LumoBi controle los faltantes.' } };
  }
}

function relojAR(ahora) {
  const l = new Date(ahora.getTime() - 3 * 3600 * 1000);
  return { hora: l.getUTCHours() + l.getUTCMinutes() / 60, dia: l.getUTCDay() }; // dia: 0 dom .. 6 sáb
}
const esCorreoDePrueba = (e) => /@(test\.com|example\.com|example\.org|test\.test)$/i.test(String(e || '').trim());

// Decide si hoy toca empujar este ítem a este negocio, según el historial. Devuelve null o un motivo para no enviar.
function frenos(hist, item, ahora) {
  const dias = (f) => (ahora.getTime() - new Date(f).getTime()) / 86400000;
  if (hist.length && dias(hist[0].enviado) < ENTRE_EMPUJES_DIAS) return 'muy_reciente';
  const delItem = hist.filter((x) => x.item === item);
  if (delItem.length && dias(delItem[0].enviado) < MISMO_ITEM_DIAS) return 'mismo_item_reciente';
  // Pausa: 3 empujes seguidos del mismo ítem sin que se cumpla (se cumpliera, ya no sería el faltante)
  const seguidos = [];
  for (const x of hist) { if (x.item !== item) break; seguidos.push(x); }
  if (seguidos.length >= IGNORADOS_PARA_PAUSAR && dias(seguidos[0].enviado) < PAUSA_DIAS) return 'pausado_por_ignorado';
  return null;
}

// opts: { dry, ahora, email(fn), push(fn), medir(fn) } — todo opcional, para pruebas
async function pasadaEmpujes(db = pool, opts = {}) {
  const ahora = opts.ahora || new Date();
  const res = { dry: !!opts.dry, revisados: 0, mails: 0, pushes: 0, detalle: [] };
  const r = relojAR(ahora);
  if (r.dia === 0 || r.dia === 6) { res.motivo = 'fin_de_semana'; return res; }
  if (r.hora < HORA_DESDE || r.hora >= HORA_HASTA) { res.motivo = 'fuera_de_horario'; return res; }
  await asegurarTablas(db);
  await require('./onboarding_mails').asegurarTablas(db);
  const enviarMail = opts.email || require('./mailer').enviarSeguimiento;
  const enviarPush = opts.push || ((uid, payload) => require('./push').notificarUsuario(uid, payload, db));
  const medirFn = opts.medir || ((nid) => medir(nid, db));
  const { urlBajaAbsoluta } = require('./onboarding_mails');

  const us = await db.query(
    `SELECT u.id AS usuario_id, nu.negocio_id, u.nombre, u.email, u.negocio
       FROM usuarios u
       JOIN negocio_usuarios nu ON nu.usuario_id = u.id AND nu.rol = 'owner' AND nu.activo = true
      WHERE u.mails_onboarding_baja = false AND u.deletion_scheduled_at IS NULL
        AND COALESCE(u.es_prueba, false) = false AND COALESCE(u.subscription_status,'') <> 'interna'
        AND u.created_at <= ($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '${EDAD_MIN_DIAS} days'`, [ahora.toISOString()]);

  for (const u of us.rows) {
    if (esCorreoDePrueba(u.email)) continue;
    res.revisados++;
    try {
      const hist = (await db.query('SELECT item, canal, enviado FROM empujes_enviados WHERE negocio_id=$1 ORDER BY enviado DESC LIMIT 20', [u.negocio_id])).rows;
      const m = await medirFn(u.negocio_id);
      const item = primerFaltante(m);
      if (!item) { res.detalle.push({ negocio_id: u.negocio_id, accion: 'todo_al_dia' }); continue; }
      const freno = frenos(hist, item, ahora);
      if (freno) { res.detalle.push({ negocio_id: u.negocio_id, item, accion: freno }); continue; }

      const ultMail = hist.find((x) => x.canal === 'mail');
      const puedeMail = !ultMail || (ahora.getTime() - new Date(ultMail.enviado).getTime()) / 86400000 >= ENTRE_MAILS_DIAS;
      const c = armar(item, m, { nombre: u.nombre, negocio: u.negocio, ahora });
      const canal = puedeMail ? 'mail' : 'push';
      res.detalle.push({ negocio_id: u.negocio_id, item, canal, asunto: c.asunto });
      if (opts.dry) continue;

      // se anota ANTES de enviar: si falla, no se reintenta en bucle
      await db.query('INSERT INTO empujes_enviados(negocio_id, item, canal, asunto, enviado) VALUES($1,$2,$3,$4,$5)', [u.negocio_id, item, canal, c.asunto, ahora.toISOString()]);
      if (canal === 'mail') {
        const ok = await enviarMail({ email: u.email, asunto: c.asunto, preheader: c.preheader, titulo: c.titulo, intro: c.intro,
          bloques: c.bloques, boton: c.boton, url: c.url, cierre: 'Si algo no se entiende o no podés hacerlo, respondé este mail y te ayudamos.', bajaUrl: urlBajaAbsoluta(u.usuario_id) });
        if (ok) res.mails++;
        // el mail va acompañado de un push solo si el celular está activado (si no, no pasa nada)
        try { const p = await enviarPush(u.usuario_id, { ...c.push, url: c.url }); if (p) res.pushes++; } catch (_) { /* sin celular activado */ }
      } else {
        const p = await enviarPush(u.usuario_id, { ...c.push, url: c.url });
        if (p) res.pushes++;
        else await db.query('DELETE FROM empujes_enviados WHERE id = (SELECT id FROM empujes_enviados WHERE negocio_id=$1 ORDER BY id DESC LIMIT 1)', [u.negocio_id]); // sin celular: no cuenta, probamos otro día
      }
    } catch (e) {
      console.error('[EMPUJES] negocio', u.negocio_id, e.message);
      res.detalle.push({ negocio_id: u.negocio_id, error: e.message });
    }
  }
  console.log('[EMPUJES] revisados=' + res.revisados + ' mails=' + res.mails + ' pushes=' + res.pushes);
  return res;
}

module.exports = { pasadaEmpujes, medir, primerFaltante, armar, frenos, ORDEN };
