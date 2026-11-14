// guia.js — LumoBi · qué está listo y qué falta para que cada parte de LumoBi funcione (14/11/2026)
// Lo usa la guía de cada pantalla: "Para que esto funcione" con ✓ o lo que falta, y el botón para hacerlo.
const pool = require('./db');

const seguro = (p) => p.then((r) => r.rows[0] || {}).catch(() => ({}));

async function estadoGuia(negocioId, usuarioId, db = pool) {
  const pd = require('./primeros_dias');
  const [c, prod, extra] = await Promise.all([
    pd.conteos(negocioId, null, db).catch(() => ({})),
    seguro(db.query(
      `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE precio_costo > 0)::int con_costo
       FROM productos WHERE negocio_id=$1 AND COALESCE(activo, true)`, [negocioId])),
    seguro(db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM empleados_negocio WHERE negocio_id=$1 AND activo=true) AS empleados,
         (SELECT COUNT(*)::int FROM push_subscriptions WHERE usuario_id=$2) AS celus,
         (SELECT COUNT(*)::int FROM mis_sucursales WHERE negocio_id=$1 AND COALESCE(activo,true)) AS locales,
         (SELECT EXISTS(SELECT 1 FROM integraciones_mp WHERE negocio_id=$1)) AS mp`, [negocioId, usuarioId])),
  ]);
  const gastos = await seguro(db.query(
    `SELECT COUNT(*)::int n FROM gastos_mensuales WHERE negocio_id=$1 AND mes >= date_trunc('month', NOW() - INTERVAL '40 days')`, [negocioId]));
  const facturas = await seguro(db.query('SELECT COUNT(*)::int n FROM compras WHERE negocio_id=$1', [negocioId]));

  const r = (id, listo, falta, ir) => ({ id, listo: !!listo, falta: listo ? null : falta, ir: listo ? null : ir });
  const costoPct = prod.total ? Math.round((prod.con_costo / prod.total) * 100) : 0;
  const dias = c.dias_completos || 0;
  const tipo = c.max_turnos_mismo_tipo || 0;
  const emp = c.max_turnos_empleado || 0;

  const requisitos = {
    empleados: r('empleados', extra.empleados > 0, 'Crear a quien atiende la caja (nombre y PIN)', '/primeros-pasos?paso=caja'),
    caja: r('caja', c.turnos_cerrados > 0, 'Abrir la caja y cerrar el primer turno', '/primeros-pasos?paso=caja'),
    ventas: r('ventas', c.ventas_total > 0, 'Cobrar la primera venta en la caja', '/primeros-pasos?paso=caja'),
    dias3: r('dias3', dias >= 3, `${Math.max(0, 3 - dias)} día${3 - dias === 1 ? '' : 's'} más de ventas (se cuentan solos)`, null),
    turnos5: r('turnos5', tipo >= 5, `${Math.max(0, 5 - tipo)} turno${5 - tipo === 1 ? '' : 's'} más cerrados (se cuentan solos)`, null),
    turnos_emp: r('turnos_emp', emp >= 3, `${Math.max(0, 3 - emp)} turno${3 - emp === 1 ? '' : 's'} más del mismo empleado`, null),
    productos: r('productos', prod.total > 0, 'Cargar productos (o darlos de alta en la caja al vender)', '/catalogo'),
    costos: r('costos', prod.total > 0 && costoPct >= 50, prod.total ? `Cargar el costo de tus productos (hoy tiene costo el ${costoPct}%)` : 'Cargar tus productos con su costo', '/catalogo'),
    gastos: r('gastos', gastos.n > 0, 'Cargar los gastos fijos del mes (alquiler, sueldos, luz)', '/rentabilidad'),
    facturas: r('facturas', facturas.n > 0, 'Sacarle foto a una factura de proveedor', '/compras'),
    avisos: r('avisos', extra.celus > 0, 'Activar los avisos en tu celu', '/primeros-pasos?paso=avisos'),
    locales: r('locales', extra.locales > 0, 'Cargar tu local (dirección)', '/red'),
    mp: r('mp', extra.mp, 'Conectar Mercado Pago (opcional)', '/ajustes'),
  };
  return { requisitos, conteos: { ...c, productos: prod.total || 0, costo_pct: costoPct, empleados: extra.empleados || 0 } };
}

module.exports = { estadoGuia };
