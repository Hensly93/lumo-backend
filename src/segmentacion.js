const QUINCENA_ALTA = [1,2,3,4,5,6,7,8,9,10];
const QUINCENA_MEDIA = [11,12,13,14,15,16,17,18];
const FERIADOS = ['01-01','24-03','02-04','01-05','25-05','20-06','09-07','17-08','12-10','20-11','08-12','25-12'];
function getSegmento(fecha) {
  const d = new Date(fecha);
  const dia = d.getDate();
  const mes = d.getMonth();
  const hora = d.getHours();
  const diaSemana = d.getDay();
  const fechaStr = String(d.getMonth()+1).padStart(2,'0') + '-' + String(dia).padStart(2,'0');
  let quincena = 'BAJA';
  if (QUINCENA_ALTA.includes(dia)) quincena = 'ALTA';
  else if (QUINCENA_MEDIA.includes(dia)) quincena = 'MEDIA';
  let franja = 'NOCHE';
  if (hora >= 6 && hora < 12) franja = 'MANANA';
  else if (hora >= 12 && hora < 18) franja = 'TARDE';
  return { quincena, franja, tipoDia: (diaSemana===0||diaSemana===6) ? 'FIN_DE_SEMANA' : 'SEMANA', aguinaldo: mes===5||mes===11, feriado: FERIADOS.includes(fechaStr), mes: mes+1, dia, hora };
}
module.exports = { getSegmento };