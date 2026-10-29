// normalizar_respuesta.js — LumoBi (29/10/2026)
// Algunos generadores devuelven el "insight" completo
// {descripcion, contexto, accion_recomendada, texto_completo} en campos que el frontend
// muestra como texto (mensaje, recomendacion…). React no puede mostrar un objeto y la
// pantalla entera se rompe. Este middleware revisa cada respuesta JSON y, SOLO en esos
// campos de texto, reemplaza el objeto por su texto_completo. El campo "insight" queda
// intacto (ahí el objeto es lo esperado).
const CAMPOS_TEXTO = new Set(['mensaje', 'recomendacion', 'texto', 'detalle', 'descripcion_corta']);

function esInsight(v) {
  return v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.texto_completo === 'string' && 'accion_recomendada' in v;
}

function normalizar(v, prof = 0) {
  if (prof > 15 || v == null || typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const x of v) normalizar(x, prof + 1); return; }
  for (const k of Object.keys(v)) {
    if (CAMPOS_TEXTO.has(k) && esInsight(v[k])) v[k] = v[k].texto_completo;
    else normalizar(v[k], prof + 1);
  }
}

module.exports = function normalizarRespuesta(req, res, next) {
  const original = res.json.bind(res);
  res.json = (body) => {
    try { normalizar(body); } catch { /* ante cualquier duda, se manda tal cual */ }
    return original(body);
  };
  next();
};
module.exports.normalizar = normalizar;
