const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { analizarCruceTurno, detectarGoteo, resumenPatronesNegocio } = require('./cruce_variables');
const { analizarTurnoConContexto, rankingEmpleadosTurno, contextTurnoActivo, detectarCambioComportamiento } = require('./zscore_contextual');
const { calcularRiesgoEmpleado } = require('./erm');
const { notificarUsuario } = require('./push');
const { auth } = require('./authMiddleware');
const { analizarTramo1EnVivo } = require('./perfil_conteo');

// Calcula hora aleatoria para conteo: entre 40 y 180 min despues de la apertura
function calcularHoraConteo(desde) {
  const minutos = 40 + Math.floor(Math.random() * 141);
  return new Date(new Date(desde).getTime() + minutos * 60000);
}

function calcularTipoTurno() {
  const h = new Date().getHours();
  if (h >= 6 && h < 14) return 'manana';
  if (h >= 14 && h < 22) return 'tarde';
  return 'noche';
}

// ─── Empleados ──────────────────────────────────────────────────────────────

// GET /api/caja/empleados — con auth, para pantalla del dueño (usa JWT)
router.get('/empleados', auth, async (req, res) => {
  try {
    const sucursalId = req.query.sucursal_id ? parseInt(req.query.sucursal_id) : null;
    const result = await pool.query(
      `SELECT id, nombre, sucursal_id FROM empleados_negocio
       WHERE negocio_id=$1 AND activo=true
         AND ($2::integer IS NULL OR sucursal_id = $2)
       ORDER BY nombre`,
      [req.user.negocio_id, sucursalId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/caja/empleados/:negocio_id?sucursal_id=X — público, para login de empleados
router.get('/empleados/:negocio_id', async (req, res) => {
  try {
    const sucursalId = req.query.sucursal_id ? parseInt(req.query.sucursal_id) : null;
    const result = await pool.query(
      `SELECT id, nombre, sucursal_id FROM empleados_negocio
       WHERE negocio_id=$1 AND activo=true
         AND ($2::integer IS NULL OR sucursal_id = $2)
       ORDER BY nombre`,
      [req.params.negocio_id, sucursalId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/caja/empleados — registrar empleado (lo usa el dueño)
router.post('/empleados', auth, async (req, res) => {
  try {
    const negocio_id = req.user.negocio_id;
    const { nombre, pin, sucursal_id } = req.body;
    if (!nombre || !pin) {
      return res.status(400).json({ error: 'nombre y pin requeridos' });
    }
    if (String(pin).length !== 4 || isNaN(Number(pin))) {
      return res.status(400).json({ error: 'PIN debe ser 4 dígitos numéricos' });
    }
    const pin_hash = await bcrypt.hash(String(pin), 10);
    const result = await pool.query(
      `INSERT INTO empleados_negocio(negocio_id, nombre, pin_hash, sucursal_id)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(negocio_id, nombre) DO UPDATE SET pin_hash=$3, sucursal_id=$4, activo=true
       RETURNING id, nombre, sucursal_id`,
      [negocio_id, nombre.trim(), pin_hash, sucursal_id || null]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/caja/empleados/:id — desactivar empleado
router.delete('/empleados/:id', async (req, res) => {
  try {
    await pool.query('UPDATE empleados_negocio SET activo=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Validación PIN + estado turno ──────────────────────────────────────────

// POST /api/caja/validar-pin
router.post('/validar-pin', async (req, res) => {
  try {
    const { usuario_id, nombre_empleado, pin } = req.body;
    if (!usuario_id || !nombre_empleado || !pin) {
      return res.status(400).json({ error: 'usuario_id, nombre_empleado y pin requeridos' });
    }

    const emp = await pool.query(
      'SELECT id, pin_hash FROM empleados_negocio WHERE usuario_id=$1 AND nombre=$2 AND activo=true',
      [usuario_id, nombre_empleado]
    );
    if (emp.rows.length === 0) {
      return res.status(401).json({ error: 'Empleado no encontrado' });
    }
    const valido = await bcrypt.compare(String(pin), emp.rows[0].pin_hash);
    if (!valido) {
      return res.status(401).json({ error: 'PIN incorrecto' });
    }

    // Buscar turno activo
    const turno = await pool.query(
      `SELECT * FROM turnos_caja
       WHERE usuario_id=$1 AND nombre_empleado=$2 AND estado='activo'
       ORDER BY hora_apertura DESC LIMIT 1`,
      [usuario_id, nombre_empleado]
    );

    if (turno.rows.length > 0) {
      const t = turno.rows[0];
      const duracionMin = Math.floor((Date.now() - new Date(t.hora_apertura).getTime()) / 60000);
      const egresos = await pool.query(
        'SELECT COALESCE(SUM(monto),0) as total FROM egresos_caja WHERE turno_id=$1',
        [t.id]
      );
      return res.json({
        valido: true,
        turno_activo: { ...t, duracion_minutos: duracionMin, total_egresos: parseFloat(egresos.rows[0].total) }
      });
    }

    res.json({ valido: true, turno_activo: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Apertura de turno (I0) ──────────────────────────────────────────────────

// POST /api/caja/apertura
router.post('/apertura', async (req, res) => {
  try {
    const { usuario_id, nombre_empleado, pin, caja_apertura, sucursal_id } = req.body;
    if (!usuario_id || !nombre_empleado || !pin || caja_apertura === undefined) {
      return res.status(400).json({ error: 'usuario_id, nombre_empleado, pin y caja_apertura requeridos' });
    }

    // Validar PIN
    const emp = await pool.query(
      'SELECT id, pin_hash FROM empleados_negocio WHERE usuario_id=$1 AND nombre=$2 AND activo=true',
      [usuario_id, nombre_empleado]
    );
    if (emp.rows.length === 0) return res.status(401).json({ error: 'Empleado no encontrado' });
    const valido = await bcrypt.compare(String(pin), emp.rows[0].pin_hash);
    if (!valido) return res.status(401).json({ error: 'PIN incorrecto' });

    // Verificar que no haya turno activo
    const activo = await pool.query(
      `SELECT id FROM turnos_caja WHERE usuario_id=$1 AND nombre_empleado=$2 AND estado='activo'`,
      [usuario_id, nombre_empleado]
    );
    if (activo.rows.length > 0) {
      return res.status(400).json({ error: 'Ya tenés un turno activo', turno_id: activo.rows[0].id });
    }

    const horaApertura = new Date();
    const conteoHora = calcularHoraConteo(horaApertura);
    const tipoTurno = calcularTipoTurno();

    const result = await pool.query(
      `INSERT INTO turnos_caja(usuario_id, nombre_empleado, tipo_turno, caja_apertura, hora_apertura, conteo_aleatorio_hora, sucursal_id)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [usuario_id, nombre_empleado, tipoTurno, caja_apertura, horaApertura, conteoHora, sucursal_id || null]
    );

    await pool.query(
      'INSERT INTO conteos_caja(turno_id, tipo, monto_declarado) VALUES($1,$2,$3)',
      [result.rows[0].id, 'apertura', caja_apertura]
    );

    res.json({
      turno: result.rows[0],
      tipo_turno: tipoTurno,
      conteo_aleatorio_hora: conteoHora
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Estado del turno activo ─────────────────────────────────────────────────

// GET /api/caja/turno/:turno_id
router.get('/turno/:turno_id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM turnos_caja WHERE id=$1', [req.params.turno_id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Turno no encontrado' });

    const t = result.rows[0];
    const ahora = new Date();
    const duracionMin = Math.floor((ahora.getTime() - new Date(t.hora_apertura).getTime()) / 60000);

    // Si lleva más de 6 horas y no tiene segundo conteo, agendarlo
    if (duracionMin >= 360 && !t.conteo_aleatorio2_hora) {
      const hora2 = calcularHoraConteo(ahora);
      await pool.query('UPDATE turnos_caja SET conteo_aleatorio2_hora=$1 WHERE id=$2', [hora2, t.id]);
      t.conteo_aleatorio2_hora = hora2;
    }

    const egresos = await pool.query(
      'SELECT COALESCE(SUM(monto),0) as total, COUNT(*) as cantidad FROM egresos_caja WHERE turno_id=$1',
      [t.id]
    );

    res.json({
      ...t,
      duracion_minutos: duracionMin,
      total_egresos: parseFloat(egresos.rows[0].total),
      cantidad_egresos: parseInt(egresos.rows[0].cantidad)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Conteo pendiente (I3) ───────────────────────────────────────────────────

// GET /api/caja/conteo-pendiente/:turno_id
router.get('/conteo-pendiente/:turno_id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM turnos_caja WHERE id=$1', [req.params.turno_id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Turno no encontrado' });

    const t = result.rows[0];
    const ahora = new Date();

    const verificarConteo = (horaConteo, respondido, omitido, numeroConteo) => {
      if (!horaConteo || respondido) return null;
      const ms = ahora.getTime() - new Date(horaConteo).getTime();
      const minutos = Math.floor(ms / 60000);
      if (minutos >= 0 && minutos < 15) {
        return { pendiente: true, numero_conteo: numeroConteo, minutos_restantes: 15 - minutos };
      }
      return null;
    };

    const conteo1 = verificarConteo(t.conteo_aleatorio_hora, t.conteo_aleatorio_respondido, t.conteo_aleatorio_omitido, 1);
    if (conteo1) return res.json(conteo1);

    // Marcar como omitido si pasaron los 15 min — Fix 5: push al dueño
    if (t.conteo_aleatorio_hora && !t.conteo_aleatorio_respondido && !t.conteo_aleatorio_omitido) {
      const min = Math.floor((ahora - new Date(t.conteo_aleatorio_hora)) / 60000);
      if (min >= 15) {
        await pool.query('UPDATE turnos_caja SET conteo_aleatorio_omitido=true WHERE id=$1', [t.id]);
        notificarUsuario(t.usuario_id, {
          title: 'Conteo de caja no respondido',
          body: `${t.nombre_empleado} no respondió el conteo aleatorio a tiempo`,
          url: '/dashboard',
        }, pool, 'conteos_perdidos').catch(() => {});
      }
    }

    const conteo2 = verificarConteo(t.conteo_aleatorio2_hora, t.conteo_aleatorio2_respondido, t.conteo_aleatorio2_omitido, 2);
    if (conteo2) return res.json(conteo2);

    if (t.conteo_aleatorio2_hora && !t.conteo_aleatorio2_respondido && !t.conteo_aleatorio2_omitido) {
      const min = Math.floor((ahora - new Date(t.conteo_aleatorio2_hora)) / 60000);
      if (min >= 15) {
        await pool.query('UPDATE turnos_caja SET conteo_aleatorio2_omitido=true WHERE id=$1', [t.id]);
        notificarUsuario(t.usuario_id, {
          title: 'Conteo de caja no respondido',
          body: `${t.nombre_empleado} no respondió el segundo conteo aleatorio a tiempo`,
          url: '/dashboard',
        }, pool, 'conteos_perdidos').catch(() => {});
      }
    }

    res.json({ pendiente: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Registro de conteo (I3) ─────────────────────────────────────────────────

// POST /api/caja/conteo
router.post('/conteo', async (req, res) => {
  try {
    const { turno_id, monto_declarado, numero_conteo } = req.body;
    if (!turno_id || monto_declarado === undefined) {
      return res.status(400).json({ error: 'turno_id y monto_declarado requeridos' });
    }

    const num = numero_conteo === 2 ? 2 : 1;
    const campo = num === 1 ? 'conteo_aleatorio_respondido' : 'conteo_aleatorio2_respondido';

    await pool.query(`UPDATE turnos_caja SET ${campo}=true WHERE id=$1`, [turno_id]);
    await pool.query(
      'INSERT INTO conteos_caja(turno_id, tipo, monto_declarado, numero_conteo) VALUES($1,$2,$3,$4)',
      [turno_id, 'aleatorio', monto_declarado, num]
    );

    // Push reactivo en conteo del medio (numero_conteo === 1)
    if (num === 1) {
      try {
        const resultado = await analizarTramo1EnVivo(turno_id);
        if (resultado.disponible && resultado.señales && resultado.señales.length > 0) {
          const turno = await pool.query('SELECT usuario_id, nombre_empleado, tipo_turno FROM turnos_caja WHERE id=$1', [turno_id]);
          if (turno.rows.length > 0) {
            const t = turno.rows[0];
            const tipoAlerta = resultado.tramo1.grado === 'critico' ? 'alertas_criticas' : 'alertas_medias';
            await notificarUsuario(t.usuario_id, {
              title: `Movimiento anómalo en caja (mitad del turno)`,
              body: `${t.nombre_empleado} · ${t.tipo_turno} · Tramo 1: ${resultado.tramo1.grado} — ¿Hubo un gasto inesperado?`,
              url: `/dashboard?turno_id=${turno_id}&accion=gasto`,
            }, pool, tipoAlerta);
          }
        }
      } catch (e) {
        console.error('[CONTEO TRAMO1 PUSH]', e.message);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Registro de egresos ─────────────────────────────────────────────────────

// POST /api/caja/egreso
router.post('/egreso', async (req, res) => {
  try {
    const { turno_id, monto, motivo } = req.body;
    if (!turno_id || !monto || !motivo) {
      return res.status(400).json({ error: 'turno_id, monto y motivo requeridos' });
    }

    const turno = await pool.query(
      `SELECT usuario_id FROM turnos_caja WHERE id=$1 AND estado='activo'`,
      [turno_id]
    );
    if (turno.rows.length === 0) return res.status(400).json({ error: 'Turno no activo' });

    await pool.query(
      'INSERT INTO egresos_caja(turno_id, usuario_id, monto, motivo) VALUES($1,$2,$3,$4)',
      [turno_id, turno.rows[0].usuario_id, monto, motivo]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Cierre de turno ─────────────────────────────────────────────────────────

// POST /api/caja/cierre
router.post('/cierre', async (req, res) => {
  try {
    const { turno_id, caja_cierre } = req.body;
    if (!turno_id || caja_cierre === undefined) {
      return res.status(400).json({ error: 'turno_id y caja_cierre requeridos' });
    }

    const turnoRes = await pool.query(
      `SELECT * FROM turnos_caja WHERE id=$1 AND estado='activo'`,
      [turno_id]
    );
    if (turnoRes.rows.length === 0) return res.status(400).json({ error: 'Turno no activo' });
    const t = turnoRes.rows[0];

    const egresos = await pool.query(
      'SELECT COALESCE(SUM(monto),0) as total FROM egresos_caja WHERE turno_id=$1',
      [turno_id]
    );
    const totalEgresos = parseFloat(egresos.rows[0].total);

    // Ventas del turno (por rango de tiempo)
    const ventas = await pool.query(
      `SELECT
         COALESCE(SUM(monto),0) as total_ventas,
         COALESCE(SUM(CASE WHEN metodo_pago='mp' THEN monto ELSE 0 END),0) as total_mp,
         COUNT(*) as cantidad_tx
       FROM transacciones
       WHERE usuario_id=$1 AND fecha >= $2 AND fecha <= NOW()`,
      [t.usuario_id, t.hora_apertura]
    );
    const totalVentas = parseFloat(ventas.rows[0].total_ventas);
    const totalMP = parseFloat(ventas.rows[0].total_mp);

    // Fórmula central
    const efectivoEsperado = parseFloat(t.caja_apertura) + totalVentas - totalMP - totalEgresos;
    const brecha = efectivoEsperado - parseFloat(caja_cierre);
    const brechaPorc = efectivoEsperado > 0 ? (brecha / efectivoEsperado) * 100 : 0;

    await pool.query(
      `UPDATE turnos_caja
       SET estado='cerrado', caja_cierre=$1, caja_esperada=$2, brecha=$3, hora_cierre=NOW()
       WHERE id=$4`,
      [caja_cierre, efectivoEsperado, brecha, turno_id]
    );

    await pool.query(
      'INSERT INTO conteos_caja(turno_id, tipo, monto_declarado) VALUES($1,$2,$3)',
      [turno_id, 'cierre', caja_cierre]
    );

    const estado = Math.abs(brechaPorc) > 10 ? 'critico' : Math.abs(brechaPorc) > 5 ? 'atencion' : 'ok';
    const brechaAbs = Math.abs(brecha);
    const hayBrecha = brechaAbs >= 200;

    // Fix 1+2+3: ERM + push al dueño (fire-and-forget, no bloquea la respuesta)
    setImmediate(async () => {
      try {
        const erm = await calcularRiesgoEmpleado(t.negocio_id, t.nombre_empleado).catch(() => null);
        const ermNivel = erm?.nivel ?? 'sin_datos';

        if (hayBrecha) {
          // Fix 2+3: brecha detectada → push preguntando si fue gasto inesperado
          // Determinar tipo de alerta según severidad
          const tipoAlerta = estado === 'critico' ? 'alertas_criticas' : 'alertas_medias';

          await notificarUsuario(t.usuario_id, {
            title: `Brecha de $${Math.round(brechaAbs).toLocaleString('es-AR')} en el cierre`,
            body: `${t.nombre_empleado} · ${t.tipo_turno} · ERM: ${ermNivel} — ¿Fue un gasto inesperado?`,
            url: `/dashboard?turno_id=${turno_id}&accion=gasto`,
          }, pool, tipoAlerta);
        } else {
          // Fix 2: turno limpio → push positivo
          await notificarUsuario(t.usuario_id, {
            title: 'Turno cerrado sin novedades',
            body: `${t.nombre_empleado} · ${t.tipo_turno} · Caja cuadrada`,
            url: '/dashboard',
          }, pool);
        }
      } catch (e) {
        console.error('[CIERRE ERM/PUSH]', e.message);
      }
    });

    res.json({
      ok: true,
      resumen: {
        caja_apertura: parseFloat(t.caja_apertura),
        total_ventas: totalVentas,
        total_mp: totalMP,
        total_egresos: totalEgresos,
        efectivo_esperado: Math.round(efectivoEsperado),
        caja_cierre: parseFloat(caja_cierre),
        brecha: Math.round(brecha),
        brecha_porcentaje: Math.round(Math.abs(brechaPorc) * 10) / 10,
        estado,
        mensaje: Math.abs(brecha) < 50
          ? 'Caja perfecta. Todo cuadra.'
          : brecha > 0
            ? `Falta $${Math.round(brecha).toLocaleString('es-AR')} en la caja.`
            : `Hay $${Math.round(Math.abs(brecha)).toLocaleString('es-AR')} de más en la caja.`
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Historial de turnos (para el dueño) ────────────────────────────────────

// GET /api/caja/historial/:usuario_id
router.get('/historial/:usuario_id', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const result = await pool.query(
      `SELECT id, nombre_empleado, tipo_turno, caja_apertura, caja_cierre, caja_esperada, brecha,
              hora_apertura, hora_cierre, estado,
              conteo_aleatorio_omitido, conteo_aleatorio2_omitido
       FROM turnos_caja WHERE usuario_id=$1
       ORDER BY hora_apertura DESC LIMIT $2`,
      [req.params.usuario_id, limit]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Z-score contextual ──────────────────────────────────────────────────────

// GET /api/caja/contexto-turno/:turno_id — z-score + contexto temporal de un turno cerrado
router.get('/contexto-turno/:turno_id', async (req, res) => {
  try {
    const resultado = await analizarTurnoConContexto(parseInt(req.params.turno_id));
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/caja/ranking/:tipo_turno — ranking empleados dentro del mismo turno
router.get('/ranking/:tipo_turno', auth, async (req, res) => {
  try {
    const { tipo_turno } = req.params;
    const dias = parseInt(req.query.dias) || 30;
    const negocio_id = req.user.negocio_id;
    const resultado = await rankingEmpleadosTurno(negocio_id, tipo_turno, dias);
    if (!resultado) return res.json({ mensaje: 'Menos de 2 empleados con datos suficientes' });
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/caja/contexto-activo/:tipo_turno — contexto del turno en curso
router.get('/contexto-activo/:tipo_turno', auth, async (req, res) => {
  try {
    const { tipo_turno } = req.params;
    const negocio_id = req.user.negocio_id;
    const resultado = await contextTurnoActivo(negocio_id, tipo_turno);
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/caja/comportamiento/:empleado/:tipo_turno — titular vs peers
router.get('/comportamiento/:empleado/:tipo_turno', auth, async (req, res) => {
  try {
    const { empleado, tipo_turno } = req.params;
    const negocio_id = req.user.negocio_id;
    const resultado = await detectarCambioComportamiento(negocio_id, empleado, tipo_turno);
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Motor de cruce de variables ────────────────────────────────────────────

// GET /api/caja/cruce/:turno_id — análisis cruzado de un turno cerrado
router.get('/cruce/:turno_id', async (req, res) => {
  try {
    const resultado = await analizarCruceTurno(parseInt(req.params.turno_id));
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/caja/goteo?dias=21 — detección de goteo (brechas acumuladas)
router.get('/goteo', auth, async (req, res) => {
  try {
    const dias = parseInt(req.query.dias) || 21;
    const resultado = await detectarGoteo(req.user.negocio_id, dias);
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/caja/patrones?limite=30 — resumen histórico de patrones
router.get('/patrones', auth, async (req, res) => {
  try {
    const limite = parseInt(req.query.limite) || 30;
    const resultado = await resumenPatronesNegocio(req.user.negocio_id, limite);
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Fix 3+4: Confirmar gasto inesperado ────────────────────────────────────
// Marca el turno y excluye su brecha del ERM y del baseline futuro.

// POST /api/caja/gasto-inesperado
router.post('/gasto-inesperado', async (req, res) => {
  try {
    const { turno_id, usuario_id } = req.body;
    if (!turno_id || !usuario_id) {
      return res.status(400).json({ error: 'turno_id y usuario_id requeridos' });
    }
    const r = await pool.query(
      `UPDATE turnos_caja SET gasto_inesperado=true
       WHERE id=$1 AND usuario_id=$2 AND estado='cerrado'
       RETURNING id, nombre_empleado, brecha`,
      [turno_id, usuario_id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Turno no encontrado' });
    res.json({ ok: true, turno: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
