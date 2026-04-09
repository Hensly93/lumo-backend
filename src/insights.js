// insights.js — Lumo v2.0
// Generador de lenguaje natural para alertas.
// T2-06 resuelto: nunca se nombra al empleado, siempre el turno o patrón.
// Regla inamovible: nunca decir "fraude", siempre "inconsistencia operativa".

const MENSAJES_METRICA = {
  ticket_promedio: {
    alto: "El ticket promedio del turno estuvo por encima de lo habitual.",
    bajo: "El ticket promedio del turno estuvo por debajo de lo esperado.",
  },
  ratio_efectivo: {
    alto: "Se registró una proporción de pagos en efectivo más alta que la habitual.",
    bajo: "La proporción de pagos en efectivo fue menor a lo esperado.",
  },
  ventas_por_turno: {
    alto: "El volumen de ventas del turno superó los parámetros normales.",
    bajo: "El volumen de ventas del turno estuvo por debajo de lo esperado.",
  },
};

const ACCIONES_RECOMENDADAS = {
  ticket_promedio_bajo: "Revisá los descuentos aplicados en ese turno y compará con turnos similares.",
  ticket_promedio_alto: "Verificá que los precios aplicados sean los correctos.",
  ratio_efectivo_alto: "Realizá un conteo de caja y comparalo con el total registrado.",
  ratio_efectivo_bajo: "Verificá el funcionamiento de los terminales de pago digital.",
  ventas_por_turno_bajo: "Compará el flujo de clientes con turnos similares del mismo día de la semana.",
  ventas_por_turno_alto: "Confirmá que todas las transacciones fueron registradas correctamente.",
};

const CONTEXTOS_TURNO = {
  manana: "turno mañana",
  tarde: "turno tarde",
  noche: "turno noche",
  sin_turno: "el turno registrado",
};

/**
 * Genera un insight en lenguaje natural para una alerta.
 * Nunca nombra al empleado. Nunca dice "fraude".
 *
 * @param {Array} señales - Array de señales anómalas detectadas
 * @param {string} turno - Identificador del turno
 * @param {string} fecha - Fecha del turno
 * @returns {Object} insight con titulo, descripcion, señales_texto, accion
 */
function generarInsight(señales, turno, fecha) {
  if (!señales || señales.length === 0) {
    return {
      titulo: "Turno sin inconsistencias detectadas",
      descripcion: "El turno operó dentro de los parámetros esperados.",
      señales_texto: [],
      accion: null,
    };
  }

  const nombreTurno = CONTEXTOS_TURNO[turno?.toLowerCase()] || CONTEXTOS_TURNO.sin_turno;
  const fechaFormateada = fecha
    ? new Date(fecha).toLocaleDateString("es-AR", {
        weekday: "long",
        day: "numeric",
        month: "long",
      })
    : "fecha no disponible";

  // Descripción de cada señal
  const señales_texto = señales.map((s) => {
    const mensajes = MENSAJES_METRICA[s.metrica];
    if (!mensajes) return null;
    return mensajes[s.direccion] || mensajes.bajo;
  }).filter(Boolean);

  // Acción recomendada basada en la señal más fuerte
  const señalPrincipal = señales.reduce((prev, curr) =>
    Math.abs(curr.zscore || curr.zscore_deteccion || 0) >
    Math.abs(prev.zscore || prev.zscore_detecci
