const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const multer = require('multer');
const { auth } = require('./authMiddleware');

// Helper: Log acción a audit_logs
async function logAudit(usuarioId, accion, detalles = null, req = null) {
  try {
    const ipAddress = req?.ip || req?.connection?.remoteAddress || null;
    const userAgent = req?.get('user-agent') || null;
    await pool.query(
      `INSERT INTO audit_logs(usuario_id, accion, detalles, ip_address, user_agent)
       VALUES($1, $2, $3, $4, $5)`,
      [usuarioId, accion, detalles ? JSON.stringify(detalles) : null, ipAddress, userAgent]
    );
  } catch (e) {
    console.error('Error logging audit:', e.message);
  }
}

// Helper: Cancelar suscripción en Mercado Pago
async function cancelarSuscripcionMP(mp_subscription_id) {
  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

  if (!mp_subscription_id || !MP_ACCESS_TOKEN) {
    console.warn('⚠️ No se puede cancelar en MP: falta ID o token');
    return { success: false, mensaje: 'No se pudo contactar a Mercado Pago' };
  }

  try {
    const response = await fetch(
      `https://api.mercadopago.com/v1/preapproval/${mp_subscription_id}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.ok) {
      console.log('✅ Suscripción cancelada en MP:', mp_subscription_id);
      return { success: true, mensaje: 'Suscripción cancelada en Mercado Pago' };
    } else {
      const errorData = await response.json().catch(() => ({}));
      console.error('❌ Error MP:', response.status, errorData);
      return { success: false, mensaje: `Error al cancelar en Mercado Pago (${response.status})` };
    }
  } catch (error) {
    console.error('❌ Error cancelarSuscripcionMP:', error.message);
    return { success: false, mensaje: 'Error de conexión con Mercado Pago' };
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB máx
});

// ─── GET /api/usuario/perfil ──────────────────────────────────────────────────
router.get('/perfil', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, nombre, email, negocio, tipo_negocio, provincia, ciudad, zona, pos, logo, cuit, razon_social FROM usuarios WHERE id=$1',
      [req.user.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/usuario/perfil ────────────────────────────────────────────────
router.patch('/perfil', auth, async (req, res) => {
  try {
    const { nombre, negocio, tipo_negocio, provincia, ciudad, zona, pos, cuit, razon_social } = req.body;
    const r = await pool.query(
      `UPDATE usuarios SET
        nombre        = COALESCE($1, nombre),
        negocio       = COALESCE($2, negocio),
        tipo_negocio  = COALESCE($3, tipo_negocio),
        provincia     = COALESCE($4, provincia),
        ciudad        = COALESCE($5, ciudad),
        zona          = COALESCE($6, zona),
        pos           = COALESCE($7, pos),
        cuit          = COALESCE($8, cuit),
        razon_social  = COALESCE($9, razon_social)
       WHERE id=$10
       RETURNING id, nombre, email, negocio, tipo_negocio, provincia, ciudad, zona, pos, logo, cuit, razon_social`,
      [
        nombre       || null,
        negocio      || null,
        tipo_negocio || null,
        provincia    || null,
        ciudad       || null,
        zona         || null,
        pos          || null,
        cuit         || null,
        razon_social || null,
        req.user.id,
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/usuario/logo ───────────────────────────────────────────────────
router.post('/logo', auth, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const { mimetype, buffer } = req.file;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimetype)) {
      return res.status(400).json({ error: 'Solo JPG, PNG o WebP' });
    }
    const dataUrl = `data:${mimetype};base64,${buffer.toString('base64')}`;
    const r = await pool.query(
      'UPDATE usuarios SET logo=$1 WHERE id=$2 RETURNING logo',
      [dataUrl, req.user.id]
    );
    res.json({ logo: r.rows[0].logo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/usuario/logo ─────────────────────────────────────────────────
router.delete('/logo', auth, async (req, res) => {
  try {
    await pool.query('UPDATE usuarios SET logo=NULL WHERE id=$1', [req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/usuario/empleados ───────────────────────────────────────────────
router.get('/empleados', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT e.id, e.nombre, e.activo, e.sucursal_id,
              s.nombre AS sucursal_nombre
       FROM empleados_negocio e
       LEFT JOIN mis_sucursales s ON e.sucursal_id = s.id
       WHERE e.negocio_id=$1 AND e.activo=true
       ORDER BY e.nombre`,
      [req.user.negocio_id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/usuario/empleados ─────────────────────────────────────────────
router.post('/empleados', auth, async (req, res) => {
  try {
    const { nombre, pin, sucursal_id } = req.body;
    if (!nombre || !pin) return res.status(400).json({ error: 'nombre y pin requeridos' });
    if (String(pin).length !== 4 || isNaN(Number(pin))) {
      return res.status(400).json({ error: 'PIN debe ser 4 dígitos numéricos' });
    }
    const pin_hash = await bcrypt.hash(String(pin), 10);
    const r = await pool.query(
      `INSERT INTO empleados_negocio(negocio_id, nombre, pin_hash, sucursal_id)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(negocio_id, nombre)
       DO UPDATE SET pin_hash=$3, sucursal_id=$4, activo=true
       RETURNING id, nombre, sucursal_id, activo`,
      [req.user.negocio_id, nombre.trim(), pin_hash, sucursal_id || null]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/usuario/empleados/:id ────────────────────────────────────────
router.patch('/empleados/:id', auth, async (req, res) => {
  try {
    const { nombre, pin, sucursal_id, puede_cargar_productos } = req.body;

    const emp = await pool.query(
      'SELECT id, pin_hash FROM empleados_negocio WHERE id=$1 AND negocio_id=$2',
      [req.params.id, req.user.negocio_id]
    );
    if (emp.rows.length === 0) return res.status(404).json({ error: 'Empleado no encontrado' });

    let pin_hash = emp.rows[0].pin_hash;
    if (pin !== undefined && pin !== '') {
      if (String(pin).length !== 4 || isNaN(Number(pin))) {
        return res.status(400).json({ error: 'PIN debe ser 4 dígitos numéricos' });
      }
      pin_hash = await bcrypt.hash(String(pin), 10);
    }

    const r = await pool.query(
      `UPDATE empleados_negocio SET
        nombre                  = COALESCE($1, nombre),
        pin_hash                = $2,
        sucursal_id             = COALESCE($3, sucursal_id),
        puede_cargar_productos  = COALESCE($4, puede_cargar_productos)
       WHERE id=$5 AND negocio_id=$6
       RETURNING id, nombre, sucursal_id, activo, puede_cargar_productos`,
      [nombre?.trim() || null, pin_hash, sucursal_id || null, puede_cargar_productos ?? null, req.params.id, req.user.negocio_id]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/usuario/empleados/:id ───────────────────────────────────────
router.delete('/empleados/:id', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE empleados_negocio SET activo=false WHERE id=$1 AND negocio_id=$2 RETURNING id',
      [req.params.id, req.user.negocio_id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/usuario/notificaciones ─────────────────────────────────────────
router.get('/notificaciones', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT notificaciones_config FROM usuarios WHERE id=$1',
      [req.user.id]
    );
    const defaults = {
      alertas_criticas:  true,
      alertas_medias:    true,
      conteos_perdidos:  true,
      resumen_diario:    false,
    };
    res.json({ ...defaults, ...(r.rows[0]?.notificaciones_config || {}) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/usuario/notificaciones ───────────────────────────────────────
router.patch('/notificaciones', auth, async (req, res) => {
  try {
    const allowed = ['alertas_criticas', 'alertas_medias', 'conteos_perdidos', 'resumen_diario'];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = Boolean(req.body[key]);
    }
    await pool.query(
      `UPDATE usuarios SET notificaciones_config = notificaciones_config || $1::jsonb WHERE id=$2`,
      [JSON.stringify(patch), req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/usuario/me/subscription/cancel ─────────────────────────────
router.patch('/me/subscription/cancel', auth, async (req, res) => {
  try {
    const usuarioId = req.user.id;

    // Verificar que existe y obtener estado actual
    const user = await pool.query(
      `SELECT id, subscription_status, cancelled_at, mp_subscription_id FROM usuarios WHERE id=$1`,
      [usuarioId]
    );
    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const userData = user.rows[0];

    // Si ya está cancelada, no hacer nada
    if (userData.subscription_status === 'cancelled') {
      return res.status(400).json({
        success: false,
        error: 'La suscripción ya está cancelada',
        datos: { subscription_status: 'cancelled', cancelled_at: userData.cancelled_at },
      });
    }

    // PASO 1: Si existe suscripción en MP, cancelarla primero
    let mpResult = { success: true, mensaje: 'N/A' };
    if (userData.mp_subscription_id) {
      mpResult = await cancelarSuscripcionMP(userData.mp_subscription_id);
      if (!mpResult.success) {
        console.warn('⚠️ MP cancelation failed pero continuamos:', mpResult.mensaje);
        // No bloqueamos por error en MP, solo log
      }
    }

    // Calcular fecha de fin (hoy + 30 días = período de gracia)
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 30);

    // Actualizar usuario: marcar como cancelado
    const result = await pool.query(
      `UPDATE usuarios SET
        subscription_status = 'cancelada',
        subscription_end_date = $1,
        cancelled_at = NOW()
       WHERE id=$2
       RETURNING id, email, subscription_status, subscription_end_date, cancelled_at, mp_subscription_id`,
      [endDate, usuarioId]
    );

    // Loguear acción
    await logAudit(usuarioId, 'subscription_cancelled', {
      subscription_status: 'cancelada',
      subscription_end_date: endDate,
      mp_result: mpResult,
    }, req);

    res.json({
      success: true,
      mensaje: `Suscripción cancelada. Acceso disponible hasta ${endDate.toLocaleDateString('es-AR')}.`,
      mercado_pago: mpResult,
      datos: result.rows[0],
    });
  } catch (e) {
    console.error('cancel-subscription error:', e.message);
    res.status(500).json({
      success: false,
      error: 'Error cancelando suscripción: ' + e.message,
    });
  }
});

// ─── DELETE /api/usuario/me (borrar cuenta) ────────────────────────────────
router.delete('/me', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const usuarioId = req.user.id;
    const { password } = req.body || {};

    if (!password) {
      return res.status(400).json({
        success: false,
        error: 'Contraseña requerida para borrar cuenta',
      });
    }

    // Obtener usuario y verificar contraseña
    const userResult = await client.query(
      `SELECT id, email, password, subscription_status, created_at, mp_subscription_id FROM usuarios WHERE id=$1`,
      [usuarioId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Usuario no encontrado',
      });
    }

    const userData = userResult.rows[0];

    // Verificar contraseña
    const passwordValid = await bcrypt.compare(password, userData.password);
    if (!passwordValid) {
      await logAudit(usuarioId, 'delete_attempt_invalid_password', null, req);
      return res.status(401).json({
        success: false,
        error: 'Contraseña incorrecta',
      });
    }

    // VALIDACIÓN 1: No permitir borrar si está en trial (< 7 días desde creación)
    const createdAt = new Date(userData.created_at);
    const daysSinceCreation = Math.floor((Date.now() - createdAt) / (1000 * 60 * 60 * 24));
    if (daysSinceCreation < 7 && userData.subscription_status === 'trial') {
      return res.status(403).json({
        success: false,
        error: 'No puedes borrar tu cuenta durante el período de prueba (7 días). Intenta después.',
      });
    }

    // VALIDACIÓN 2: No permitir si tiene suscripción activa sin cancelar
    if (userData.subscription_status === 'activa') {
      return res.status(403).json({
        success: false,
        error: 'Debes cancelar tu suscripción antes de borrar la cuenta. Usa PATCH /api/usuario/me/subscription/cancel',
      });
    }

    // VALIDACIÓN 3: Si existe suscripción en MP, cancelarla primero
    let mpDeletionResult = { success: true, mensaje: 'N/A' };
    if (userData.mp_subscription_id) {
      mpDeletionResult = await cancelarSuscripcionMP(userData.mp_subscription_id);
      if (!mpDeletionResult.success) {
        // No bloqueamos pero log la falla
        console.warn('⚠️ No se pudo cancelar suscripción en MP, pero continuamos con borrado local:', mpDeletionResult.mensaje);
        await logAudit(usuarioId, 'delete_mp_cancellation_failed', {
          mp_subscription_id: userData.mp_subscription_id,
          error: mpDeletionResult.mensaje,
        }, req);
      }
    }

    // Comenzar transacción
    await client.query('BEGIN');

    // PASO 1: Si tiene suscripción cancelada, marcarla como expirada
    if (userData.subscription_status === 'cancelled') {
      await client.query(
        `UPDATE usuarios SET subscription_status='expired' WHERE id=$1`,
        [usuarioId]
      );
    }

    // PASO 2: Loguear borrado
    await client.query(
      `INSERT INTO audit_logs(usuario_id, accion, detalles, ip_address, user_agent)
       VALUES($1, $2, $3, $4, $5)`,
      [
        usuarioId,
        'account_deletion_initiated',
        JSON.stringify({ email: userData.email, reason: 'user_requested' }),
        req.ip || req.connection?.remoteAddress || null,
        req.get('user-agent') || null,
      ]
    );

    // PASO 3: Guardar registro en deleted_accounts (para prevenir re-registro 30 días)
    const restorationDate = new Date();
    restorationDate.setDate(restorationDate.getDate() + 30);

    await client.query(
      `INSERT INTO deleted_accounts(usuario_id, email, restoration_available_until, reason)
       VALUES($1, $2, $3, $4)`,
      [usuarioId, userData.email, restorationDate, 'user_requested']
    );

    // PASO 4: Borrar todos los negocios donde el usuario es owner
    // (CASCADE borrará automáticamente todo lo asociado a esos negocios)
    const rolesResult = await client.query(
      `SELECT rol, negocio_id FROM negocio_usuarios WHERE usuario_id=$1 AND activo=true`,
      [usuarioId]
    );

    for (const row of rolesResult.rows) {
      const { rol, negocio_id: negocioId } = row;

      if (rol === 'owner') {
        await client.query(`DELETE FROM negocios WHERE id=$1`, [negocioId]);
      }
    }

    // PASO 5: Borrar el usuario
    // Las FK con ON DELETE SET NULL (transacciones, baseline_negocio, turnos_caja, etc.)
    // automáticamente pondrán usuario_id=NULL en negocios compartidos donde era socio
    await client.query(`DELETE FROM usuarios WHERE id=$1`, [usuarioId]);

    await client.query('COMMIT');

    res.json({
      success: true,
      mensaje: 'Cuenta eliminada exitosamente. Tus datos han sido borrados permanentemente.',
      aviso: 'No podrás registrarte con este email durante 30 días.',
      mercado_pago: mpDeletionResult,
      datos: {
        email: userData.email,
        deleted_at: new Date().toISOString(),
        restoration_available_until: restorationDate.toISOString(),
      },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('delete-account error:', e.message);
    res.status(500).json({
      success: false,
      error: 'Error borrando cuenta: ' + e.message,
    });
  } finally {
    client.release();
  }
});

module.exports = router;
