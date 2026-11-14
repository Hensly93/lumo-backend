// ventas_turno.js — LumoBi · las ventas que pertenecen a UN turno de caja (13/11/2026)
//
// Antes, "ventas del turno" eran todas las ventas del negocio desde la hora de apertura (más las que
// no tenían local). Con dos cajas abiertas a la vez, o dos turnos que se pisan en el cambio, cada
// turno sumaba las ventas del otro y aparecía un faltante de caja que no existía.
//
// Ahora:
//   - Cada venta de la caja guarda turno_id (venta_core.js) → cuenta solo para su turno.
//   - Ventas viejas sin turno_id: cuentan si son del mismo empleado, del mismo local y dentro del
//     horario del turno (compatibilidad con lo cargado antes de este cambio).
//   - Las ventas importadas de Mercado Pago sin turno no entran a ninguna caja (no son efectivo).

const METODOS_NO_EFECTIVO = ['mp', 'mercadopago', 'digital', 'debito', 'tarjetadebito', 'credito', 'tarjetacredito', 'tarjeta', 'transferencia', 'qr', 'cuentamp', 'point', 'posnet'];
const SQL_ES_DIGITAL = `LOWER(REPLACE(REPLACE(COALESCE(metodo_pago,''),' ',''),'_','')) IN (${METODOS_NO_EFECTIVO.map((m) => `'${m}'`).join(',')})`;

async function ventasDelTurno(db, t) {
  const r = await db.query(
    `SELECT
       COALESCE(SUM(monto),0) AS total_ventas,
       COALESCE(SUM(CASE WHEN ${SQL_ES_DIGITAL} THEN monto ELSE 0 END),0) AS total_mp,
       COUNT(*) AS cantidad_tx,
       COALESCE(AVG(monto),0) AS ticket_promedio
     FROM transacciones
     WHERE negocio_id = $1
       AND (
         turno_id = $2
         OR (turno_id IS NULL
             AND empleado = $3
             AND fecha >= $4 AND fecha <= COALESCE($5, NOW())
             AND sucursal_id IS NOT DISTINCT FROM $6::integer)
       )`,
    [t.negocio_id, t.id, t.nombre_empleado, t.hora_apertura, t.hora_cierre || null, t.sucursal_id || null]
  );
  const v = r.rows[0];
  const total_ventas = parseFloat(v.total_ventas);
  const total_mp = parseFloat(v.total_mp);
  return {
    total_ventas,
    total_mp,
    total_efectivo: total_ventas - total_mp,
    cantidad_tx: parseInt(v.cantidad_tx, 10),
    ticket_promedio: parseFloat(v.ticket_promedio),
  };
}

module.exports = { ventasDelTurno, SQL_ES_DIGITAL, METODOS_NO_EFECTIVO };
