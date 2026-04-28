// prediccion_adaptativa.js — Lumo S9
// Motor de predicción adaptativa por dias_datos
//
// Pesos:
//   W1 = señal propia  (crece con datos propios, máx 0.70)
//   W2 = señal zona    (inactivo hasta 5+ negocios por zona)
//   W3 = señal país    (contexto_pais — feriados, quincenas, aguinaldo)
//
// Ventana adaptativa:
//   < 60 días  → predice 7 días  (semana)
//   60-180     → predice 30 días (mes)
//   180+       → predice 90 días (trimestre)

const pool = require('./db');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fechasEnRango(desde, dias) {
  const result = [];
  for (let i = 1; i <= dias; i++) {
    const d = new Date(desde);
    d.setDate(d.getDate() + i);
    result.push(d);
  }
  return result;
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

// ─── Calcular predicción ──────────────────────────────────────────────────────

async function calcularPrediccion(usuario_id, sucursal_id = null, db = pool, riesgo_contexto = null) {
  // 1. Días de datos
  const minRes = await db.query(
    `SELECT MIN(fecha) as primera, COUNT(*) as total
     FROM transacciones
     WHERE usuario_id = $1
       AND ($2::integer IS NULL OR sucursal_id = $2)`,
    [usuario_id, sucursal_id]
  );

  const primera = minRes.rows[0].primera;
  if (!primera || Number(minRes.rows[0].total) < 3) {
    return { disponible: false, motivo: 'datos_insuficientes', minimo_requerido: 3 };
  }

  const dias_datos = Math.floor((Date.now() - new Date(primera).getTime()) / (1000 * 60 * 60 * 24));

  // 2. Pesos
  const W1 = Math.min(dias_datos / 180, 0.70);
  const W2 = 0; // activar cuando haya 5+ negocios por zona
  const W3 = 1 - W1 - W2;

  // 3. Señal propia — promedio por día de semana (últimos 60 días)
  const propiaRes = await db.query(
    `SELECT
       EXTRACT(DOW FROM fecha)::integer AS dia_semana,
       AVG(monto) AS promedio,
       COUNT(*) AS n
     FROM transacciones
     WHERE usuario_id = $1
       AND fecha >= NOW() - INTERVAL '60 days'
       AND ($2::integer IS NULL OR sucursal_id = $2)
     GROUP BY dia_semana`,
    [usuario_id, sucursal_id]
  );

  const señalPorDia = {};
  let sumaTotal = 0;
  let countTotal = 0;
  propiaRes.rows.forEach(r => {
    señalPorDia[r.dia_semana] = parseFloat(r.promedio);
    sumaTotal += parseFloat(r.promedio) * parseInt(r.n);
    countTotal += parseInt(r.n);
  });
  const promedioGeneral = countTotal > 0 ? sumaTotal / countTotal : 0;

  // 5. Ventana adaptativa
  let horizonte, dias_prediccion;
  if (dias_datos < 60)       { horizonte = 'semana';    dias_prediccion = 7;  }
  else if (dias_datos < 180) { horizonte = 'mes';       dias_prediccion = 30; }
  else                       { horizonte = 'trimestre'; dias_prediccion = 90; }

  // 4. Señal país — eventos en la ventana de predicción
  const hoy = new Date();
  const fechaFin = new Date(hoy);
  fechaFin.setDate(fechaFin.getDate() + dias_prediccion);

  const paisRes = await db.query(
    `SELECT fecha, tipo, intensidad, descripcion
     FROM contexto_pais
     WHERE fecha >= $1 AND fecha <= $2
     ORDER BY fecha ASC`,
    [toISODate(hoy), toISODate(fechaFin)]
  );

  const eventosPorFecha = {};
  paisRes.rows.forEach(r => {
    const k = toISODate(new Date(r.fecha));
    if (!eventosPorFecha[k]) eventosPorFecha[k] = [];
    eventosPorFecha[k].push({ tipo: r.tipo, intensidad: parseFloat(r.intensidad), descripcion: r.descripcion });
  });

  // 6. Confianza
  const confianza = Math.min(W1 * 0.8 + (dias_datos > 30 ? 0.2 : 0.1), 0.95);

  // 7. Calcular predicción por fecha
  const fechas = fechasEnRango(hoy, dias_prediccion);
  const predicciones = [];

  for (const fecha of fechas) {
    const dow = fecha.getDay(); // 0=Dom, 1=Lun, ..., 6=Sab
    const fechaStr = toISODate(fecha);

    const señal_propia = señalPorDia[dow] ?? promedioGeneral;
    const eventos = eventosPorFecha[fechaStr] ?? [];

    // Intensidad país: producto de todos los eventos del día (ej: quincena + feriado)
    const intensidad_pais = eventos.length > 0
      ? eventos.reduce((acc, e) => acc * e.intensidad, 1.0)
      : 1.0;

    const señal_pais = señal_propia * intensidad_pais;

    // W2 inactivo → valor_predicho = W1 * propia + W3 * pais
    const valor_predicho = W1 * señal_propia + W3 * señal_pais;

    predicciones.push({
      fecha_target: fechaStr,
      valor_predicho: Math.round(valor_predicho * 100) / 100,
      confianza: Math.round(confianza * 100) / 100,
      horizonte,
      senales_usadas: {
        W1: Math.round(W1 * 1000) / 1000,
        W2,
        W3: Math.round(W3 * 1000) / 1000,
        dias_datos,
        señal_propia: Math.round(señal_propia * 100) / 100,
        intensidad_pais,
        eventos_contexto: eventos,
      },
    });
  }

  // 8. Guardar en predicciones_negocio
  const fecha_prediccion = toISODate(hoy);
  for (const p of predicciones) {
    await db.query(
      `INSERT INTO predicciones_negocio
         (usuario_id, sucursal_id, fecha_prediccion, fecha_target, valor_predicho, confianza, senales_usadas, horizonte)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        usuario_id,
        sucursal_id,
        fecha_prediccion,
        p.fecha_target,
        p.valor_predicho,
        p.confianza,
        JSON.stringify(p.senales_usadas),
        p.horizonte,
      ]
    );
  }

  return {
    disponible: true,
    horizonte,
    dias_datos,
    confianza: Math.round(confianza * 100) / 100,
    pesos: { W1: Math.round(W1 * 1000) / 1000, W2, W3: Math.round(W3 * 1000) / 1000 },
    predicciones,
    total_fechas: predicciones.length,
    eventos_en_ventana: Object.keys(eventosPorFecha).length,
    riesgo_contexto: riesgo_contexto ? {
      risk_score_final:     riesgo_contexto.risk_score_final,
      confirmacion_cruzada: riesgo_contexto.confirmacion_cruzada,
      debe_emitir:          riesgo_contexto.debe_emitir,
    } : null,
  };
}

module.exports = { calcularPrediccion };
