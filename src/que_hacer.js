// que_hacer.js — LumoBi · UNA sola lista de "qué hacer" (paso 3 del plan de orden).
//
// Antes cada pantalla leía de un lado: Inicio y Alertas leían "revisar", Oportunidades y Fugas leían los
// hallazgos, Rentabilidad tenía sus recomendaciones. Acá se juntan en una lista, ordenada por plata, y cada
// pantalla es una vista de esta lista.
//
// Fuentes:
//   · hallazgos (el cerebro): oportunidades y fugas con plata, evidencia y acciones. Las fugas de caja y las
//     recomendaciones de rentabilidad ya entran por acá, no se repiten.
//   · revisar: alertas del momento, equipo y caja. Las que ya son una fuga de caja se descartan (son la misma cosa).
// Orden: primero lo urgente (críticos), después lo que más plata mueve. Lo que no tiene plata calculada va al final
// de su grupo y se marca "sin monto": nunca se inventa un número.
const pool = require('./db');

const fmt = (n) => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('es-AR');
const SILENCIADOS = new Set(['descartado', 'sabido', 'resuelto']);
const URGENTE = new Set(['critico', 'inconsistencia']);

function deHallazgo(h, receta, ACCION_TEXTO) {
  return {
    id: 'h:' + h.id, origen: 'hallazgo', hid: h.id, detector: h.detector,
    titulo: h.titulo, detalle: h.detalle || '', evidencia: Array.isArray(h.evidencia) ? h.evidencia : [],
    pesos: Number(h.monto) > 0 ? Math.round(Number(h.monto)) : null,
    pesos_texto: h.monto_texto || null,
    urgente: false,
    estado: h.estado === 'util' ? 'util' : 'nuevo',
    veces: h.veces || 1,
    acciones: receta(h.detector, h.clave),
    accion_texto: ACCION_TEXTO[h.detector] || 'Ver el detalle',
    url: h.url || '/',
    puede_responder: true,
  };
}

function deAlerta(a) {
  const pesos = Number(a.impacto_estimado) > 0 ? Math.round(Number(a.impacto_estimado)) : null;
  return {
    id: 'a:' + String(a.id || a.tipo + ':' + String(a.mensaje).slice(0, 40)), origen: 'alerta', hid: null, detector: null,
    titulo: a.mensaje || a.tipo, detalle: a.tipo ? `${a.tipo}` : '',
    evidencia: a.datos && a.datos.evidencia ? [a.datos.evidencia] : [],
    pesos, pesos_texto: null,
    urgente: URGENTE.has(a.prioridad),
    estado: 'nuevo', veces: 1, acciones: [],
    accion_texto: a.accion || 'Ver el detalle',
    url: a.url || '/alertas',
    puede_responder: false,
  };
}

async function queHacer(negocioId, sucursalId = null, db = pool, fuentes = {}) {
  const H = fuentes.hallazgos || require('./hallazgos');
  const { receta } = fuentes.acciones || require('./acciones');
  const ACCION_TEXTO = fuentes.ACCION_TEXTO || {
    dia_debil: 'Ver ventas por día', franja_floja: 'Ver ventas por hora', ticket_baja: 'Ver tu ticket promedio',
    comisiones_cobro: 'Ver cobros por medio de pago', aumentos_proveedor: 'Revisar las facturas', fuga: 'Ver cómo cerrar la fuga',
    precio_bajo_costo: 'Revisar tus precios y costos', marca_margen_bajo: 'Revisar los precios de esta marca',
    stock_agotado: 'Ver el stock', stock_bajo: 'Ver el stock', stock_inmovil: 'Ver el stock', stock_diferencia: 'Ver el stock',
  };
  const avisos = [];
  const items = [];
  const ahora = new Date();

  try {
    const filas = await H.obtener(negocioId, db);
    for (const h of filas) {
      if (h.positivo || !h.puerta || !h.puerta.pasa || SILENCIADOS.has(h.estado)) continue;
      if (h.silenciado_hasta && new Date(h.silenciado_hasta) > ahora) continue;
      items.push(deHallazgo(h, receta, ACCION_TEXTO));
    }
  } catch (e) { avisos.push('hallazgos: ' + e.message); }

  try {
    const analisis = fuentes.analisis !== undefined ? fuentes.analisis : await require('./motor').analizarNegocio(negocioId, sucursalId);
    const recs = fuentes.recs !== undefined ? fuentes.recs
      : await require('./recomendaciones').generarRecomendaciones(negocioId, sucursalId).catch(() => ({ recomendaciones: [] }));
    const rev = await (fuentes.itemsRevisar || require('./revisar').itemsRevisar)(negocioId, sucursalId, analisis, recs);
    for (const a of rev.items || []) {
      if (a.origen === 'fugas') continue;                       // ya viene como hallazgo (fuga)
      if (['positivo', 'info'].includes(a.prioridad)) continue;
      items.push(deAlerta(a));
    }
  } catch (e) { avisos.push('alertas: ' + e.message); }

  // Urgentes primero; dentro de cada grupo, lo que más plata mueve; lo que no tiene plata, al final
  items.sort((x, y) => (y.urgente - x.urgente) || ((y.pesos ?? -1) - (x.pesos ?? -1)));

  let recuperado = null;
  try {
    const r = await H.resumenRecuperado(negocioId, db);
    recuperado = { total_mensual: r.total_mensual, medidos: r.medidos, en_seguimiento: r.en_seguimiento };
  } catch (e) { avisos.push('recuperado: ' + e.message); }

  const conPesos = items.filter((i) => i.pesos != null);
  return {
    generado: ahora.toISOString(), sucursal_id: sucursalId,
    resumen: {
      cantidad: items.length,
      urgentes: items.filter((i) => i.urgente).length,
      pesos_en_juego: conPesos.reduce((s, i) => s + i.pesos, 0),
      sin_monto: items.length - conPesos.length,
      texto: items.length
        ? `${items.length} cosa${items.length === 1 ? '' : 's'} para hacer` + (conPesos.length ? `, ${fmt(conPesos.reduce((s, i) => s + i.pesos, 0))} en juego` : '')
        : 'Nada para hacer ahora',
    },
    items, recuperado, avisos,
  };
}

module.exports = { queHacer, deHallazgo, deAlerta };
