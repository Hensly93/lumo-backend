// exportar.js — "Tus datos son tuyos": el dueño descarga lo que LumoBi guarda de su negocio, en CSV que abre Excel.
// Separador ";" y UTF-8 con BOM (así Excel en español no rompe las tildes ni las columnas). Hora de Argentina. Solo de SU negocio.
const pool = require('./db');

const CONSULTAS = {
  ventas: {
    archivo: 'ventas',
    cols: ['Fecha y hora', 'Venta N°', 'Tipo', 'Medio de pago', 'Total', 'Empleado', 'Producto', 'Cantidad', 'Subtotal'],
    sql: `SELECT to_char(t.fecha - INTERVAL '3 hours','YYYY-MM-DD HH24:MI') AS a, t.id AS b, COALESCE(t.tipo,'venta') AS c, t.metodo_pago AS d, t.monto AS e, t.empleado AS f,
                 COALESCE(d.producto_nombre, p.nombre) AS g, d.cantidad AS h, d.subtotal AS i
            FROM transacciones t LEFT JOIN transacciones_detalle d ON d.transaccion_id = t.id LEFT JOIN productos p ON p.id = d.producto_id
           WHERE t.negocio_id = $1 ORDER BY t.fecha, t.id, d.id LIMIT 300000`,
  },
  productos: {
    archivo: 'productos',
    cols: ['Producto', 'Categoría', 'Precio de venta', 'Costo', 'Unidad', 'Código de barras', 'Activo'],
    sql: `SELECT nombre AS a, categoria AS b, precio_venta AS c, precio_costo AS d, unidad AS e, codigo_barras AS f, CASE WHEN COALESCE(activo,true) THEN 'Sí' ELSE 'No' END AS g
            FROM productos WHERE negocio_id = $1 ORDER BY nombre`,
  },
  compras: {
    archivo: 'compras',
    cols: ['Fecha', 'Proveedor', 'Factura N°', 'Producto', 'Cantidad', 'Precio unitario', 'Subtotal'],
    sql: `SELECT c.fecha::text AS a, c.proveedor AS b, c.numero AS c, i.descripcion AS d, i.cantidad AS e, i.precio_unitario AS f, i.subtotal AS g
            FROM compras c LEFT JOIN compras_items i ON i.compra_id = c.id WHERE c.negocio_id = $1 ORDER BY c.fecha, c.id, i.id`,
  },
  turnos: {
    archivo: 'turnos_de_caja',
    cols: ['Turno N°', 'Empleado', 'Turno', 'Apertura', 'Cierre', 'Caja al abrir', 'Caja al cerrar', 'Estado'],
    sql: `SELECT id AS a, nombre_empleado AS b, tipo_turno AS c, to_char(hora_apertura - INTERVAL '3 hours','YYYY-MM-DD HH24:MI') AS d,
                 to_char(hora_cierre - INTERVAL '3 hours','YYYY-MM-DD HH24:MI') AS e, caja_apertura AS f, caja_cierre AS g, estado AS h
            FROM turnos_caja WHERE negocio_id = $1 ORDER BY hora_apertura`,
  },
};

// Evita que Excel ejecute fórmulas escondidas en un texto que empiece con = + - @ (inyección CSV)
function celda(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+@]/.test(s) || (/^-/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s))) s = "'" + s;
  if (/^-?\d+\.\d+$/.test(s)) s = s.replace('.', ','); // decimales con coma, como Excel en español
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function generar(negocioId, tipo, db = pool) {
  const c = CONSULTAS[tipo];
  if (!c) return null;
  const rows = (await db.query(c.sql, [negocioId])).rows;
  const claves = Object.keys(rows[0] || {});
  const lineas = [c.cols.join(';'), ...rows.map((r) => Object.keys(r).map((k) => celda(r[k])).join(';'))];
  const hoy = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  return { nombre: `lumobi_${c.archivo}_${hoy}.csv`, cuerpo: '﻿' + lineas.join('\r\n') + '\r\n', filas: rows.length, claves };
}

module.exports = { generar, TIPOS: Object.keys(CONSULTAS) };
