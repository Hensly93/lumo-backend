// predicciones.js — Lumo S7
// Objetivos 4 + 5: Expected Revenue Model + Motor de predicciones
//
// Proyección facturación = promedio 3 meses × factor estacionalidad × factor quincena × factor clima
// Proyección pérdida     = brecha promedio × turnos restantes del mes × factor tendencia
//
// Reglas de confianza por días de datos:
//   < 30 días → sin predicciones
//   30-59     → confianza baja  (30-50%)
//   60-89     → confianza media (50-75%)
//   90+       → confianza alta  (75-95%)
//
// Siempre muestra rango [min, esperado, max] — nunca un número único.
// La predicción siempre dispara una recomendación de acción concreta.

const pool = require('./db');
const { getContextoTemporal, fetchClima, factoresAjuste } = require('./zscore_contextual');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function redondear(n) { return Math.round(n); }

function nivelConfianza(diasDatos) {
  if (diasDatos < 30) return { nivel: 'insuficiente', pct: 0, label: 'Menos de 30 días de datos' };
  if (diasDatos < 60) return { nivel: 'baja', pct: Math.round(30 + (diasDatos - 30) * 0.67), label: `${diasDatos} días de datos` };
  if (diasDatos < 90) return { nivel: 'media', pct: Math.round(50 + (diasDatos - 60) * 0.83), label: `${diasDatos} días de datos` };
  return { nivel: 'alta', pct: Math.min(95, Math.round(75 + (diasDatos - 90) * 0.22)), label: `${diasDatos}+ días de datos` };
}

function rango(esperado, variacion = 0.20) {
  return {
    min: redondear(esperado * (1 - variacion)),
    esperado: redondear(esperado),
    max: redondear(esperado * (1 + variacion)),
  };
}

function diasRestantesMes() {
  const hoy = new Date();
  const ultimoDia = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
  return ultimoDia - hoy.getDate();
}

function turnosRestantesMes(turnos_por_dia = 3) {
  return diasRestantesMes() * turnos_por_dia;
}

// ─── Proyección de facturación ────────────────────────────────────────────────

async function proyectarFacturacion(usuarioId, sucursalId = null) {
  const ctx = getContextoTemporal(new Date());
  const clima = await fetchClima(ctx.fecha_str, null, null, null);
  const { factor } = factoresAjuste(ctx, clima);

  const res = await pool.query(
    `SELECT DATE(fecha) as dia, SUM(monto) as total_dia
     FROM transacciones
     WHERE usuario_id=$1 AND fecha >= NOW() - INTERVAL '90 days'
       AND ($2::integer IS NULL OR sucursal_id = $2)
     GROUP BY DATE(fecha)
     ORDER BY dia ASC`,
    [usuarioId, sucursalId]
  );

  const diasConDatos = res.rows.length;
  const confianza = nivelConfianza(diasConDatos);
  if (confianza.nivel === 'insuficiente') {
    return { disponible: false, motivo: 'datos_insuficientes', dias_datos: diasConDatos, minimo_requerido: 30 };
  }

  const totalesDiarios = res.rows.map(r => parseFloat(r.total_dia));
  const promedioGeneral = totalesDiarios.reduce((a, b) => a + b, 0) / totalesDiarios.length;

  // Promedio últimos 7 días vs 30 días → factor tendencia
  const ultimos7 = totalesDiarios.slice(-7);
  const ultimos30 = totalesDiarios.slice(-30);
  const prom7 = ultimos7.reduce((a, b) => a + b, 0) / ultimos7.length;
  const prom30 = ultimos30.reduce((a, b) => a + b, 0) / (ultimos30.length || 1);
  const factorTendencia = prom30 > 0 ? Math.min(Math.max(prom7 / prom30, 0.5), 2.0) : 1.0;

  // Factor estacionalidad por quincena
  const ventasQ1 = res.rows.filter(r => new Date(r.dia).getDate() <= 15).map(r => parseFloat(r.total_dia));
  const ventasQ2 = res.rows.filter(r => new Date(r.dia).getDate() > 15).map(r => parseFloat(r.total_dia));
  const promQ1 = ventasQ1.length ? ventasQ1.reduce((a, b) => a + b, 0) / ventasQ1.length : promedioGeneral;
  const promQ2 = ventasQ2.length ? ventasQ2.reduce((a, b) => a + b, 0) / ventasQ2.length : promedioGeneral;
  const factorQuincena = ctx.quincena === 1 ? (promQ1 / promedioGeneral || 1.0) : (promQ2 / promedioGeneral || 1.0);

  // Proyección del mes
  const diasRest = diasRestantesMes();
  const ventaDiariaEsperada = promedioGeneral * factorTendencia * factorQuincena * factor;
  const proyeccionResto = ventaDiariaEsperada * diasRest;

  // Ventas acumuladas este mes
  const acumRes = await pool.query(
    `SELECT COALESCE(SUM(monto),0) as total
     FROM transacciones
     WHERE usuario_id=$1 AND DATE_TRUNC('month', fecha) = DATE_TRUNC('month', NOW())
       AND ($2::integer IS NULL OR sucursal_id = $2)`,
    [usuarioId, sucursalId]
  );
  const ventasMesActual = parseFloat(acumRes.rows[0].total);
  const proyeccionMesCompleto = ventasMesActual + proyeccionResto;

  // Variación: mayor incertidumbre con menos datos
  const variacion = confianza.nivel === 'baja' ? 0.30 : confianza.nivel === 'media' ? 0.20 : 0.12;

  return {
    disponible: true,
    tipo: 'facturacion',
    periodo: 'mes_actual',
    dias_datos: diasConDatos,
    confianza,
    ventas_acumuladas_mes: redondear(ventasMesActual),
    dias_restantes_mes: diasRest,
    venta_diaria_esperada: redondear(ventaDiariaEsperada),
    proyeccion_resto_mes: rango(proyeccionResto, variacion),
    proyeccion_mes_completo: rango(proyeccionMesCompleto, variacion * 0.5),
    factores_aplicados: {
      tendencia: Math.round(factorTendencia * 100) / 100,
      quincena: Math.round(factorQuincena * 100) / 100,
      contexto: factor,
      clima,
    },
    etiqueta: 'estimado',
    accion: proyeccionMesCompleto < prom30 * 30 * 0.9
      ? 'Las ventas proyectadas están por debajo del promedio. Evaluá activar alguna promoción esta semana.'
      : 'Proyección dentro del rango esperado. Mantener el seguimiento habitual.',
  };
}

// ─── Proyección de pérdidas ────────────────────────────────────────────────────

async function proyectarPerdidas(usuarioId, sucursalId = null) {
  const res = await pool.query(
    `SELECT brecha, hora_apertura, tipo_turno
     FROM turnos_caja
     WHERE usuario_id=$1 AND estado='cerrado' AND brecha IS NOT NULL
       AND hora_apertura >= NOW() - INTERVAL '60 days'
       AND ($2::integer IS NULL OR sucursal_id = $2)
     ORDER BY hora_apertura ASC`,
    [usuarioId, sucursalId]
  );

  const turnosCerrados = res.rows;
  if (turnosCerrados.length < 5) {
    return { disponible: false, motivo: 'datos_insuficientes', turnos_analizados: turnosCerrados.length, minimo_requerido: 5 };
  }

  const brechas = turnosCerrados.map(t => Math.abs(parseFloat(t.brecha)));
  const brechaPromedio = brechas.reduce((a, b) => a + b, 0) / brechas.length;

  // Factor tendencia: ¿la brecha está aumentando?
  const mitad = Math.floor(brechas.length / 2);
  const promPrimera = brechas.slice(0, mitad).reduce((a, b) => a + b, 0) / mitad;
  const promSegunda = brechas.slice(mitad).reduce((a, b) => a + b, 0) / (brechas.length - mitad);
  const factorTendencia = promPrimera > 0 ? promSegunda / promPrimera : 1.0;
  const tendencia = factorTendencia > 1.1 ? 'creciente' : factorTendencia < 0.9 ? 'decreciente' : 'estable';

  // Turnos por día (promedio)
  const diasUnicos = new Set(turnosCerrados.map(t => new Date(t.hora_apertura).toISOString().slice(0, 10))).size;
  const turnosPorDia = diasUnicos > 0 ? turnosCerrados.length / diasUnicos : 3;

  const turnosRest = Math.round(turnosRestantesMes(turnosPorDia));
  const perdidaEsperada = brechaPromedio * factorTendencia * turnosRest;

  const diasDatos = Math.round((Date.now() - new Date(turnosCerrados[0].hora_apertura).getTime()) / (1000 * 60 * 60 * 24));
  const confianza = nivelConfianza(diasDatos);

  // Pérdida acumulada este mes
  const acumRes = await pool.query(
    `SELECT COALESCE(SUM(ABS(brecha)),0) as total
     FROM turnos_caja
     WHERE usuario_id=$1 AND estado='cerrado' AND brecha IS NOT NULL
       AND DATE_TRUNC('month', hora_apertura) = DATE_TRUNC('month', NOW())
       AND ($2::integer IS NULL OR sucursal_id = $2)`,
    [usuarioId, sucursalId]
  );
  const perdidaMesActual = parseFloat(acumRes.rows[0].total);

  const variacion = confianza.nivel === 'baja' ? 0.40 : confianza.nivel === 'media' ? 0.25 : 0.15;

  return {
    disponible: true,
    tipo: 'perdidas',
    periodo: 'mes_actual',
    turnos_analizados: turnosCerrados.length,
    dias_datos: diasDatos,
    confianza,
    perdida_acumulada_mes: redondear(perdidaMesActual),
    brecha_promedio_por_turno: redondear(brechaPromedio),
    turnos_restantes_mes: turnosRest,
    tendencia,
    factor_tendencia: Math.round(factorTendencia * 100) / 100,
    proyeccion_perdida_resto_mes: rango(perdidaEsperada, variacion),
    proyeccion_perdida_mes_completo: rango(perdidaMesActual + perdidaEsperada, variacion * 0.5),
    etiqueta: 'estimado conservador',
    accion: tendencia === 'creciente'
      ? `La brecha de caja creció ${Math.round((factorTendencia - 1) * 100)}% en el último período. Priorizá revisar los turnos con mayor desvío antes de fin de mes.`
      : tendencia === 'estable' && brechaPromedio > 1000
        ? `Brecha promedio de $${redondear(brechaPromedio).toLocaleString('es-AR')} por turno. Considerá revisar el proceso de cierre con el equipo.`
        : 'Las brechas están dentro del rango normal. Mantener el control habitual.',
  };
}

// ─── Predicción completa (combina facturación + pérdidas) ────────────────────

async function generarPrediccionCompleta(usuarioId, sucursalId = null) {
  const [facturacion, perdidas] = await Promise.all([
    proyectarFacturacion(usuarioId, sucursalId).catch(e => ({ disponible: false, error: e.message })),
    proyectarPerdidas(usuarioId, sucursalId).catch(e => ({ disponible: false, error: e.message })),
  ]);

  // Resumen ejecutivo para la pantalla Home del dueño
  let resumen = null;
  if (facturacion.disponible && perdidas.disponible) {
    const facturacionEsp = facturacion.proyeccion_mes_completo.esperado;
    const perdidaEsp = perdidas.proyeccion_perdida_mes_completo.esperado;
    const pctPerdida = facturacionEsp > 0 ? (perdidaEsp / facturacionEsp) * 100 : 0;

    resumen = {
      facturacion_esperada_mes: facturacion.proyeccion_mes_completo,
      perdida_esperada_mes: perdidas.proyeccion_perdida_mes_completo,
      porcentaje_perdida: Math.round(pctPerdida * 10) / 10,
      semaforo: pctPerdida > 5 ? 'rojo' : pctPerdida > 2 ? 'amarillo' : 'verde',
      accion_prioritaria: perdidas.tendencia === 'creciente' ? perdidas.accion : facturacion.accion,
    };
  }

  return {
    facturacion,
    perdidas,
    resumen,
  };
}

module.exports = { proyectarFacturacion, proyectarPerdidas, generarPrediccionCompleta };
