// sesion_empleado.js — LumoBi · sesión segura del empleado (29/10/2026)
//
// Antes, las rutas del empleado se autorizaban con el número de turno (correlativo):
// cualquiera que probara números podía leer o escribir el turno de otro negocio.
// Ahora:
//   - Al validar el PIN o abrir el turno, el servidor genera un token aleatorio
//     (32 bytes) y guarda SOLO su hash en turnos_caja.sesion_token_hash.
//   - authTurno exige el token (header x-turno-token) y deja en req.turno el turno
//     y su negocio. Los turno_id que vengan en la URL o el body se ignoran.
//   - El celular del escáner usa su sesión del QR (header x-scanner-token, uuid de
//     sesiones_scanner con vencimiento), que resuelve al mismo turno.
//   - PIN: 5 intentos fallidos seguidos → bloqueo de 15 minutos para ese empleado.

const crypto = require('crypto');
const pool = require('./db');

const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMPOS = 't.id, t.negocio_id, t.nombre_empleado, t.tipo_turno, t.sucursal_id, t.usuario_id';

async function crearSesionTurno(turnoId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('UPDATE turnos_caja SET sesion_token_hash=$1 WHERE id=$2', [sha256(token), turnoId]);
  return token;
}

async function authTurno(req, res, next) {
  try {
    const tTurno = req.headers['x-turno-token'];
    const tScanner = req.headers['x-scanner-token'];
    let r = null;
    if (tTurno && HEX64.test(tTurno)) {
      r = await pool.query(
        `SELECT ${CAMPOS} FROM turnos_caja t WHERE t.sesion_token_hash=$1 AND t.estado='activo'`,
        [sha256(tTurno)]
      );
    } else if (tScanner && UUID.test(tScanner)) {
      r = await pool.query(
        `SELECT ${CAMPOS} FROM sesiones_scanner s JOIN turnos_caja t ON t.id = s.turno_id
         WHERE s.token=$1 AND s.expira_en > NOW() AND t.estado='activo'`,
        [tScanner]
      );
    }
    if (!r || r.rows.length === 0) {
      return res.status(401).json({ error: 'Sesión de turno inválida o vencida. Volvé a ingresar con tu PIN.' });
    }
    req.turno = r.rows[0];
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Devuelve los minutos que faltan si el empleado está bloqueado; 0 si puede intentar.
async function verificarBloqueoPin(empleadoId) {
  const r = await pool.query(
    `SELECT CEIL(EXTRACT(EPOCH FROM (pin_bloqueado_hasta - NOW())) / 60)::int AS min
     FROM empleados_negocio WHERE id=$1 AND pin_bloqueado_hasta > NOW()`,
    [empleadoId]
  );
  return r.rows[0]?.min || 0;
}

async function registrarIntentoPin(empleadoId, ok) {
  if (ok) {
    await pool.query('UPDATE empleados_negocio SET pin_fallidos=0, pin_bloqueado_hasta=NULL WHERE id=$1', [empleadoId]);
  } else {
    await pool.query(
      `UPDATE empleados_negocio
       SET pin_bloqueado_hasta = CASE WHEN pin_fallidos + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE pin_bloqueado_hasta END,
           pin_fallidos        = CASE WHEN pin_fallidos + 1 >= 5 THEN 0 ELSE pin_fallidos + 1 END
       WHERE id=$1`,
      [empleadoId]
    );
  }
}

module.exports = { authTurno, crearSesionTurno, verificarBloqueoPin, registrarIntentoPin };
