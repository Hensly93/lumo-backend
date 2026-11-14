// Una sola definición de "faltó plata en la caja" para TODO LumoBi (14/11/2026).
// Antes Períodos contaba cualquier centavo, el wow usaba $200 y Fugas usaba $500 / 0,5%:
// la misma caja daba tres números distintos según la pantalla. Ahora todos usan esto.
// brecha = efectivo esperado - contado. Positiva = falta plata.
const TOLERANCIA_MIN = 500;     // menos de $500 en un turno es cambio/redondeo, no cuenta
const TOLERANCIA_PCT = 0.005;   // ni menos del 0,5% del efectivo esperado

// Monto que faltó en un turno (0 si está dentro de la tolerancia o el dueño lo marcó como gasto)
function faltanteTurno(t) {
  if (t.gasto_inesperado) return 0;
  const b = Number(t.brecha) || 0;
  const tol = Math.max(TOLERANCIA_MIN, (Number(t.caja_esperada) || 0) * TOLERANCIA_PCT);
  return b > tol ? b : 0;
}
function sobranteTurno(t) {
  const b = -(Number(t.brecha) || 0);
  const tol = Math.max(TOLERANCIA_MIN, (Number(t.caja_esperada) || 0) * TOLERANCIA_PCT);
  return b > tol ? b : 0;
}
// Lo mismo en SQL (alias opcional de la tabla turnos_caja)
function sqlFaltante(a = '') {
  const p = a ? a + '.' : '';
  return `(CASE WHEN COALESCE(${p}gasto_inesperado,false) THEN 0
            WHEN ${p}brecha > GREATEST(${TOLERANCIA_MIN}, COALESCE(${p}caja_esperada,0) * ${TOLERANCIA_PCT}) THEN ${p}brecha ELSE 0 END)`;
}
function sqlSobrante(a = '') {
  const p = a ? a + '.' : '';
  return `(CASE WHEN -${p}brecha > GREATEST(${TOLERANCIA_MIN}, COALESCE(${p}caja_esperada,0) * ${TOLERANCIA_PCT}) THEN -${p}brecha ELSE 0 END)`;
}
module.exports = { TOLERANCIA_MIN, TOLERANCIA_PCT, faltanteTurno, sobranteTurno, sqlFaltante, sqlSobrante };
