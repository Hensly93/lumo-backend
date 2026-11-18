// ventas_sql.js — UNA sola definición de "venta real" para todos los cálculos de LumoBi (18/11/2026).
// Antes cada archivo tenía su propia copia del filtro y no coincidían: unos contaban las anulaciones como
// tickets, otros no miraban el origen, y los promedios por zona/rubro mezclaban cuentas de prueba.
//
// Reglas (valen para toda la app):
//   · Una venta anulada NO se borra: se agrega una fila tipo='anulacion' con el monto en negativo.
//     Por eso SUM(monto) ya da el neto y no hay que filtrar nada para sumar.
//   · Para CONTAR tickets: ventas − anulaciones (nunca COUNT(*) a secas, que cuenta la anulación como un ticket más).
//   · Cuentan como ventas reales las de origen 'real' y 'importado' (las cargadas desde un archivo).
//   · Las cuentas de prueba (es_prueba, plan 'interna', correos @test/@example) no entran en promedios
//     ni agregados de la red.

// Hora Argentina (la base guarda UTC). FL: sin alias de tabla. FL_T: con alias t.
const FL = `(fecha - INTERVAL '3 hours')`;
const FL_T = `(t.fecha - INTERVAL '3 hours')`;

// Origen de la venta
const REAL = `COALESCE(origin,'real') IN ('real','importado')`;
const REAL_T = `COALESCE(t.origin,'real') IN ('real','importado')`;

// Cantidad de tickets netos dentro de un GROUP BY o agregado (alias de tabla opcional: 't.' o '')
function ticketsNetos(alias = 't.') {
  return `GREATEST(COUNT(*) FILTER (WHERE COALESCE(${alias}tipo,'venta') <> 'anulacion') - COUNT(*) FILTER (WHERE ${alias}tipo = 'anulacion'), 0)`;
}

// Condición SQL: la cuenta (tabla usuarios con ese alias) es de prueba o interna
function cuentaDePrueba(u = 'u') {
  return `(${u}.es_prueba IS TRUE OR COALESCE(${u}.subscription_status,'') = 'interna'
           OR ${u}.email ILIKE '%@test.%' OR ${u}.email ILIKE '%@example.%')`;
}

module.exports = { FL, FL_T, REAL, REAL_T, ticketsNetos, cuentaDePrueba };
