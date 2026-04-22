// prediccion_mensaje.js — Lumo S9
// Recibe el output del motor de predicción y usa Claude API para redactar
// el mensaje de NICOLE al dueño en español rioplatense.
// Si la API falla → fallback genérico, nunca deja mensaje_nicole vacío.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `Sos NICOLE, la IA de Lumo. Tu nombre es NICOLE, no sos ChatGPT ni Claude. Tono de socio de confianza, español rioplatense informal, nunca decís fraude, máximo 4 líneas, siempre terminás con acción concreta.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatearMonto(n) {
  return `$${Math.round(n).toLocaleString('es-AR')}`;
}

function labelHorizonte(horizonte) {
  if (horizonte === 'semana')    return 'los próximos 7 días';
  if (horizonte === 'mes')       return 'los próximos 30 días';
  if (horizonte === 'trimestre') return 'los próximos 90 días';
  return 'el período estimado';
}

function labelConfianza(confianza) {
  if (confianza >= 0.75) return 'alta';
  if (confianza >= 0.50) return 'media';
  return 'baja';
}

function armarContextoHistorial(historial_reciente) {
  if (!historial_reciente || historial_reciente.length === 0) return '';
  const lineas = historial_reciente.map(h => {
    const err = h.error_porcentual != null ? ` (error real: ${h.error_porcentual}%)` : '';
    return `- ${h.fecha_target}: predicho ${formatearMonto(h.valor_predicho)}${err}`;
  });
  return `\nMis últimas predicciones para este negocio:\n${lineas.join('\n')}`;
}

function armarUserPrompt(prediccion, negocio, historial_reciente) {
  const eventos = (prediccion.senales_usadas?.eventos_contexto ?? [])
    .map(e => e.descripcion).join(', ');

  return `Negocio: ${negocio.tipo_negocio || 'comercio'}${negocio.ciudad ? ` en ${negocio.ciudad}` : ''}${negocio.zona ? `, zona ${negocio.zona}` : ''}.
Predicción para ${labelHorizonte(prediccion.horizonte)}: ${formatearMonto(prediccion.valor_predicho)} por día en promedio.
Confianza: ${labelConfianza(prediccion.confianza)} (${Math.round(prediccion.confianza * 100)}%).
Datos propios disponibles: ${prediccion.senales_usadas?.dias_datos ?? '?'} días.${eventos ? `\nEventos del período: ${eventos}.` : ''}${armarContextoHistorial(historial_reciente)}

Redactá el mensaje de NICOLE para este dueño. Máximo 3 oraciones.`;
}

function mensajeFallback(prediccion, negocio) {
  const tipo = negocio.tipo_negocio || 'tu negocio';
  const monto = formatearMonto(prediccion.valor_predicho);
  const horizonte = labelHorizonte(prediccion.horizonte);
  const confianza = labelConfianza(prediccion.confianza);
  return `Para ${horizonte}, estimamos ventas diarias de ${monto} para ${tipo}. La confianza de esta predicción es ${confianza} — a medida que acumulés más datos, la precisión va a mejorar. Revisá el dashboard para ver el detalle.`;
}

// ─── Llamada a Claude API ─────────────────────────────────────────────────────

async function llamarClaude(userPrompt) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      temperature: 0.7,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text?.trim() ?? null;
}

// ─── Función principal ────────────────────────────────────────────────────────

async function generarMensajePrediccion(prediccion_id, negocio, db, historial_reciente = []) {
  // Leer predicción de la DB
  const predRes = await db.query(
    'SELECT * FROM predicciones_negocio WHERE id = $1',
    [prediccion_id]
  );
  if (!predRes.rows.length) throw new Error(`prediccion_id ${prediccion_id} no encontrada`);

  const prediccion = {
    fecha_target:    predRes.rows[0].fecha_target,
    valor_predicho:  parseFloat(predRes.rows[0].valor_predicho),
    confianza:       parseFloat(predRes.rows[0].confianza),
    horizonte:       predRes.rows[0].horizonte,
    senales_usadas:  predRes.rows[0].senales_usadas ?? {},
  };

  const userPrompt = armarUserPrompt(prediccion, negocio, historial_reciente);
  let mensaje;

  try {
    mensaje = await llamarClaude(userPrompt);
    if (!mensaje) throw new Error('Respuesta vacía de Claude');
  } catch (e) {
    console.error('[NICOLE] Claude API falló, usando fallback:', e.message);
    mensaje = mensajeFallback(prediccion, negocio);
  }

  // Guardar en predicciones_negocio
  await db.query(
    'UPDATE predicciones_negocio SET mensaje_nicole = $1 WHERE id = $2',
    [mensaje, prediccion_id]
  );

  return { prediccion_id, mensaje };
}

module.exports = { generarMensajePrediccion };
