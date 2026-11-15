// "Lo que tenés que mirar hoy" — UNA sola lista para el Inicio y la pantalla Alertas (14/11/2026).
// Antes el Inicio decía "Hoy está todo normal" y Alertas aparecía vacía mientras Fugas mostraba
// "Faltaron $34.993 en la caja": cada pantalla leía de un lado distinto. Ahora junta todo:
//   1. alertas del motor (ventas / gasto por cliente / efectivo fuera de lo normal)
//   2. fugas de caja activas (faltantes que se repiten en un turno)
//   3. personas del equipo con señales (ERM rojo / amarillo)
//   4. inconsistencias de caja de las recomendaciones (si no hay una fuga de caja que ya lo diga)
const { gestionarAlertas } = require('./alert_manager');

function ahora() { return new Date().toISOString(); }

async function itemsRevisar(negocioId, sucursalId, analisis, recs) {
  const base = await gestionarAlertas(negocioId, (analisis && analisis.señales) || []);
  const items = [...(base.alertas || [])];
  const ts = ahora();

  // 2. Fugas de caja
  let fugasCaja = [];
  try {
    const fg = await require('./fugas').calcularFugas(negocioId);
    fugasCaja = (fg.fugas || []).filter((f) => f.categoria === 'caja' && f.estado === 'activa'
      && (!sucursalId || !f.id || f.id.startsWith('caja_' + sucursalId + '_')));
    for (const f of fugasCaja) {
      items.push({
        tipo: 'Plata que falta en la caja', prioridad: f.monto >= 20000 ? 'critico' : 'atencion',
        mensaje: f.titulo + (f.donde ? ' (' + f.donde + ')' : '') + '.',
        accion: (f.como_corregir && f.como_corregir[0]) || 'Mirá cada cierre con diferencia en Fugas.',
        timestamp: ts, datos: { evidencia: (f.evidencia || []).join(' ') }, origen: 'fugas', id: 'fuga:' + f.id, url: '/fugas',
        impacto_estimado: f.monto,
      });
    }
  } catch (e) { console.error('revisar/fugas:', e.message); }

  // 3. Equipo
  try {
    const erm = await require('./erm').calcularERMNegocio(negocioId);
    for (const e of erm.empleados || []) {
      if (e.nivel !== 'rojo' && e.nivel !== 'amarillo') continue;
      items.push({
        tipo: 'Equipo', prioridad: e.nivel === 'rojo' ? 'critico' : 'atencion',
        mensaje: e.nivel === 'rojo'
          ? `Los turnos de ${e.empleado} muestran diferencias de caja que se repiten.`
          : `En los turnos de ${e.empleado} hay algo para mirar en la caja.`,
        accion: 'Mirá el detalle de sus turnos en Equipo antes de hablar con nadie: puede ser un error al contar o al cobrar.',
        timestamp: ts, datos: null, origen: 'equipo', id: 'erm:' + e.empleado, url: '/empleados',
      });
    }
  } catch (e) { console.error('revisar/erm:', e.message); }

  // 3b. Lo que hace cada persona en la caja: anulaciones, descuentos, ventas en espera sin cobrar (ficha.js)
  try {
    const db = require('./db');
    const quienes = (await db.query(
      `SELECT DISTINCT empleado FROM hechos_caja
        WHERE negocio_id = $1 AND empleado IS NOT NULL AND creado >= NOW() - INTERVAL '30 days'
          AND tipo IN ('venta_anulada','descuento','espera_descartada','item_borrado','cantidad_reducida')`, [negocioId])).rows;
    for (const q of quienes.slice(0, 15)) {
      const f = await require('./ficha').fichaEmpleado(negocioId, q.empleado);
      // Las diferencias de caja y los conteos ya llegan por Fugas y Equipo: acá solo lo nuevo de la caja
      const nuevas = ((f && f.senales) || []).filter((x) => !/cierres terminaron|conteo/.test(x));
      if (!nuevas.length) continue;
      items.push({
        tipo: 'Caja', prioridad: 'atencion',
        mensaje: `${q.empleado}: ${nuevas[0].charAt(0).toLowerCase() + nuevas[0].slice(1)}`,
        accion: nuevas.length > 1 ? `Y ${nuevas.length - 1} cosa${nuevas.length > 2 ? 's' : ''} más. Miralo con calma: puede tener una buena razón.` : 'Miralo con calma y preguntá: puede tener una buena razón.',
        timestamp: ts, datos: null, origen: 'caja', id: 'caja:' + q.empleado, url: '/ficha/persona/' + encodeURIComponent(q.empleado),
      });
    }
  } catch (e) { console.error('revisar/caja:', e.message); }

  // 4. Recomendaciones de caja (solo si ninguna fuga de caja ya lo dice)
  if (!fugasCaja.length) {
    for (const r of (recs && recs.recomendaciones) || []) {
      if (r.categoria !== 'inconsistencia_operativa' || !(r.prioridad === 'critica' || r.prioridad === 'alta')) continue;
      items.push({ tipo: 'Caja', prioridad: r.prioridad === 'critica' ? 'critico' : 'atencion', mensaje: r.mensaje, accion: r.accion,
        timestamp: ts, datos: r.datos, origen: 'recomendaciones', id: r.id, url: '/empleados' });
    }
  }

  const PESO = { critico: 0, inconsistencia: 0, atencion: 1, ineficiencia: 1, error_operativo: 1 };
  items.sort((a, b) => (PESO[a.prioridad] ?? 5) - (PESO[b.prioridad] ?? 5));
  const stats = {
    total: items.length,
    criticos: items.filter((a) => ['critico', 'inconsistencia'].includes(a.prioridad)).length,
    atencion: items.filter((a) => ['atencion', 'ineficiencia', 'error_operativo'].includes(a.prioridad)).length,
    positivos: items.filter((a) => ['positivo', 'info'].includes(a.prioridad)).length,
  };
  stats.balance_pct = base.stats ? base.stats.balance_pct : null;
  return { items, suprimidas: base.suprimidas || 0, stats };
}

module.exports = { itemsRevisar };
