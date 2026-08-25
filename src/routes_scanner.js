const express = require('express');
const router = express.Router();
const pool = require('./db');

// ─────────────────────────────────────────────────────────────────────
// GET /api/scanner/producto?turno_id=X&codigo=Y
// Busca producto por código de barras en el negocio del turno activo
// ─────────────────────────────────────────────────────────────────────
router.get('/producto', async (req, res) => {
  try {
    const { turno_id, codigo } = req.query;
    if (!turno_id || !codigo) {
      return res.status(400).json({ error: 'turno_id y codigo requeridos' });
    }

    const turno = await pool.query(
      `SELECT negocio_id FROM turnos_caja WHERE id=$1 AND estado='activo'`,
      [turno_id]
    );
    if (turno.rows.length === 0) {
      return res.status(400).json({ error: 'Turno no activo' });
    }

    const negocio_id = turno.rows[0].negocio_id;
    const producto = await pool.query(
      'SELECT * FROM productos WHERE negocio_id=$1 AND codigo_barras=$2',
      [negocio_id, codigo]
    );

    if (producto.rows.length === 0) {
      return res.json({ existe: false, codigo });
    }

    res.json({ existe: true, producto: producto.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/scanner/sesion
// Crea sesión temporal que vincula scanner con turno activo
// Body: { turno_id }
// ─────────────────────────────────────────────────────────────────────
router.post('/sesion', async (req, res) => {
  try {
    const { turno_id } = req.body;
    if (!turno_id) {
      return res.status(400).json({ error: 'turno_id requerido' });
    }

    // Verificar que el turno existe y está activo
    const turno = await pool.query(
      `SELECT negocio_id FROM turnos_caja WHERE id=$1 AND estado='activo'`,
      [turno_id]
    );
    if (turno.rows.length === 0) {
      return res.status(400).json({ error: 'Turno no existe o no está activo' });
    }

    const negocio_id = turno.rows[0].negocio_id;

    // Crear sesión con expiración de 8 horas
    const expira = new Date();
    expira.setHours(expira.getHours() + 8);

    const result = await pool.query(
      `INSERT INTO sesiones_scanner (turno_id, negocio_id, expira_en)
       VALUES ($1, $2, $3)
       RETURNING token, expira_en`,
      [turno_id, negocio_id, expira]
    );

    res.json({
      token: result.rows[0].token,
      expira_en: result.rows[0].expira_en,
      turno_id,
      negocio_id
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/scanner/sesion/:token
// Valida sesión de scanner y retorna info del turno
// ─────────────────────────────────────────────────────────────────────
router.get('/sesion/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const sesion = await pool.query(
      `SELECT s.*, t.nombre_empleado, t.estado
       FROM sesiones_scanner s
       JOIN turnos_caja t ON s.turno_id = t.id
       WHERE s.token = $1 AND s.expira_en > NOW()`,
      [token]
    );

    if (sesion.rows.length === 0) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }

    const s = sesion.rows[0];
    if (s.estado !== 'activo') {
      return res.status(400).json({ error: 'El turno asociado no está activo' });
    }

    res.json({
      valida: true,
      turno_id: s.turno_id,
      negocio_id: s.negocio_id,
      empleado: s.nombre_empleado,
      expira_en: s.expira_en
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/scanner/carrito
// Agrega item al carrito del turno
// Body: { turno_id, producto_id, cantidad, agregado_por }
// ─────────────────────────────────────────────────────────────────────
router.post('/carrito', async (req, res) => {
  try {
    const { turno_id, producto_id, cantidad, agregado_por } = req.body;

    if (!turno_id || !producto_id || !cantidad || !agregado_por) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const turno = await pool.query(
      `SELECT negocio_id FROM turnos_caja WHERE id=$1 AND estado='activo'`,
      [turno_id]
    );
    if (turno.rows.length === 0) {
      return res.status(400).json({ error: 'Turno no activo' });
    }

    const negocio_id = turno.rows[0].negocio_id;

    const producto = await pool.query(
      `SELECT id, precio_venta FROM productos WHERE id=$1 AND negocio_id=$2`,
      [producto_id, negocio_id]
    );

    if (producto.rows.length === 0) {
      return res.status(400).json({ error: 'Producto no pertenece a este negocio' });
    }

    const precio_unitario = producto.rows[0].precio_venta;

    const result = await pool.query(
      `INSERT INTO carrito_items (turno_id, producto_id, cantidad, precio_unitario, agregado_por)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [turno_id, producto_id, cantidad, precio_unitario, agregado_por]
    );

    res.json({ item: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/scanner/carrito/:turno_id
// Obtiene todos los items del carrito de un turno
// ─────────────────────────────────────────────────────────────────────
router.get('/carrito/:turno_id', async (req, res) => {
  try {
    const { turno_id } = req.params;

    const items = await pool.query(
      `SELECT c.*, p.nombre as producto_nombre, p.codigo_barras
       FROM carrito_items c
       JOIN productos p ON c.producto_id = p.id
       WHERE c.turno_id = $1
       ORDER BY c.creado_en DESC`,
      [turno_id]
    );

    const total = items.rows.reduce((sum, item) => {
      return sum + (parseFloat(item.cantidad) * parseFloat(item.precio_unitario));
    }, 0);

    res.json({
      items: items.rows,
      total,
      cantidad_items: items.rows.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/scanner/carrito/:turno_id/:item_id
// Elimina un item del carrito
// ─────────────────────────────────────────────────────────────────────
router.delete('/carrito/:turno_id/:item_id', async (req, res) => {
  try {
    const { turno_id, item_id } = req.params;

    const result = await pool.query(
      `DELETE FROM carrito_items WHERE id=$1 AND turno_id=$2 RETURNING *`,
      [item_id, turno_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item no encontrado' });
    }

    res.json({ eliminado: true, item: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/scanner/finalizar-venta
// Convierte carrito en transacción + transacciones_detalle y vacía carrito
// Body: { turno_id, metodo_pago }
// ─────────────────────────────────────────────────────────────────────
router.post('/finalizar-venta', async (req, res) => {
  const client = await pool.connect();
  try {
    const { turno_id, metodo_pago } = req.body;

    if (!turno_id || !metodo_pago) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    await client.query('BEGIN');

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
      `INSERT INTO transacciones (negocio_id, monto, tipo, empleado, turno, metodo_pago, sucursal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, fecha`,
      [negocio_id, monto_total, 'venta', nombre_empleado, tipo_turno, metodo_pago, sucursal_id]
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

    // Vaciar carrito
    await client.query('DELETE FROM carrito_items WHERE turno_id=$1', [turno_id]);

    await client.query('COMMIT');

    res.json({
      exito: true,
      transaccion_id,
      monto_total,
      items_procesados: carrito.rows.length,
      fecha: transaccion.rows[0].fecha
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/scanner/carrito/:turno_id/:item_id
// Actualiza cantidad de un item en el carrito
// Body: { cantidad }
// ─────────────────────────────────────────────────────────────────────
router.patch('/carrito/:turno_id/:item_id', async (req, res) => {
  try {
    const { turno_id, item_id } = req.params;
    const { cantidad } = req.body;

    if (!cantidad || cantidad <= 0) {
      return res.status(400).json({ error: 'Cantidad inválida' });
    }

    const result = await pool.query(
      `UPDATE carrito_items
       SET cantidad = $1
       WHERE id=$2 AND turno_id=$3
       RETURNING *`,
      [cantidad, item_id, turno_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item no encontrado' });
    }

    res.json({ actualizado: true, item: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/scanner/producto
// Alta rápida de producto cuando el código escaneado no existe
// Body: { turno_id, codigo_barras, nombre, precio_venta }
// ─────────────────────────────────────────────────────────────────────
router.post('/producto', async (req, res) => {
  try {
    const { turno_id, codigo_barras, nombre, precio_venta } = req.body;

    if (!turno_id || !codigo_barras || !nombre || precio_venta === undefined) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const turno = await pool.query(
      `SELECT negocio_id FROM turnos_caja WHERE id=$1 AND estado='activo'`,
      [turno_id]
    );
    if (turno.rows.length === 0) {
      return res.status(400).json({ error: 'Turno no activo' });
    }

    const negocio_id = turno.rows[0].negocio_id;

    const result = await pool.query(
      `INSERT INTO productos (negocio_id, nombre, precio_venta, codigo_barras)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [negocio_id, nombre.trim(), precio_venta, codigo_barras]
    );

    res.json({ producto: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un producto con ese nombre o código de barras en este negocio' });
    }
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
