// precision.js — "Qué tan bien acierta LumoBi en TU negocio" (Palantir: la precisión se mide y se muestra, y el sistema se corrige solo).
// Reúne, con datos reales del negocio:
//   · Predicciones: cuántas veces lo vendido cayó dentro del 15% de lo que NICOLE esperaba (aciertos_prediccion.js).
//   · Avisos: qué dijo el dueño ("me sirvió", "ya lo sabía", "no era nada") sobre hallazgos, alertas y alertas en el instante.
//   · Consejos: de los que probó y se midieron a los 28 días, cuántos bajaron el problema.
//   · Ajustes: qué avisos se calibraron solos porque el dueño dijo seguido que no le servían.
const pool = require('./db');

const NOMBRE_DETECTOR = {
  dia_debil: 'los días flojos', franja_floja: 'las horas flojas', comisiones_cobro: 'las comisiones de cobro', ticket_baja: 'el gasto por cliente',
  precio_bajo_costo: 'los productos vendidos bajo el costo', marca_margen_bajo: 'las marcas con poco margen', equipo_caja: 'las diferencias de caja del equipo',
  equipo_borrados: 'los productos sacados del carrito', equipo_egresos: 'la plata sacada de la caja', equipo_frenadas: 'las ventas frenadas', fuga: 'las fugas',
  proveedor_aumento: 'las subas de proveedores',
};
const NOMBRE_INSTANTE = {
  anulacion_grande: 'las anulaciones grandes', anulaciones_repetidas: 'las anulaciones repetidas', descuento_grande: 'los descuentos grandes',
  descuentos_repetidos: 'los descuentos repetidos', egreso_grande: 'la plata sacada de la caja', espera_sin_cobrar: 'las ventas sin cobrar al cerrar', carrito_sacados: 'los productos sacados del carrito',
};

async function prediccion(negocioId, db) {
  try {
    const a = await require('./aciertos_prediccion').calcularAciertos(db, negocioId, null, 30);
    if (!a || a.error_medio_pct == null) return { medido: false, dias: a ? a.dias : 0, minimo: a ? a.minimo : 3, frase: 'Todavía no hay suficientes días para medir qué tan bien predice LumoBi. Se mide solo, comparando lo que esperaba con lo que vendiste.' };
    return { medido: true, dias: a.dias, acertados: a.acertados, tolerancia_pct: a.tolerancia_pct, error_medio_pct: a.error_medio_pct,
      frase: `En los últimos ${a.dias} días, LumoBi acertó ${a.acertados} veces (la venta quedó a menos del ${a.tolerancia_pct}% de lo que esperaba). En promedio se equivocó ${String(a.error_medio_pct).replace('.', ',')}%.` };
  } catch (e) { return { medido: false, dias: 0, frase: 'Todavía no hay predicciones para medir.' }; }
}

async function avisos(negocioId, db) {
  const q = (sql) => db.query(sql, [negocioId]).then((r) => r.rows[0] || {}).catch(() => ({}));
  const [h, al, ins] = await Promise.all([
    q(`SELECT COUNT(*) FILTER (WHERE feedback IN ('util','resuelto'))::int AS si, COUNT(*) FILTER (WHERE feedback IN ('no_sirve','ya_lo_sabia'))::int AS no FROM hallazgos WHERE negocio_id = $1 AND feedback IS NOT NULL`),
    q(`SELECT COUNT(*) FILTER (WHERE feedback_confirmada IS TRUE)::int AS si, COUNT(*) FILTER (WHERE feedback_confirmada IS FALSE AND feedback_at IS NOT NULL)::int AS no FROM alertas_gestionadas WHERE negocio_id = $1 AND feedback_at IS NOT NULL`),
    q(`SELECT COUNT(*) FILTER (WHERE feedback = 'util')::int AS si, COUNT(*) FILTER (WHERE feedback = 'no_era_nada')::int AS no, COUNT(*)::int AS enviados FROM alertas_instante WHERE negocio_id = $1`),
  ]);
  const si = (h.si || 0) + (al.si || 0) + (ins.si || 0), no = (h.no || 0) + (al.no || 0) + (ins.no || 0), n = si + no;
  return { respondidos: n, sirvieron: si, no_sirvieron: no, alertas_instante_enviadas: ins.enviados || 0,
    frase: n >= 3 ? `De ${n} avisos que respondiste, ${si} te sirvieron${no ? ` y ${no} no` : ''}.` : 'Cuando respondas "me sirvió" o "no era nada" en los avisos, LumoBi aprende cuáles te importan y mide su acierto.' };
}

async function consejos(negocioId, db) {
  const r = await db.query(`SELECT COUNT(*)::int AS medidos, COUNT(*) FILTER (WHERE recuperado > 0)::int AS funcionaron FROM hallazgos WHERE negocio_id = $1 AND evaluado_en IS NOT NULL`, [negocioId]).catch(() => ({ rows: [{}] }));
  const x = r.rows[0] || {};
  return { medidos: x.medidos || 0, funcionaron: x.funcionaron || 0,
    frase: x.medidos ? `De ${x.medidos} ${x.medidos === 1 ? 'consejo que probaste y se midió' : 'consejos que probaste y se midieron'}, ${x.funcionaron} ${x.funcionaron === 1 ? 'bajó' : 'bajaron'} el problema.` : 'Cuando pruebes un consejo, LumoBi mide a los 28 días si el problema bajó y te cuenta cuánto acertó.' };
}

// Lo que LumoBi se ajustó solo
async function ajustes(negocioId, db) {
  const out = [];
  try {
    const H = require('./hallazgos');
    const s = await H.calcularSensibilidad(negocioId, db);
    for (const [det, f] of Object.entries(s)) out.push(f > 1 ? `Te avisa menos de ${NOMBRE_DETECTOR[det] || 'este tema'}: dijiste varias veces que no te sirve.` : `Te avisa antes de ${NOMBRE_DETECTOR[det] || 'este tema'}: dijiste que te sirve.`);
  } catch (e) { /* sin hallazgos */ }
  try {
    const { factores } = require('./alerta_instante');
    for (const [clave, f] of Object.entries(await factores(negocioId, db))) if (f > 1) out.push(`Te avisa menos de ${NOMBRE_INSTANTE[clave] || 'este tema'} en el momento: dijiste que no era nada.`);
  } catch (e) { /* sin alertas */ }
  return out;
}

async function precision(negocioId, db = pool) {
  const [p, a, c, aj] = await Promise.all([prediccion(negocioId, db), avisos(negocioId, db), consejos(negocioId, db), ajustes(negocioId, db)]);
  return { prediccion: p, avisos: a, consejos: c, ajustes: aj, hay_algo: p.medido || a.respondidos > 0 || c.medidos > 0 };
}

module.exports = { precision, NOMBRE_INSTANTE };
