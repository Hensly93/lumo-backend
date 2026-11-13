// venta_core.js — Cierra la venta del carrito de un turno: crea la transacción, el detalle (con foto del producto), baja el stock y vacía el carrito.
// Lo usan la caja (finalizar-venta) y el cobro con QR de Mercado Pago. Tiene que correr dentro de una transacción (BEGIN/COMMIT del que llama).
// extra: { mp_payment_id } cuando el cobro lo confirmó Mercado Pago.

async function cerrarVenta(client, turno_id, metodo_pago, extra) {
  extra = extra || {};
  await require('./catalogo_marca').asegurar();
  // Las tablas de stock se aseguran ANTES de tocar la venta: si se hace adentro, el ALTER espera a esta misma transacción y la primera venta tras un deploy se cuelga.
  try { await require('./stock').asegurar(); } catch (e) { console.error('stock/asegurar:', e.message); }
  // Obtener datos del turno para atribución completa
  const turno = await client.query(
    'SELECT negocio_id, nombre_empleado, tipo_turno, sucursal_id FROM turnos_caja WHERE id=$1 AND estado=$2',
    [turno_id, 'activo']
  );
  if (turno.rows.length === 0) {
    throw new Error('Turno no activo');
  }
  const { negocio_id, nombre_empleado, tipo_turno, sucursal_id } = turno.rows[0];

  // Obtener items del carrito
  const carrito = await client.query(
    'SELECT * FROM carrito_items WHERE turno_id=$1',
    [turno_id]
  );

  if (carrito.rows.length === 0) {
    throw new Error('Carrito vacío');
  }

  // Calcular monto_total del lado del servidor
  let monto_total = 0;
  for (const item of carrito.rows) {
    monto_total += parseFloat(item.cantidad) * parseFloat(item.precio_unitario);
  }

  // Crear transacción con atribución completa para CUSUM/ERM
  const transaccion = await client.query(
    `INSERT INTO transacciones (negocio_id, monto, tipo, empleado, turno, metodo_pago, sucursal_id, mp_payment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, fecha`,
    [negocio_id, monto_total, 'venta', nombre_empleado, tipo_turno, metodo_pago, sucursal_id, extra.mp_payment_id || null]
  );

  const transaccion_id = transaccion.rows[0].id;

  // Insertar detalle de cada item
  for (const item of carrito.rows) {
    const subtotal = parseFloat(item.cantidad) * parseFloat(item.precio_unitario);
    await client.query(
      `INSERT INTO transacciones_detalle
       (transaccion_id, producto_id, cantidad, precio_unitario, subtotal)
       VALUES ($1, $2, $3, $4, $5)`,
      [transaccion_id, item.producto_id, item.cantidad, item.precio_unitario, subtotal]
    );
  }

  // Foto del producto en el momento de la venta: nombre, marca y costo (el historial no cambia si después se edita el producto)
  await client.query(
    `UPDATE transacciones_detalle d SET producto_nombre = p.nombre, producto_marca = p.marca, costo_unitario = p.precio_costo
       FROM productos p WHERE d.transaccion_id = $1 AND p.id = d.producto_id`, [transaccion_id]);

  // Stock liviano: baja lo vendido. Nunca frena ni rompe la venta (si falla, queda anotado en el log).
  await require('./stock').descontarVenta(client, { negocioId: negocio_id, transaccionId: transaccion_id, items: carrito.rows, empleado: nombre_empleado });

  // Vaciar carrito
  await client.query('DELETE FROM carrito_items WHERE turno_id=$1', [turno_id]);

  return { transaccion_id, monto_total, items_procesados: carrito.rows.length, fecha: transaccion.rows[0].fecha };
}

module.exports = { cerrarVenta };
