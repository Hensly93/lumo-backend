// comparar_locales.js — LumoBi · el "efecto red" dentro de un mismo negocio (18/11/2026).
//
// Cada local se compara contra el RESTO de la red (no contra sí mismo) en los últimos 30 días, con las mismas
// reglas de venta real y costo real que usa toda la app (ventas_sql.js). Se dice algo solo cuando:
//   · hay 2 o más locales con datos suficientes (>= MIN_TICKETS tickets y >= MIN_DIAS días con ventas),
//   · la diferencia es grande (umbrales abajo) — las diferencias chicas son ruido, no se muestran.
// La plata de cada hallazgo es "lo que pasaría si este local se pareciera al resto"; siempre se rotula como estimación
// y nunca se inventa: si falta costo o datos, el hallazgo no sale.
const pool = require('./db');
const { FL_T, REAL_T, ticketsNetos } = require('./ventas_sql');
const CF = require('./caja_faltante');

const DIAS = 30;
const MIN_TICKETS = 30;          // por local, para que el promedio signifique algo
const MIN_DIAS = 7;
const MIN_COBERTURA_COSTO = 0.6; // igual que Rentabilidad
const UMBRAL_TICKET = 0.15;      // el ticket de un local es >= 15% más bajo que el del resto
const UMBRAL_MARGEN_PTS = 5;     // >= 5 puntos de margen bruto menos que el resto
const UMBRAL_FALTANTE = 2;       // faltante de caja >= 2 veces el del resto…
const MIN_FALTANTE_PCT = 0.5;    // …y >= 0,5% de lo que vende el local
const UMBRAL_ANULACION = 2;      // anulaciones >= 2 veces el ratio del resto…
const MIN_ANULACION_PCT = 3;     // …y >= 3% de los tickets
const MIN_UNIDADES_ROTACION = 20;
const RATIO_ROTACION = 4;

const fmt = (n) => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('es-AR');
const r1 = (n) => Math.round(n * 10) / 10;

async function metricas(negocioId, db) {
  const [sucs, ventas, costos, caja, prods] = await Promise.all([
    db.query('SELECT id, nombre FROM mis_sucursales WHERE negocio_id=$1 AND COALESCE(activo,true)=true ORDER BY nombre', [negocioId]),
    db.query(
      `SELECT t.sucursal_id,
              COALESCE(SUM(t.monto),0)::float AS ventas,
              ${ticketsNetos('t.')}::int AS tickets,
              COUNT(*) FILTER (WHERE t.tipo = 'anulacion')::int AS anulaciones,
              COUNT(*) FILTER (WHERE COALESCE(t.tipo,'venta') <> 'anulacion')::int AS ventas_brutas,
              COUNT(DISTINCT (${FL_T})::date)::int AS dias
       FROM transacciones t
       WHERE t.negocio_id=$1 AND t.sucursal_id IS NOT NULL AND ${REAL_T}
         AND ${FL_T} >= (NOW() - INTERVAL '3 hours') - INTERVAL '${DIAS} days'
       GROUP BY 1`, [negocioId]),
    db.query(
      `SELECT t.sucursal_id,
              COALESCE(SUM(d.cantidad * d.costo_unitario) FILTER (WHERE d.costo_unitario > 0),0)::float AS costo,
              COALESCE(SUM(d.subtotal) FILTER (WHERE d.costo_unitario > 0),0)::float AS vendido_con_costo
       FROM transacciones t JOIN transacciones_detalle d ON d.transaccion_id = t.id
       WHERE t.negocio_id=$1 AND t.sucursal_id IS NOT NULL AND ${REAL_T} AND COALESCE(d.tipo_linea,'producto')='producto'
         AND ${FL_T} >= (NOW() - INTERVAL '3 hours') - INTERVAL '${DIAS} days'
       GROUP BY 1`, [negocioId]).catch(() => ({ rows: [] })),
    db.query(
      `SELECT sucursal_id, COALESCE(SUM(${CF.sqlFaltante()}),0)::float AS faltante, COUNT(*)::int AS turnos
       FROM turnos_caja
       WHERE negocio_id=$1 AND sucursal_id IS NOT NULL AND estado='cerrado'
         AND hora_apertura >= NOW() - INTERVAL '${DIAS} days'
       GROUP BY 1`, [negocioId]).catch(() => ({ rows: [] })),
    db.query(
      `SELECT t.sucursal_id, d.producto_nombre AS nombre,
              COALESCE(SUM(d.cantidad),0)::float AS unidades,
              COALESCE(SUM(d.subtotal),0)::float AS vendido,
              COALESCE(SUM(d.cantidad * d.costo_unitario) FILTER (WHERE d.costo_unitario > 0),0)::float AS costo,
              COALESCE(SUM(d.subtotal) FILTER (WHERE d.costo_unitario > 0),0)::float AS vendido_con_costo
       FROM transacciones t JOIN transacciones_detalle d ON d.transaccion_id = t.id
       WHERE t.negocio_id=$1 AND t.sucursal_id IS NOT NULL AND ${REAL_T} AND COALESCE(d.tipo_linea,'producto')='producto'
         AND d.producto_nombre IS NOT NULL
         AND ${FL_T} >= (NOW() - INTERVAL '3 hours') - INTERVAL '${DIAS} days'
       GROUP BY 1, 2`, [negocioId]).catch(() => ({ rows: [] })),
  ]);

  const por = (rows) => Object.fromEntries(rows.map((r) => [r.sucursal_id, r]));
  const V = por(ventas.rows), C = por(costos.rows), K = por(caja.rows);
  const locales = sucs.rows.map((s) => {
    const v = V[s.id] || { ventas: 0, tickets: 0, anulaciones: 0, ventas_brutas: 0, dias: 0 };
    const c = C[s.id] || { costo: 0, vendido_con_costo: 0 };
    const k = K[s.id] || { faltante: 0, turnos: 0 };
    const cobertura = v.ventas > 0 ? Math.min(1, c.vendido_con_costo / v.ventas) : 0;
    const costoOk = cobertura >= MIN_COBERTURA_COSTO && c.vendido_con_costo > 0;
    return {
      id: s.id, nombre: s.nombre,
      ventas: Math.round(v.ventas), tickets: v.tickets, dias_con_ventas: v.dias,
      ticket_promedio: v.tickets > 0 ? Math.round(v.ventas / v.tickets) : null,
      anulaciones: v.anulaciones,
      anulacion_pct: v.ventas_brutas > 0 ? r1((v.anulaciones / v.ventas_brutas) * 100) : 0,
      margen_bruto_pct: costoOk ? r1(((c.vendido_con_costo - c.costo) / c.vendido_con_costo) * 100) : null,
      cobertura_costo_pct: Math.round(cobertura * 100),
      faltante_caja: Math.round(k.faltante), turnos_cerrados: k.turnos,
      faltante_pct: v.ventas > 0 ? r1((k.faltante / v.ventas) * 100) : 0,
      suficiente: v.tickets >= MIN_TICKETS && v.dias >= MIN_DIAS,
      _raw: { ventas: v.ventas, tickets: v.tickets, anul: v.anulaciones, brutas: v.ventas_brutas, costo: c.costo, vcc: c.vendido_con_costo, falt: k.faltante },
    };
  });
  return { locales, productos: prods.rows };
}

// Promedio del resto de la red, ponderado (suma de numeradores / suma de denominadores)
function resto(locales, id, num, den) {
  const o = locales.filter((l) => l.id !== id && l.suficiente);
  const d = o.reduce((s, l) => s + den(l._raw), 0);
  return d > 0 ? o.reduce((s, l) => s + num(l._raw), 0) / d : null;
}

function hallazgos(locales, productos) {
  const out = [];
  const aptos = locales.filter((l) => l.suficiente);
  if (aptos.length < 2) return out;
  const nombre = Object.fromEntries(locales.map((l) => [l.id, l.nombre]));

  for (const l of aptos) {
    const otros = aptos.filter((o) => o.id !== l.id).map((o) => o.nombre);
    const vsTxt = otros.length === 1 ? otros[0] : 'el resto de los locales';
    // 1 · ticket promedio
    const tOtros = resto(locales, l.id, (r) => r.ventas, (r) => r.tickets);
    if (tOtros && l.ticket_promedio && l.ticket_promedio < tOtros * (1 - UMBRAL_TICKET)) {
      const pesos = Math.round((tOtros - l.ticket_promedio) * l.tickets / 2);   // solo la mitad de la brecha: es una estimación prudente
      out.push({
        id: `cmp_ticket_${l.id}`, detector: 'cmp_ticket', local_id: l.id, local: l.nombre,
        titulo: `${l.nombre}: cada cliente gasta menos que en ${vsTxt}`,
        detalle: `El ticket promedio de ${l.nombre} es ${fmt(l.ticket_promedio)} y en ${vsTxt} es ${fmt(tOtros)}. ` +
                 `Si ${l.nombre} cerrara la mitad de esa diferencia, serían unos ${fmt(pesos)} más por mes (estimación con los últimos ${DIAS} días).`,
        evidencia: [`${l.nombre}: ticket ${fmt(l.ticket_promedio)} (${l.tickets} ventas)`, `${vsTxt}: ticket ${fmt(tOtros)}`],
        pesos, accion: 'Mirá qué se vende junto en el otro local y ofrecelo en la caja de este',
      });
    }
    // 2 · margen bruto (solo con costo real en ambos lados)
    if (l.margen_bruto_pct != null) {
      const o = aptos.filter((x) => x.id !== l.id && x.margen_bruto_pct != null);
      const vcc = o.reduce((s, x) => s + x._raw.vcc, 0);
      if (vcc > 0) {
        const mOtros = r1(((vcc - o.reduce((s, x) => s + x._raw.costo, 0)) / vcc) * 100);
        const dif = r1(mOtros - l.margen_bruto_pct);
        if (dif >= UMBRAL_MARGEN_PTS) {
          const pesos = Math.round((dif / 100) * l._raw.vcc);
          // productos que explican la diferencia: mismo producto, mejor precio/costo en el resto
          const propios = productos.filter((p) => p.sucursal_id === l.id && p.vendido_con_costo > 0 && p.unidades > 0);
          const brecha = [];
          for (const p of propios) {
            const ot = productos.filter((q) => q.sucursal_id !== l.id && q.nombre === p.nombre && q.vendido_con_costo > 0 && o.some((x) => x.id === q.sucursal_id));
            if (!ot.length) continue;
            const mP = (p.vendido_con_costo - p.costo) / p.vendido_con_costo * 100;
            const sv = ot.reduce((s, q) => s + q.vendido_con_costo, 0), sc = ot.reduce((s, q) => s + q.costo, 0);
            const mO = (sv - sc) / sv * 100;
            const dp = mO - mP;
            if (dp >= UMBRAL_MARGEN_PTS) brecha.push({ nombre: p.nombre, propio: r1(mP), resto: r1(mO), pesos: Math.round((dp / 100) * p.vendido_con_costo) });
          }
          brecha.sort((a, b) => b.pesos - a.pesos);
          const top = brecha.slice(0, 3);
          out.push({
            id: `cmp_margen_${l.id}`, detector: 'cmp_margen', local_id: l.id, local: l.nombre,
            titulo: `${l.nombre} gana ${dif} puntos menos por cada venta que ${vsTxt}`,
            detalle: `Margen sobre el costo: ${l.nombre} ${l.margen_bruto_pct}% contra ${mOtros}% en ${vsTxt}. ` +
                     (top.length ? `Lo explican sobre todo: ${top.map((t) => `${t.nombre} (${t.propio}% acá, ${t.resto}% allá)`).join('; ')}.` : 'Revisá precios y costos de los productos que más vendés.'),
            evidencia: [`${l.nombre}: margen ${l.margen_bruto_pct}%`, `${vsTxt}: margen ${mOtros}%`, ...top.map((t) => `${t.nombre}: ${t.propio}% vs ${t.resto}%`)],
            pesos, productos: top, accion: 'Igualá los precios de esos productos con los del otro local o revisá a qué precio los comprás',
          });
        }
      }
    }
    // 3 · faltante de caja
    const fOtros = resto(locales, l.id, (r) => r.falt, (r) => r.ventas);
    const fPropio = l._raw.ventas > 0 ? l._raw.falt / l._raw.ventas : 0;
    if (l.turnos_cerrados >= 3 && l.faltante_pct >= MIN_FALTANTE_PCT && fPropio >= (fOtros || 0) * UMBRAL_FALTANTE && l.faltante_caja > 0) {
      out.push({
        id: `cmp_faltante_${l.id}`, detector: 'cmp_faltante', local_id: l.id, local: l.nombre,
        titulo: `En ${l.nombre} falta plata en la caja mucho más seguido que en ${vsTxt}`,
        detalle: `Faltaron ${fmt(l.faltante_caja)} en ${l.turnos_cerrados} cierres (${l.faltante_pct}% de lo que vende). ` +
                 (fOtros != null ? `En ${vsTxt} es ${r1(fOtros * 100)}%.` : ''),
        evidencia: [`${l.nombre}: ${l.faltante_pct}% de faltante`, ...(fOtros != null ? [`${vsTxt}: ${r1(fOtros * 100)}%`] : [])],
        pesos: l.faltante_caja, accion: 'Mirá en Control del equipo qué turnos y qué cajeros concentran el faltante',
      });
    }
    // 4 · anulaciones
    const aOtros = resto(locales, l.id, (r) => r.anul, (r) => r.brutas);
    const aPropio = l._raw.brutas > 0 ? l._raw.anul / l._raw.brutas : 0;
    if (l.anulacion_pct >= MIN_ANULACION_PCT && aPropio >= (aOtros || 0) * UMBRAL_ANULACION) {
      out.push({
        id: `cmp_anulaciones_${l.id}`, detector: 'cmp_anulaciones', local_id: l.id, local: l.nombre,
        titulo: `${l.nombre} anula muchas más ventas que ${vsTxt}`,
        detalle: `${l.anulacion_pct}% de las ventas de ${l.nombre} se anularon` + (aOtros != null ? ` contra ${r1(aOtros * 100)}% en ${vsTxt}.` : '.'),
        evidencia: [`${l.nombre}: ${l.anulaciones} anulaciones`, ...(aOtros != null ? [`${vsTxt}: ${r1(aOtros * 100)}%`] : [])],
        pesos: null, accion: 'Revisá quién anula y con qué motivo',
      });
    }
  }

  // 5 · productos que rotan en un local y casi no en otro (informativo, sin plata inventada)
  const porProd = {};
  for (const p of productos) (porProd[p.nombre] ||= {})[p.sucursal_id] = p.unidades;
  for (const [prod, mapa] of Object.entries(porProd)) {
    // Se compara cada local flojo contra el local donde más rota ese producto (por cada 100 ventas), una sola vez
    const mejor = aptos.filter((a) => (mapa[a.id] || 0) >= MIN_UNIDADES_ROTACION)
      .sort((x, y) => (mapa[y.id] || 0) / y.tickets - (mapa[x.id] || 0) / x.tickets)[0];
    if (!mejor) continue;
    const na = (mapa[mejor.id] || 0) / mejor.tickets * 100;
    for (const b of aptos) {
      if (b.id === mejor.id) continue;
      const ub = mapa[b.id] || 0, nb = ub / b.tickets * 100;
      if (na >= Math.max(nb, 0.01) * RATIO_ROTACION) {
        out.push({
          id: `cmp_rotacion_${prod}_${b.id}`.slice(0, 120), detector: 'cmp_rotacion', local_id: b.id, local: b.nombre,
          titulo: `${prod} se vende mucho en ${mejor.nombre} y casi nada en ${b.nombre}`,
          detalle: `En ${mejor.nombre} salieron ${Math.round(mapa[mejor.id])} unidades en ${DIAS} días y en ${b.nombre} ${Math.round(ub)}. ` +
                   `Puede ser exhibición, precio o que ese público no lo busca: vale la pena mirarlo.`,
          evidencia: [`${mejor.nombre}: ${Math.round(mapa[mejor.id])} unidades`, `${b.nombre}: ${Math.round(ub)} unidades`],
          pesos: null, accion: 'Probá ponerlo a la vista o revisá el precio en ese local',
        });
      }
    }
  }
  return out;
}

async function compararLocales(negocioId, db = pool) {
  const { locales, productos } = await metricas(negocioId, db);
  const aptos = locales.filter((l) => l.suficiente);
  const hall = hallazgos(locales, productos).sort((a, b) => (b.pesos ?? -1) - (a.pesos ?? -1));

  const rank = (campo, mayorEsMejor = true) => {
    const c = aptos.filter((l) => l[campo] != null).sort((a, b) => (mayorEsMejor ? b[campo] - a[campo] : a[campo] - b[campo]));
    return c.length >= 2 ? { mejor: c[0].nombre, peor: c[c.length - 1].nombre } : null;
  };
  const limpio = locales.map(({ _raw, ...l }) => l);
  let aviso = null;
  if (locales.length < 2) aviso = 'Comparar locales aparece cuando tenés 2 o más locales.';
  else if (aptos.length < 2) aviso = `Todavía no hay datos para comparar: hace falta que al menos 2 locales tengan ${MIN_TICKETS} ventas en ${MIN_DIAS} días distintos.`;

  return {
    generado: new Date().toISOString(), dias: DIAS, comparable: aptos.length >= 2, aviso,
    locales: limpio,
    ranking: {
      ventas: rank('ventas'), ticket_promedio: rank('ticket_promedio'), margen_bruto_pct: rank('margen_bruto_pct'),
      faltante_pct: rank('faltante_pct', false), anulacion_pct: rank('anulacion_pct', false),
    },
    hallazgos: hall,
    pesos_en_juego: hall.reduce((s, h) => s + (h.pesos || 0), 0),
  };
}

// Ítems con la forma de Qué hacer (solo para "todo el negocio": un local suelto no se compara contra sí mismo)
async function itemsParaQueHacer(negocioId, db = pool) {
  const r = await compararLocales(negocioId, db);
  return r.hallazgos.map((h) => ({
    id: 'c:' + h.id, origen: 'comparacion', hid: null, detector: h.detector,
    titulo: h.titulo, detalle: h.detalle, evidencia: h.evidencia,
    pesos: h.pesos > 0 ? h.pesos : null, pesos_texto: null, urgente: false, estado: 'nuevo', veces: 1,
    acciones: [], accion_texto: h.accion, url: '/comparar', puede_responder: false,
  }));
}

module.exports = { compararLocales, itemsParaQueHacer, metricas, hallazgos };
