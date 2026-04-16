const ACCIONES = {
  TICKET_BAJO: 'Cruzar el total registrado del turno con el arqueo de caja. Verificar que todas las operaciones estén asentadas en el sistema.',
  TICKET_ALTO: 'Confirmar si el incremento responde a un evento especial o promoción. Si el patrón se repite, revisar la configuración de precios.',
  METRICA_BAJA_ticket_promedio: 'Comparar el ticket promedio del período con el historial del turno. Verificar si se aplicaron descuentos no autorizados.',
  METRICA_ALTA_ticket_promedio: 'Verificar que el alza refleje precios actualizados. Si hay discrepancias, revisar el proceso de registro.',
  METRICA_BAJA_ventas_por_turno: 'Cruzar el total del turno con el dinero en caja. Verificar si existen operaciones no registradas.',
  METRICA_ALTA_ventas_por_turno: 'Confirmar que el volumen corresponde a actividad real. Comparar con el stock consumido en el período.',
  METRICA_BAJA_ratio_efectivo: 'Auditar el arqueo de efectivo del período. Verificar que la clasificación de métodos de pago sea correcta.',
  METRICA_ALTA_ratio_efectivo: 'Revisar la tipificación de pagos electrónicos. Verificar que no exista efectivo sin registrar.',
};

function getAccion(tipo, metrica) {
  if (metrica) return ACCIONES[`${tipo}_${metrica}`] || ACCIONES[tipo] || 'Revisar los registros del turno y comparar con el arqueo de caja.';
  return ACCIONES[tipo] || 'Revisar los registros del turno y comparar con el arqueo de caja.';
}

function generarInsight(alerta) {
  const { tipo, desvio_porcentaje, segmento, turno, confianza } = alerta;
  const partes = segmento ? segmento.split('_') : [];
  const franja = partes[0] || turno || 'el turno';
  const tipoDia = partes[1];
  const quincena = partes[2];

  const franjaTexto = franja === 'MANANA' ? 'turno mañana'
    : franja === 'TARDE' ? 'turno tarde'
    : franja === 'NOCHE' ? 'turno noche'
    : `turno ${franja.toLowerCase()}`;
  const diaTexto = tipoDia === 'FIN_DE_SEMANA' ? 'fin de semana' : 'días de semana';
  const quincenaTexto = quincena === 'ALTA' ? 'quincena alta'
    : quincena === 'MEDIA' ? 'quincena media'
    : quincena ? 'quincena baja' : '';

  let descripcion = '';
  if (tipo === 'TICKET_BAJO') {
    descripcion = `Se detectó una inconsistencia operativa: los montos del ${franjaTexto} están ${Math.abs(desvio_porcentaje)}% por debajo del patrón histórico esperado`;
  } else if (tipo === 'TICKET_ALTO') {
    descripcion = `Se detectó una inconsistencia operativa: los montos del ${franjaTexto} están ${Math.abs(desvio_porcentaje)}% por encima del patrón histórico esperado`;
  } else {
    descripcion = `Inconsistencia operativa detectada en el ${franjaTexto}`;
  }

  if (diaTexto && quincenaTexto) {
    descripcion += ` durante ${diaTexto}, ${quincenaTexto}`;
  } else if (diaTexto) {
    descripcion += ` durante ${diaTexto}`;
  }
  descripcion += '.';

  const contexto = segmento
    ? `Patrón analizado: ${franjaTexto}${quincenaTexto ? ', ' + quincenaTexto : ''}. Comparado contra el historial del mismo segmento.`
    : `Patrón analizado en el ${franjaTexto}. Comparado contra el historial disponible.`;

  const confianzaTexto = `Confianza: ${confianza.nivel} (${confianza.label})`;
  const accion_recomendada = getAccion(tipo);

  return {
    descripcion,
    contexto,
    confianzaTexto,
    accion_recomendada,
    texto_completo: `${descripcion} ${contexto} ${confianzaTexto} → ${accion_recomendada}`
  };
}

function generarInsightMetrica(alerta) {
  const { tipo, metrica, desvio_porcentaje, valor_actual, valor_esperado, capa_origen } = alerta;
  const metricaTexto = metrica === 'ticket_promedio' ? 'ticket promedio'
    : metrica === 'ventas_por_turno' ? 'ventas por turno'
    : metrica === 'ratio_efectivo' ? 'proporción de pagos en efectivo'
    : metrica.replace(/_/g, ' ');

  const direccion = desvio_porcentaje < 0 ? 'por debajo' : 'por encima';
  const referenciaTexto = capa_origen === 'CAPA1_SECTOR' ? 'el benchmark del sector'
    : capa_origen === 'CAPA2_PROPIO' ? 'el historial propio del negocio'
    : 'la referencia combinada del sector e historial propio';

  const descripcion = `Inconsistencia operativa en ${metricaTexto}: el valor actual (${valor_actual}) está ${Math.abs(desvio_porcentaje)}% ${direccion} de ${referenciaTexto} (${valor_esperado}).`;
  const contexto = `Esta señal fue corroborada por al menos dos indicadores simultáneos.`;
  const accion_recomendada = getAccion(tipo, metrica);

  return {
    descripcion,
    contexto,
    accion_recomendada,
    texto_completo: `${descripcion} ${contexto} → ${accion_recomendada}`
  };
}

module.exports = { generarInsight, generarInsightMetrica };
