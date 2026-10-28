// en_vivo.js — LumoBi · "Tu Negocio en Vivo" (28/10/2026)
//
// Por sucursal, en este momento:
//   - ventas y tickets de HOY (día argentino; la DB está en UTC → se restan 3 h)
//   - lo esperado hasta esta hora = predicción de hoy repartida por hora (perfil del día)
//   - ritmo de la última hora completa vs. lo normal para esa hora
//   - estado: por_encima | en_linea | por_debajo | temprano | antes_de_abrir | cerrado | sin_prediccion
//   - turno abierto (tipo y desde qué hora). Nunca nombres.
// La tolerancia usa el rango del modelo y crece cuando falta mucho día (al principio del día
// hay poca muestra y no se alarma por diferencias chicas).

const pool = require('./db');
const { calcularPrediccion } = require('./prediccion_adaptativa');

const FL = `(fecha - INTERVAL '3 hours')`;
const CACHE = new Map();

function limpiarNombre(n) { return String(n || '').replace(/["']/g, '').trim(); }
function r0(n) { return Math.round(n); }

function ahoraAR(opciones) {
  // opciones.ahora (solo para pruebas): { fecha: 'YYYY-MM-DD', hora: 15, minuto: 30 }
  if (opciones?.ahora) return opciones.ahora;
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  return { fecha: d.toISOString().slice(0, 10), hora: d.getUTCHours(), minuto: d.getUTCMinutes() };
}

async function negocioEnVivo(negocioId, sucursalId = null, db = pool, opciones = {}) {
  const ahora = ahoraAR(opciones);
  const sRes = await db.query(
    `SELECT id, nombre FROM mis_sucursales
     WHERE negocio_id = $1 AND COALESCE(activo, true) = true
       AND ($2::integer IS NULL OR id = $2)
     ORDER BY id`,
    [negocioId, sucursalId]
  );
  if (!sRes.rows.length) return { ahora, sucursales: [], total: null };

  // Ventas de hoy por sucursal y hora
  const vRes = await db.query(
    `SELECT sucursal_id, EXTRACT(HOUR FROM ${FL})::int AS h, COUNT(*)::int AS tickets, SUM(monto)::float AS total
     FROM transacciones
     WHERE negocio_id = $1 AND ${FL}::date = $2::date
       AND ($3::integer IS NULL OR sucursal_id = $3)
     GROUP BY 1, 2`,
    [negocioId, ahora.fecha, sucursalId]
  );

  // Turnos abiertos
  const tRes = await db.query(
    `SELECT sucursal_id, tipo_turno, EXTRACT(HOUR FROM hora_apertura - INTERVAL '3 hours')::int AS desde
     FROM turnos_caja
     WHERE negocio_id = $1 AND estado = 'activo' AND ($2::integer IS NULL OR sucursal_id = $2)
     ORDER BY hora_apertura DESC`,
    [negocioId, sucursalId]
  );

  const fraccion = ahora.minuto / 60;
  const filas = [];
  for (const s of sRes.rows) {
    // Con hora simulada (pruebas) se ignoran las ventas posteriores a esa hora.
    const vs = vRes.rows.filter(v => v.sucursal_id === s.id && (!opciones.ahora || v.h <= ahora.hora));
    const ventas = vs.reduce((a, v) => a + v.total, 0);
    const tickets = vs.reduce((a, v) => a + v.tickets, 0);
    const turno = tRes.rows.find(t => t.sucursal_id === s.id);
    const fila = {
      sucursal_id: s.id,
      nombre: limpiarNombre(s.nombre),
      ventas: r0(ventas),
      tickets,
      turno_activo: turno ? { tipo: turno.tipo_turno === 'manana' ? 'mañana' : turno.tipo_turno, desde: turno.desde } : null,
    };

    // La predicción de hoy no cambia minuto a minuto: se cachea 15 min por sucursal
    // (el Home refresca cada minuto y cada cálculo consulta el pronóstico del clima).
    const kc = `${negocioId}|${s.id}|${ahora.fecha}`;
    let pred = !opciones.sinCache && CACHE.get(kc)?.exp > Date.now() ? CACHE.get(kc).pred : null;
    if (!pred) {
      try {
        pred = await calcularPrediccion(negocioId, s.id, db, null, { ...opciones, incluirHoy: true, guardar: false });
      } catch (e) {
        pred = { disponible: false };
      }
      CACHE.set(kc, { pred, exp: Date.now() + 15 * 60 * 1000 });
    }
    const hoy = pred.disponible ? pred.predicciones.find(p => p.fecha_target === ahora.fecha) : null;
    const porHora = hoy?.franjas?.por_hora || [];
    if (!hoy || !porHora.length) {
      // Sucursal sin historia suficiente: se muestra lo vendido, sin juicio.
      filas.push({ ...fila, estado: 'sin_prediccion' });
      continue;
    }

    const esperadoDia = hoy.valor_predicho;
    const esp = Object.fromEntries(porHora.map(x => [x.hora, x.esperado]));
    const primera = Math.min(...porHora.map(x => x.hora));
    const ultima = Math.max(...porHora.map(x => x.hora));
    let esperadoHasta = 0;
    for (const x of porHora) {
      if (x.hora < ahora.hora) esperadoHasta += x.esperado;
      else if (x.hora === ahora.hora) esperadoHasta += x.esperado * fraccion;
    }
    const fraccionDia = esperadoDia > 0 ? esperadoHasta / esperadoDia : 0;

    // Última hora completa
    const hPrev = ahora.hora - 1;
    const ultimaHora = esp[hPrev] != null
      ? { hora: hPrev, real: r0(vs.find(v => v.h === hPrev)?.total || 0), esperado: r0(esp[hPrev]) }
      : null;

    // Tolerancia: rango del modelo (≈80%), ensanchada al principio del día
    const relRango = hoy.rango_min ? 1 - hoy.rango_min / esperadoDia : 0.15;
    const tol = Math.min(0.5, Math.max(0.12, relRango) / Math.sqrt(Math.max(fraccionDia, 0.05)));
    const dif = esperadoHasta > 0 ? (ventas - esperadoHasta) / esperadoHasta : null;

    let estado;
    if (ahora.hora < primera) estado = 'antes_de_abrir';
    else if (ahora.hora > ultima) estado = 'cerrado';
    else if (fraccionDia < 0.10) estado = 'temprano';
    else if (dif > tol) estado = 'por_encima';
    else if (dif < -tol) estado = 'por_debajo';
    else estado = 'en_linea';

    // Al cerrar se compara contra el día entero
    const difDia = esperadoDia > 0 ? (ventas - esperadoDia) / esperadoDia : null;

    filas.push({
      ...fila,
      estado,
      esperado_hasta_ahora: r0(esperadoHasta),
      esperado_dia: r0(esperadoDia),
      dif_pct: estado === 'cerrado' ? (difDia != null ? Math.round(difDia * 100) : null) : (dif != null ? Math.round(dif * 100) : null),
      tolerancia_pct: Math.round(tol * 100),
      avance_dia_pct: Math.round(fraccionDia * 100),
      ultima_hora: ultimaHora,
      horario: { desde: primera, hasta: ultima + 1 },
    });
  }

  const conPred = filas.filter(f => f.esperado_dia != null);
  const total = {
    ventas: r0(filas.reduce((a, f) => a + f.ventas, 0)),
    tickets: filas.reduce((a, f) => a + f.tickets, 0),
    esperado_hasta_ahora: conPred.length ? r0(conPred.reduce((a, f) => a + f.esperado_hasta_ahora, 0)) : null,
    esperado_dia: conPred.length ? r0(conPred.reduce((a, f) => a + f.esperado_dia, 0)) : null,
  };
  return { ahora, sucursales: filas, total };
}

module.exports = { negocioEnVivo };
