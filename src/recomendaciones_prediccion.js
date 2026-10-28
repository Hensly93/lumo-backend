// recomendaciones_prediccion.js — LumoBi (28/10/2026)
// "Después de predecir, LumoBi recomienda una acción."
//
// Lee la predicción de los próximos 7 días y la convierte en acciones concretas.
// Reglas de NICOLE: nunca nombra empleados; cada recomendación termina en una acción;
// LumoBi sugiere, el dueño decide (no administra stock ni turnos: no es ERP).
// Se agrupan los días relacionados (ej. dos días de lluvia = una sola recomendación).

const pool = require('./db');
const { calcularPrediccion } = require('./prediccion_adaptativa');


function fmt(n) { return '$' + Math.round(Math.abs(n)).toLocaleString('es-AR'); }
function nombreDia(p) {
  const [, m, d] = p.fecha_target.split('-');
  return `${p.dia_semana ?? ''} ${Number(d)}/${Number(m)}`.trim();
}
function listaDias(ps) {
  const n = ps.map(nombreDia);
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} y ${n[n.length - 1]}`;
}
function efectoDe(p, variables) {
  return (p.efectos || []).filter(e => variables.includes(e.variable)).reduce((a, e) => a + e.efecto_pesos, 0);
}

const CLIMA = ['lluvia', 'calor_extremo', 'frio_extremo'];
const NOMBRE_CLIMA = { lluvia: 'lluvia', calor_extremo: 'calor extremo', frio_extremo: 'frío extremo' };

async function recomendacionesDePrediccion(negocioId, sucursalId = null, db = pool, opciones = {}) {
  const r = await calcularPrediccion(negocioId, sucursalId, db, null, { ...opciones, guardar: false });
  if (!r.disponible || !r.predicciones?.length) return [];

  const preds = r.predicciones;
  const promedio = preds.reduce((a, p) => a + p.valor_predicho, 0) / preds.length;
  const coef = Object.fromEntries((r.modelo?.coeficientes || []).map(c => [c.variable, c]));
  const recs = [];

  // 1. Días flojos por clima (agrupados)
  const flojosClima = preds.filter(p => efectoDe(p, CLIMA) <= -0.05 * p.valor_predicho);
  if (flojosClima.length) {
    const perdida = flojosClima.reduce((a, p) => a + efectoDe(p, CLIMA), 0);
    const tipos = [...new Set(flojosClima.flatMap(p => (p.efectos || []).filter(e => CLIMA.includes(e.variable)).map(e => e.variable)))];
    const c = coef[tipos[0]];
    const pct = c ? Math.round((1 - c.factor) * 100) : null;
    recs.push({
      id: 'PREDICCION_DIA_FLOJO_CLIMA',
      categoria: 'prediccion',
      prioridad: 'alta',
      mensaje: `${listaDias(flojosClima)}: se espera ${tipos.map(t => NOMBRE_CLIMA[t]).join(' y ')}. NICOLE estima ${fmt(perdida)} menos en ventas` +
        (pct ? ` (con ${NOMBRE_CLIMA[tipos[0]]} tu negocio vende un ${pct}% menos).` : '.'),
      accion: flojosClima.length > 1
        ? 'Para esos días, evaluá turnos más cortos o una promo, y ajustá la compra de mercadería que se vence.'
        : 'Para ese día, evaluá un turno más corto o una promo, y ajustá la compra de mercadería que se vence.',
      datos: { fechas: flojosClima.map(p => p.fecha_target), efecto_pesos: Math.round(perdida), tipos },
    });
  }

  // 2. Día más fuerte de la semana (si se despega del promedio)
  const fuerte = preds.reduce((a, p) => (p.valor_predicho > a.valor_predicho ? p : a));
  if (fuerte.valor_predicho >= promedio * 1.25) {
    const pico = fuerte.franjas?.hora_pico?.hora;
    const pctSobre = Math.round((fuerte.valor_predicho / promedio - 1) * 100);
    recs.push({
      id: 'PREDICCION_DIA_FUERTE',
      categoria: 'prediccion',
      prioridad: 'media',
      mensaje: `${nombreDia(fuerte)} es tu día más fuerte de la semana: se esperan ${fmt(fuerte.valor_predicho)}, un ${pctSobre}% más que tu promedio diario.`,
      accion: pico != null
        ? `Reforzá la atención entre las ${pico - 1} y las ${pico + 2} h, y asegurate de tener cambio y mercadería desde temprano.`
        : 'Reforzá la atención ese día y asegurate de tener cambio y mercadería desde temprano.',
      datos: { fecha: fuerte.fecha_target, valor: fuerte.valor_predicho, pct_sobre_promedio: pctSobre, hora_pico: pico ?? null },
    });
  }

  // 3. Calendario: quincena / aguinaldo (suben) y feriados (bajan)
  for (const tipo of ['quincena', 'aguinaldo', 'feriado']) {
    const dias = preds.filter(p => Math.abs(efectoDe(p, [tipo])) >= 0.03 * p.valor_predicho);
    if (!dias.length) continue;
    const efecto = dias.reduce((a, p) => a + efectoDe(p, [tipo]), 0);
    const c = coef[tipo];
    const pct = c ? Math.round(Math.abs(c.factor - 1) * 100) : null;
    const origen = c && c.fuente === 'aprendido' ? ' (aprendido de tus ventas)' : '';
    const sube = efecto > 0;
    const nombre = tipo === 'quincena' ? 'cae quincena' : tipo === 'aguinaldo' ? 'se cobra aguinaldo' : 'es feriado';
    recs.push({
      id: `PREDICCION_${tipo.toUpperCase()}`,
      categoria: 'prediccion',
      prioridad: 'media',
      mensaje: `${listaDias(dias)} ${nombre}: en esos días tu negocio vende ${pct != null ? `un ${pct}% ` : ''}${sube ? 'más' : 'menos'}${origen}. NICOLE ya lo sumó a la predicción (${sube ? '+' : '−'}${fmt(efecto)}).`,
      accion: sube
        ? `Prepará caja, cambio y mercadería para ${dias.length > 1 ? 'esos días' : 'ese día'}.`
        : 'Revisá si conviene abrir con horario reducido o con menos personal.',
      datos: { fechas: dias.map(p => p.fecha_target), efecto_pesos: Math.round(efecto), factor: c?.factor ?? null },
    });
  }

  // 4. Hora pico de mañana
  const manana = preds[0];
  if (manana?.franjas?.hora_pico && manana?.franjas?.hora_floja) {
    const { hora_pico: hp, hora_floja: hf } = manana.franjas;
    recs.push({
      id: 'PREDICCION_FRANJAS_MANANA',
      categoria: 'prediccion',
      prioridad: 'info',
      mensaje: `Mañana (${nombreDia(manana)}) tu hora más fuerte es a las ${hp.hora} h (${fmt(hp.esperado)}) y la más floja a las ${hf.hora} h (${fmt(hf.esperado)}).`,
      accion: `Asegurate de tener a alguien en caja desde las ${hp.hora - 1}:30, y usá la franja de las ${hf.hora} h para reponer y ordenar.`,
      datos: { fecha: manana.fecha_target, hora_pico: hp, hora_floja: hf },
    });
  }

  // Primera letra en mayúscula ("viernes 30/10: ..." → "Viernes 30/10: ...")
  recs.forEach(x => { x.mensaje = x.mensaje.charAt(0).toUpperCase() + x.mensaje.slice(1); });
  return recs;
}

module.exports = { recomendacionesDePrediccion };
