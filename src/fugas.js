// fugas.js — Fugas de plata de LumoBi.
//
// Una FUGA es plata que se le esta yendo al negocio, con cinco datos siempre:
//   donde (local / turno / categoria), cuanto (monto en pesos), evidencia (los datos que la
//   disparan), como corregirla (acciones concretas) y estado (activa / en_seguimiento / resuelta).
//
// Reglas:
//  - Nunca se inventa un monto. Si no hay datos suficientes, no hay fuga (o se dice "pendiente de datos").
//  - Nunca se dice "fraude": se dice "diferencia de caja" / "inconsistencia operativa".
//  - Nunca aparecen nombres de empleados: la fuga apunta al TURNO y al LOCAL.
//  - El monto de caja es exacto (suma de las diferencias reales de cierre). Los de rentabilidad vienen
//    de calcularRentabilidad (ya comparados contra el IPC).
//  - El total "en fuga" no suma dos veces lo mismo (ver incluida_en).
//
// Fuentes de v1: caja (turnos_caja.brecha) + rentabilidad (costos, margen, ventas reales vs inflacion).
// Pendientes de datos que hoy no existen: Mercado Pago contra caja, comisiones reales, margen por producto.

const pool = require('./db');

const DIAS = 30;                 // ventana de cada periodo
const MIN_TURNOS_CON_FALTANTE = 3;
const MIN_MONTO_CAJA = 5000;     // por debajo de esto no es una fuga, es ruido de cambio/redondeo
const TOLERANCIA_MIN = 500;      // una diferencia menor a esto en un turno no cuenta
const TOLERANCIA_PCT = 0.005;    // ni menor al 0,5% del efectivo esperado

const fmt = (n) => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('es-AR');
const mediana = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const TURNO = { manana: 'mañana', mañana: 'mañana', tarde: 'tarde', noche: 'noche' };
const nombreTurno = (t) => TURNO[String(t || '').toLowerCase()] || String(t || 'sin turno').toLowerCase();

// ─── Fuente 1: caja ──────────────────────────────────────────────────────────
// brecha = efectivo esperado - caja contada. Positiva = FALTA plata en la caja.
async function fugasDeCaja(negocioId, db, ahora) {
  const desde = new Date(ahora.getTime() - 2 * DIAS * 86400000);
  const r = await db.query(
    `SELECT t.id, t.tipo_turno, t.sucursal_id, s.nombre AS sucursal, t.brecha, t.caja_esperada,
            COALESCE(t.gasto_inesperado, false) AS gasto_inesperado, t.hora_cierre
       FROM turnos_caja t
       LEFT JOIN mis_sucursales s ON s.id = t.sucursal_id
      WHERE t.negocio_id = $1 AND t.estado = 'cerrado' AND t.brecha IS NOT NULL
        AND t.hora_cierre >= $2 AND t.hora_cierre <= $3`,
    [negocioId, desde, ahora]
  );
  const corte = ahora.getTime() - DIAS * 86400000;
  const grupos = new Map();
  for (const t of r.rows) {
    const k = (t.sucursal_id || 0) + '|' + nombreTurno(t.tipo_turno);
    if (!grupos.has(k)) grupos.set(k, { sucursal_id: t.sucursal_id, sucursal: t.sucursal, turno: nombreTurno(t.tipo_turno), act: [], prev: [] });
    (new Date(t.hora_cierre).getTime() >= corte ? grupos.get(k).act : grupos.get(k).prev).push(t);
  }
  const nGrupos = new Set(r.rows.map((t) => t.sucursal_id || 0)).size;
  const fugas = [];
  for (const g of grupos.values()) {
    const faltante = (t) => {
      if (t.gasto_inesperado) return 0; // el dueño ya confirmo que fue un gasto no cargado
      const b = Number(t.brecha) || 0;
      const tol = Math.max(TOLERANCIA_MIN, (Number(t.caja_esperada) || 0) * TOLERANCIA_PCT);
      return b > tol ? b : 0;
    };
    const fa = g.act.map(faltante);
    const conFalta = fa.filter((x) => x > 0);
    const total = conFalta.reduce((s, x) => s + x, 0);
    if (conFalta.length < MIN_TURNOS_CON_FALTANTE || total < MIN_MONTO_CAJA) continue;
    const totalPrev = g.prev.map(faltante).reduce((s, x) => s + x, 0);
    const recuperado = g.prev.length >= MIN_TURNOS_CON_FALTANTE && totalPrev > total ? Math.round(totalPrev - total) : 0;
    const donde = (nGrupos > 1 && g.sucursal ? g.sucursal + ' · ' : '') + 'turno ' + g.turno;
    const sinFalta = fa.filter((x, i) => x === 0 && !g.act[i].gasto_inesperado).length;
    const evidencia = [
      conFalta.length + ' de ' + g.act.length + ' cierres del turno ' + g.turno + ' terminaron con plata de menos en la caja.',
      'Faltante típico por cierre: ' + fmt(mediana(conFalta)) + '. El peor: ' + fmt(Math.max.apply(null, conFalta)) + '.',
    ];
    if (sinFalta > 0) evidencia.push('Los otros ' + sinFalta + ' cierres del mismo turno cerraron sin diferencia relevante.');
    if (g.prev.length >= MIN_TURNOS_CON_FALTANTE) {
      evidencia.push('En los ' + DIAS + ' días anteriores el faltante de este turno fue ' + fmt(totalPrev) + '.');
    }
    fugas.push({
      id: 'caja_' + (g.sucursal_id || 0) + '_' + g.turno,
      categoria: 'caja',
      categoria_label: 'Caja',
      donde,
      titulo: 'Faltaron ' + fmt(total) + ' en la caja del turno ' + g.turno + ' en ' + DIAS + ' días',
      monto: Math.round(total),
      monto_rango: null, // es la suma real de las diferencias de cierre, no una estimacion
      monto_tipo: 'medido',
      periodo: 'últimos ' + DIAS + ' días',
      evidencia,
      como_corregir: [
        'Cerrar el turno con dos personas presentes (quien entrega y quien recibe) y firmar el conteo.',
        'Retirar efectivo a la caja fuerte cada vez que la caja supere un monto fijo, y anotarlo como egreso.',
        'Anotar como egreso cada pago a proveedores y cada retiro: si no se carga, aparece como faltante.',
        'Si un faltante se explica por un gasto real, marcá "gasto inesperado" en ese cierre y deja de contar como fuga.',
      ],
      recuperado,
      url: '/empleados',
      fuente: 'caja',
    });
  }
  return fugas;
}

// ─── Fuente 2: rentabilidad ──────────────────────────────────────────────────
function categoriaDeRec(id) {
  if (/^margen_/.test(id)) return ['precios', 'Precios'];
  if (/^suba_/.test(id)) return ['costos', 'Costos'];
  if (/^ventas_reales_/.test(id)) return ['ventas', 'Ventas contra inflación'];
  return ['resultado', 'Resultado del mes'];
}
function fugasDeRentabilidad(rent) {
  const out = [];
  const recs = (rent && rent.recomendaciones) || [];
  const hayMargen = recs.some((r) => /^margen_/.test(r.id));
  for (const r of recs) {
    if (r.tipo === 'positiva' || !(Number(r.impacto_pesos) > 0)) continue;
    const [categoria, label] = categoriaDeRec(r.id);
    const f = {
      id: 'rent_' + r.id,
      categoria,
      categoria_label: label,
      donde: 'Todo el negocio',
      titulo: r.titulo,
      monto: Math.round(r.impacto_pesos),
      monto_rango: null,
      monto_tipo: 'calculado',
      periodo: 'último mes',
      evidencia: [r.detalle].filter(Boolean),
      como_corregir: [r.accion].filter(Boolean),
      recuperado: 0,
      url: '/rentabilidad',
      fuente: 'rentabilidad',
    };
    // No contar dos veces: una suba de mercaderia/comisiones ya esta dentro de "precios atrasados"
    if (categoria === 'costos' && hayMargen && /^suba_(mercaderia|comisiones)_/.test(r.id)) f.incluida_en = 'precios';
    // La perdida/equilibrio del mes es la CONSECUENCIA de las demas: se muestra, no se suma
    if (categoria === 'resultado') f.incluida_en = 'resultado';
    out.push(f);
  }
  return out;
}

// ─── Estado persistente (en seguimiento / resuelta / descartada) ─────────────
async function asegurarTabla(db) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS fugas_estado(
       negocio_id INTEGER NOT NULL, fuga_id TEXT NOT NULL, estado TEXT NOT NULL,
       nota TEXT, monto_al_marcar NUMERIC, actualizado TIMESTAMP DEFAULT NOW(),
       PRIMARY KEY (negocio_id, fuga_id))`
  );
}
async function marcarFuga(negocioId, fugaId, estado, nota, monto, db = pool) {
  if (!['en_seguimiento', 'resuelta', 'descartada', 'activa'].includes(estado)) throw new Error('estado inválido');
  await asegurarTabla(db);
  if (estado === 'activa') {
    await db.query('DELETE FROM fugas_estado WHERE negocio_id=$1 AND fuga_id=$2', [negocioId, fugaId]);
    return;
  }
  await db.query(
    `INSERT INTO fugas_estado(negocio_id, fuga_id, estado, nota, monto_al_marcar, actualizado)
     VALUES($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (negocio_id, fuga_id) DO UPDATE SET estado=$3, nota=$4, monto_al_marcar=$5, actualizado=NOW()`,
    [negocioId, String(fugaId).slice(0, 120), estado, nota ? String(nota).slice(0, 500) : null, monto == null ? null : Number(monto)]
  );
}

// ─── Principal ───────────────────────────────────────────────────────────────
// opts: { ahora, fuentes: { rentabilidad: fn(negocioId) } } (inyectable para pruebas)
async function calcularFugas(negocioId, db = pool, opts = {}) {
  const ahora = opts.ahora || new Date();
  await asegurarTabla(db);
  const fuentes = Object.assign({ rentabilidad: (id) => require('./rentabilidad').calcularRentabilidad(id) }, opts.fuentes || {});

  let fugas = [];
  const avisos = [];
  try { fugas = fugas.concat(await fugasDeCaja(negocioId, db, ahora)); }
  catch (e) { avisos.push('caja: ' + e.message); }
  let mpEvaluado = false;
  try {
    const mp = await require('./fugas_mp').fugasDeMercadoPago(negocioId, db, ahora);
    mpEvaluado = mp.evaluado;
    fugas = fugas.concat(mp.fugas);
  } catch (e) { avisos.push('mercadopago: ' + e.message); }
  try { fugas = fugas.concat(fugasDeRentabilidad(await fuentes.rentabilidad(negocioId))); }
  catch (e) { avisos.push('rentabilidad: ' + e.message); }

  const est = await db.query('SELECT fuga_id, estado, nota, monto_al_marcar, actualizado FROM fugas_estado WHERE negocio_id=$1', [negocioId]);
  const porId = new Map(est.rows.map((r) => [r.fuga_id, r]));
  let recuperadoMarcado = 0;
  for (const f of fugas) {
    const e = porId.get(f.id);
    f.estado = e ? e.estado : 'activa';
    f.nota = e ? e.nota : null;
    // Resuelta y el monto bajo desde que se marco: lo que bajo es plata recuperada (medido)
    if (e && e.estado === 'resuelta' && e.monto_al_marcar != null && Number(e.monto_al_marcar) > f.monto) {
      f.recuperado = Math.max(f.recuperado, Math.round(Number(e.monto_al_marcar) - f.monto));
    }
    recuperadoMarcado += f.recuperado || 0;
  }
  // Fugas que ya no aparecen pero el dueño habia marcado como resueltas: ese monto se recupero entero
  const vistas = new Set(fugas.map((f) => f.id));
  for (const e of est.rows) {
    if (e.estado === 'resuelta' && !vistas.has(e.fuga_id) && e.monto_al_marcar != null) recuperadoMarcado += Math.round(Number(e.monto_al_marcar));
  }

  fugas.sort((a, b) => (b.estado === 'activa') - (a.estado === 'activa') || b.monto - a.monto);
  const contables = fugas.filter((f) => f.estado !== 'descartada' && f.estado !== 'resuelta' && !f.incluida_en);
  const resumen = {
    en_fuga: contables.reduce((s, f) => s + f.monto, 0),
    cantidad: fugas.filter((f) => f.estado === 'activa').length,
    recuperado: recuperadoMarcado,
    periodo: 'últimos ' + DIAS + ' días',
    nota: 'El total no suma dos veces lo mismo: lo que ya está incluido en otra fuga o es consecuencia de otras se muestra pero no se suma.',
  };
  return { generado: ahora.toISOString(), resumen, fugas, avisos, pendientes_de_datos: pendientes().filter((p) => !(p.id === 'mp_vs_caja' && mpEvaluado)) };
}

function pendientes() {
  return [
    { id: 'mp_vs_caja', titulo: 'Mercado Pago contra caja', falta: 'Conectar Mercado Pago para comparar lo que entró contra lo que se registró en caja.' },
    { id: 'comisiones_reales', titulo: 'Comisiones reales', falta: 'Cargar o conectar los cobros con tarjeta y QR para medir cuánto se llevan las comisiones.' },
    { id: 'margen_producto', titulo: 'Productos que venden mucho y ganan poco', falta: 'Cargar el costo de tus productos en el catálogo.' },
  ];
}

module.exports = { calcularFugas, marcarFuga, fugasDeCaja, fugasDeRentabilidad };
