function generarInsight(alerta) {
  const { tipo, desvio_porcentaje, segmento, empleado, confianza } = alerta;
  const partes = segmento.split('_');
  const franja = partes[0];
  const tipoDia = partes[1];
  const quincena = partes[2];

  const franjaTexto = franja === 'MANANA' ? 'turno manana' : franja === 'TARDE' ? 'turno tarde' : 'turno noche';
  const diaTexto = tipoDia === 'FIN_DE_SEMANA' ? 'fin de semana' : 'dias de semana';
  const quincenaTexto = quincena === 'ALTA' ? 'quincena alta' : quincena === 'MEDIA' ? 'quincena media' : 'quincena baja';

  let descripcion = '';
  if (tipo === 'TICKET_BAJO') {
    descripcion = 'Detectamos tickets ' + Math.abs(desvio_porcentaje) + '% por debajo del promedio en ' + franjaTexto + ', ' + diaTexto + ', ' + quincenaTexto + '.';
  } else {
    descripcion = 'Detectamos tickets ' + Math.abs(desvio_porcentaje) + '% por encima del promedio en ' + franjaTexto + ', ' + diaTexto + ', ' + quincenaTexto + '.';
  }

  if (empleado) {
    descripcion += ' Empleado: ' + empleado + '.';
  }

  const contexto = 'Comparado contra el historial del mismo segmento (' + franjaTexto + ', ' + quincenaTexto + ').';
  const confianzaTexto = 'Confianza: ' + confianza.nivel + ' (' + confianza.label + ')';

  return { descripcion, contexto, confianzaTexto, texto_completo: descripcion + ' ' + contexto + ' ' + confianzaTexto };
}

module.exports = { generarInsight };