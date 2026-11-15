// ticket.js — comprobante de una venta para el cliente (impreso o por WhatsApp) (14/11/2026).
// No es una factura: LumoBi no hace facturación electrónica. El ticket lo dice claramente.
const pool = require('./db');

const MEDIO = { efectivo: 'Efectivo', debito: 'Débito', credito: 'Crédito', transferencia: 'Transferencia', mp: 'Mercado Pago', qr: 'QR', mixto: 'Efectivo + otro medio' };

async function armar(turno, transaccionId, db = pool) {
  await require('./caja_extra').asegurar(db);
  const t = (await db.query(
    `SELECT t.id, t.monto::float AS total, t.metodo_pago, t.monto_efectivo::float AS monto_efectivo, t.metodo_resto, t.empleado,
            to_char(t.fecha - INTERVAL '3 hours','DD/MM/YYYY HH24:MI') AS fecha,
            n.nombre AS negocio, s.nombre AS sucursal,
            NULLIF(trim(concat_ws(' ', s.calle, s.numero, CASE WHEN s.localidad IS NOT NULL THEN '· ' || s.localidad END)), '') AS direccion
       FROM transacciones t
       JOIN negocios n ON n.id = t.negocio_id
       LEFT JOIN mis_sucursales s ON s.id = t.sucursal_id
      WHERE t.id = $1 AND t.turno_id = $2 AND t.tipo = 'venta'`, [transaccionId, turno.id])).rows[0];
  if (!t) return null;
  const items = (await db.query(
    `SELECT COALESCE(d.producto_nombre, p.nombre, 'Producto') AS nombre, d.cantidad::float AS cantidad,
            d.precio_unitario::float AS precio, d.subtotal::float AS subtotal, d.tipo_linea
       FROM transacciones_detalle d LEFT JOIN productos p ON p.id = d.producto_id
      WHERE d.transaccion_id = $1 ORDER BY (d.tipo_linea = 'descuento'), d.id`, [t.id])).rows;
  const pagos = t.metodo_pago === 'mixto' && t.monto_efectivo != null
    ? [{ medio: 'Efectivo', monto: t.monto_efectivo }, { medio: MEDIO[t.metodo_resto] || t.metodo_resto, monto: t.total - t.monto_efectivo }]
    : [{ medio: MEDIO[t.metodo_pago] || t.metodo_pago, monto: t.total }];
  // Nombres cargados con comillas o espacios de más ("" surcursal moron"") salen limpios
  const limpio = (x) => (x == null ? null : String(x).replace(/["“”']/g, '').replace(/\s+/g, ' ').replace(/\s+·/g, ' ·').trim() || null);
  t.negocio = limpio(t.negocio); t.sucursal = limpio(t.sucursal); t.direccion = limpio(t.direccion);
  return {
    numero: t.id, fecha: t.fecha, negocio: t.negocio, sucursal: t.sucursal, direccion: t.direccion, atendio: t.empleado,
    items, total: t.total, pagos, leyenda: 'Comprobante no válido como factura',
  };
}

// Texto para mandar por WhatsApp
function texto(tk) {
  const $ = (n) => '$' + Math.round(n).toLocaleString('es-AR');
  const kg = (c) => (Number.isInteger(c) ? String(c) : c.toLocaleString('es-AR', { maximumFractionDigits: 3 }) + ' kg');
  const l = [`*${tk.negocio}*${tk.sucursal ? ' · ' + tk.sucursal : ''}`, `${tk.fecha} · N° ${tk.numero}`, ''];
  for (const i of tk.items) l.push(i.tipo_linea === 'descuento' ? `${i.nombre}: -${$(Math.abs(i.subtotal))}` : `${kg(i.cantidad)} x ${i.nombre}: ${$(i.subtotal)}`);
  l.push('', `*Total: ${$(tk.total)}*`, tk.pagos.map((p) => `${p.medio} ${$(p.monto)}`).join(' + '), '', `_${tk.leyenda}_`, '¡Gracias por tu compra!');
  return l.join('\n');
}

module.exports = { armar, texto };
