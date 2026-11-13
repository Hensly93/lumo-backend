const express = require('express');
const router = express.Router();
const pool = require('./db');
const { authTurno, crearSesionTurno, verificarBloqueoPin, registrarIntentoPin } = require('./sesion_empleado');
const { registrarCambio } = require('./cambios_precios');
const { registrar: registrarHecho } = require('./registro_hechos');
const { guardia } = require('./autorizacion_caja');

// Si lo que se saca del carrito se pasa de lo habitual en el turno, pide autorización del dueño (ver autorizacion_caja.js).
// Devuelve true si puede seguir; si no, ya respondió 403 con los datos para pedir la autorización.
function guardiaSacar(req, res, item, quitada) {
  const q = Number(quitada) || 0;
  return guardia(req, res, {
    tipo: 'sacar_producto', clave: 'sacar:' + item.id + ':' + (Number(item.cantidad) - q),
    valor: q * (Number(item.precio_unitario) || 0), producto_id: item.producto_id,
  });
}

// Deja anotado en el registro de la caja que se sacó un producto (o parte) del carrito antes de cobrar
function hechoCarrito(req, tipo, item, quitada) {
  if (!item) return null;
  const q = Number(quitada) || 0;
  return registrarHecho({
    negocio_id: req.turno.negocio_id, turno_id: req.turno.id, empleado: req.turno.nombre_empleado, tipo,
    producto_id: item.producto_id, cantidad: q, valor: q * (Number(item.precio_unitario) || 0),
    detalle: { precio_unitario: Number(item.precio_unitario) || 0 },
  });
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/scanner/producto?turno_id=X&codigo=Y
// Busca producto por código de barras en el negocio del turno activo
// ─────────────────────────────────────────────────────────────────────
// GET /api/scanner/buscar?q=  — busca productos del negocio por nombre o por parte del codigo (para la caja)
router.get('/buscar', authTurno, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 60);
    await require('./catalogo_marca').asegurar();
    if (q.length < 2) return res.json({ productos: [] });
    const turno = await pool.query(`SELECT negocio_id FROM turnos_caja WHERE id=$1 AND estado='activo'`, [req.turno.id]);
    if (turno.rows.length === 0) return res.status(400).json({ error: 'Turno no activo' });
    const like = '%' + q.replace(/[%_\\]/g, ' ') + '%';
    const r = await pool.query(
      `SELECT id, nombre, marca, categoria, precio_venta, unidad, codigo_barras
         FROM productos
        WHERE negocio_id = $1 AND COALESCE(activo, true) = true AND (nombre ILIKE $2 OR codigo_barras ILIKE $2)
        ORDER BY (nombre ILIKE $3) DESC, nombre ASC
        LIMIT 8`,
      [turno.rows[0].negocio_id, like, q + '%']
    );
    res.json({ productos: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/producto', authTurno, async (req, res) => {
  try {
    const { codigo } = req.query;
    await require('./catalogo_marca').asegurar();
    const turno_id = req.turno.id;
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
      'SELECT id, nombre, marca, categoria, precio_venta, unidad, codigo_barras FROM productos WHERE negocio_id=$1 AND codigo_barras=$2',
      [negocio_id, codigo]
    );

    if (producto.rows.length === 0) {
      // Código que se unió a otro producto: se encuentra igual
      try { await require('./producto_identidad').asegurar(); const al = await pool.query('SELECT p.id, p.nombre, p.marca, p.categoria, p.precio_venta, p.unidad, p.codigo_barras FROM producto_codigos c JOIN productos p ON p.id=c.producto_id WHERE c.negocio_id=$1 AND c.codigo=$2 AND COALESCE(p.activo,true)', [negocio_id, codigo]); if (al.rows.length) return res.json({ existe: true, producto: al.rows[0] }); } catch (e) { /* sigue como código nuevo */ }
      // Código desconocido: se sugiere nombre y marca desde Open Food Facts para que la alta sea con un toque
      const sugerencia = await require('./catalogo_marca').buscarCodigo(codigo).catch(() => null);
      return res.json({ existe: false, codigo, sugerencia });
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
router.post('/sesion', authTurno, async (req, res) => {
  try {
    const turno_id = req.turno.id;
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

    // Validar formato UUID antes de hacer la query
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(token)) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }

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
    if (e.code === '22P02') {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/scanner/carrito
// Agrega item al carrito del turno
// Body: { turno_id, producto_id, cantidad, agregado_por }
// ─────────────────────────────────────────────────────────────────────
router.post('/carrito', authTurno, async (req, res) => {
  try {
    const { producto_id, cantidad, agregado_por } = req.body;
    const turno_id = req.turno.id;

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

    // Si el mismo producto (al mismo precio) ya esta en el carrito, se suma la cantidad en vez de crear otra linea
    const existente = await pool.query(
      `UPDATE carrito_items SET cantidad = cantidad + $3
        WHERE id = (SELECT id FROM carrito_items WHERE turno_id=$1 AND producto_id=$2 AND precio_unitario=$4 ORDER BY id LIMIT 1)
        RETURNING *`,
      [turno_id, producto_id, cantidad, precio_unitario]
    );
    if (existente.rows.length > 0) return res.json({ item: existente.rows[0] });

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
router.get('/carrito/:turno_id', authTurno, async (req, res) => {
  try {
    const turno_id = req.turno.id;

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
// POST /api/scanner/carrito/:turno_id/:item_id/cantidad  { cantidad } — cambia la cantidad de una linea (0 o menos la borra)
router.post('/carrito/:turno_id/:item_id/cantidad', authTurno, express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const cant = parseFloat(req.body && req.body.cantidad);
    if (!Number.isFinite(cant)) return res.status(400).json({ error: 'Cantidad invalida' });
    if (cant <= 0) {
      const itemPrevio = await pool.query(`SELECT * FROM carrito_items WHERE id=$1 AND turno_id=$2`, [req.params.item_id, req.turno.id]);
      if (itemPrevio.rows[0] && !(await guardiaSacar(req, res, itemPrevio.rows[0], itemPrevio.rows[0].cantidad))) return;
      const borrado = await pool.query(`DELETE FROM carrito_items WHERE id=$1 AND turno_id=$2 RETURNING *`, [req.params.item_id, req.turno.id]);
      if (borrado.rows[0]) await hechoCarrito(req, 'item_borrado', borrado.rows[0], borrado.rows[0].cantidad);
      return res.json({ eliminado: true });
    }
    if (cant > 9999) return res.status(400).json({ error: 'Cantidad demasiado grande' });
    const antes = await pool.query(`SELECT * FROM carrito_items WHERE id=$1 AND turno_id=$2`, [req.params.item_id, req.turno.id]);
    if (antes.rows[0] && cant < Number(antes.rows[0].cantidad) && !(await guardiaSacar(req, res, antes.rows[0], Number(antes.rows[0].cantidad) - cant))) return;
    const r = await pool.query(`UPDATE carrito_items SET cantidad=$3 WHERE id=$1 AND turno_id=$2 RETURNING *`, [req.params.item_id, req.turno.id, cant]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Item no encontrado' });
    if (antes.rows[0] && cant < Number(antes.rows[0].cantidad)) await hechoCarrito(req, 'cantidad_reducida', antes.rows[0], Number(antes.rows[0].cantidad) - cant);
    res.json({ item: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/carrito/:turno_id/:item_id', authTurno, async (req, res) => {
  try {
    const { item_id } = req.params;
    const turno_id = req.turno.id;

    const previo = await pool.query(`SELECT * FROM carrito_items WHERE id=$1 AND turno_id=$2`, [item_id, turno_id]);
    if (previo.rows[0] && !(await guardiaSacar(req, res, previo.rows[0], previo.rows[0].cantidad))) return;
    const result = await pool.query(
      `DELETE FROM carrito_items WHERE id=$1 AND turno_id=$2 RETURNING *`,
      [item_id, turno_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item no encontrado' });
    }

    await hechoCarrito(req, 'item_borrado', result.rows[0], result.rows[0].cantidad);
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
router.post('/finalizar-venta', authTurno, async (req, res) => {
  const client = await pool.connect();
  try {
    const { metodo_pago } = req.body;
    const turno_id = req.turno.id;

    if (!turno_id || !metodo_pago) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    if (!['efectivo', 'debito', 'credito', 'transferencia', 'mp', 'qr'].includes(String(metodo_pago))) {
      return res.status(400).json({ error: 'Medio de pago no válido' });
    }

    await client.query('BEGIN');

    const v = await require('./venta_core').cerrarVenta(client, turno_id, metodo_pago);

    await client.query('COMMIT');

    res.json({
      exito: true,
      transaccion_id: v.transaccion_id,
      monto_total: v.monto_total,
      items_procesados: v.items_procesados,
      fecha: v.fecha
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
router.patch('/carrito/:turno_id/:item_id', authTurno, async (req, res) => {
  try {
    const { item_id } = req.params;
    const turno_id = req.turno.id;
    const { cantidad } = req.body;

    if (!cantidad || cantidad <= 0) {
      return res.status(400).json({ error: 'Cantidad inválida' });
    }
    const antesP = await pool.query(`SELECT * FROM carrito_items WHERE id=$1 AND turno_id=$2`, [item_id, turno_id]);
    if (antesP.rows[0] && Number(cantidad) < Number(antesP.rows[0].cantidad) && !(await guardiaSacar(req, res, antesP.rows[0], Number(antesP.rows[0].cantidad) - Number(cantidad)))) return;

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

    if (antesP.rows[0] && Number(cantidad) < Number(antesP.rows[0].cantidad)) await hechoCarrito(req, 'cantidad_reducida', antesP.rows[0], Number(antesP.rows[0].cantidad) - Number(cantidad));
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
router.post('/producto', authTurno, async (req, res) => {
  try {
    const { codigo_barras, nombre, precio_venta } = req.body;
    const marca = require('./catalogo_marca').limpiarMarca(req.body.marca);
    await require('./catalogo_marca').asegurar();
    const turno_id = req.turno.id;

    if (!turno_id || !codigo_barras || !nombre || precio_venta === undefined) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const turno = await pool.query(
      `SELECT negocio_id, nombre_empleado FROM turnos_caja WHERE id=$1 AND estado='activo'`,
      [turno_id]
    );
    if (turno.rows.length === 0) {
      return res.status(400).json({ error: 'Turno no activo' });
    }

    const { negocio_id, nombre_empleado } = turno.rows[0];

    const permiso = await pool.query(
      `SELECT puede_cargar_productos FROM empleados_negocio WHERE negocio_id=$1 AND nombre=$2 AND activo=true`,
      [negocio_id, nombre_empleado]
    );

    if (permiso.rows.length === 0 || !permiso.rows[0].puede_cargar_productos) {
      return res.status(403).json({ error: 'No tenés permiso para cargar productos nuevos. Pedile al dueño que te lo habilite.' });
    }

    const result = await pool.query(
      `INSERT INTO productos (negocio_id, nombre, precio_venta, codigo_barras, marca)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [negocio_id, nombre.trim(), precio_venta, codigo_barras, marca]
    );

    await registrarHecho({ negocio_id, turno_id, empleado: nombre_empleado, tipo: 'producto_creado', producto_id: result.rows[0].id,
      producto_nombre: result.rows[0].nombre, valor: 0, detalle: { precio_venta: Number(precio_venta) || 0 } });
    res.json({ producto: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un producto con ese nombre o código de barras en este negocio' });
    }
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/scanner/producto/:id/precio
// El empleado cambia el precio de venta o el costo de un producto.
// Se aplica al instante y queda registrado con su nombre. Necesita el mismo permiso que cargar productos.
// Body: { precio_venta?, precio_costo? }
// ─────────────────────────────────────────────────────────────────────
router.post('/producto/:id/precio', authTurno, async (req, res) => {
  try {
    const turno_id = req.turno.id;
    const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
    const nuevoV = num(req.body.precio_venta);
    const nuevoC = num(req.body.precio_costo);
    if (nuevoV == null && nuevoC == null) return res.status(400).json({ error: 'Indicá el precio o el costo' });
    if ((nuevoV != null && !(nuevoV > 0)) || (nuevoC != null && !(nuevoC > 0))) {
      return res.status(400).json({ error: 'El precio tiene que ser un número mayor a cero' });
    }

    const turno = await pool.query(
      `SELECT negocio_id, nombre_empleado FROM turnos_caja WHERE id=$1 AND estado='activo'`,
      [turno_id]
    );
    if (turno.rows.length === 0) return res.status(400).json({ error: 'Turno no activo' });
    const { negocio_id, nombre_empleado } = turno.rows[0];

    const permiso = await pool.query(
      `SELECT puede_cargar_productos FROM empleados_negocio WHERE negocio_id=$1 AND nombre=$2 AND activo=true`,
      [negocio_id, nombre_empleado]
    );
    if (permiso.rows.length === 0 || !permiso.rows[0].puede_cargar_productos) {
      return res.status(403).json({ error: 'No tenés permiso para cambiar precios. Pedile al dueño que te lo habilite.' });
    }

    const prod = await pool.query(
      'SELECT id, nombre, precio_venta, precio_costo FROM productos WHERE id=$1 AND negocio_id=$2 AND activo=true',
      [req.params.id, negocio_id]
    );
    if (prod.rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    const antes = prod.rows[0];
    if (nuevoV != null && Number(antes.precio_venta) > 0 && nuevoV < Number(antes.precio_venta)) {
      const pct = (1 - nuevoV / Number(antes.precio_venta)) * 100;
      if (!(await guardia(req, res, { tipo: 'bajar_precio', clave: 'precio:' + antes.id + ':' + nuevoV, valor: Number(antes.precio_venta) - nuevoV, pct, producto_id: antes.id, producto_nombre: antes.nombre }))) return;
    }

    const upd = await pool.query(
      `UPDATE productos SET precio_venta = COALESCE($1, precio_venta), precio_costo = COALESCE($2, precio_costo), updated_at = NOW()
       WHERE id=$3 AND negocio_id=$4 RETURNING id, nombre, precio_venta`,
      [nuevoV, nuevoC, antes.id, negocio_id]
    );

    if (nuevoV != null) {
      await pool.query('UPDATE carrito_items SET precio_unitario = $1 WHERE turno_id = $2 AND producto_id = $3', [nuevoV, turno_id, antes.id]);
    }

    const cambios = [];
    if (nuevoV != null && Number(antes.precio_venta) !== nuevoV) cambios.push(['precio_venta', antes.precio_venta, nuevoV]);
    if (nuevoC != null && Number(antes.precio_costo) !== nuevoC) cambios.push(['precio_costo', antes.precio_costo, nuevoC]);
    for (const [campo, ant, nue] of cambios) {
      await registrarCambio({
        negocio_id, producto_id: antes.id, producto_nombre: antes.nombre, campo,
        valor_anterior: ant, valor_nuevo: nue, empleado: nombre_empleado, turno_id, origen: 'empleado',
      });
    }
    if (nuevoV != null && antes.precio_venta != null && Number(antes.precio_venta) !== nuevoV) {
      await pool.query(
        `INSERT INTO productos_historico_precios(producto_id, negocio_id, precio_anterior, precio_nuevo, origen)
         VALUES($1,$2,$3,$4,'manual')`,
        [antes.id, negocio_id, antes.precio_venta, nuevoV]
      );
    }

    for (const [campo, ant, nue] of cambios) {
      await registrarHecho({ negocio_id, turno_id, empleado: nombre_empleado, tipo: 'precio_cambiado', producto_id: antes.id,
        producto_nombre: antes.nombre, valor: 0, detalle: { campo, antes: Number(ant), despues: Number(nue) } });
    }
    res.json({ producto: upd.rows[0], cambios: cambios.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
