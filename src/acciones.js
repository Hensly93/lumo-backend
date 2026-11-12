// acciones.js — qué puede hacer el dueño frente a cada hallazgo de la Radiografía.
// Son recetas fijas por tipo de hallazgo (no las inventa la IA en cada consulta): se adaptan con el día o la hora del hallazgo.
// Siempre son ideas para probar, nunca promesas. Si el dueño elige una, LumoBi mide 28 días después si el problema bajó.
const DIAS = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];

function a(id, tipo, titulo, detalle, arma) { return arma ? { id, tipo, titulo, detalle, arma: true } : { id, tipo, titulo, detalle }; }
const PROMOS = ['promo_franja', 'promo_dia', 'combo_precio', 'descuento_efectivo'];   // acciones que LumoBi arma con los datos del negocio (promo.js)

function receta(detector, clave) {
  const num = Number(String(clave || '').match(/(\d+)$/)?.[1]);
  if (detector === 'dia_debil' && num >= 0 && num <= 6) {
    const d = DIAS[num];
    return [
      a('promo_dia', 'ganar', `LumoBi te arma la promo de los ${d}`, 'Elige el combo con lo que mejor funciona en tu negocio, calcula el precio cuidando tu margen y te deja los textos listos para WhatsApp, Instagram y el cartel.', true),
    ];
  }
  if (detector === 'franja_floja' && num >= 0 && num <= 23) {
    const f = `${num} a ${num + 2} h`;
    return [
      a('promo_franja', 'ganar', `LumoBi te arma la promo de ${f}`, 'Elige el combo con lo que mejor funciona en tu negocio, calcula el precio cuidando tu margen y te deja los textos listos para WhatsApp, Instagram y el cartel.', true),
    ];
  }
  if (detector === 'comisiones_cobro') {
    return [
      a('descuento_efectivo', 'perder_menos', 'LumoBi calcula el descuento por pagar en efectivo o transferencia', 'Mira tu mezcla de cobros y elige el descuento que de verdad te deja plata, descontando lo que regalás a quienes ya pagan en efectivo. Te deja los textos listos.', true),
      a('negociar_tasa', 'perder_menos', 'Pedí una mejor tasa a tu procesador de cobros', 'Preguntá si hay una tasa más baja para tu volumen o si te conviene cobrar con acreditación más lenta.'),
    ];
  }
  if (detector === 'ticket_baja') {
    return [
      a('sugerir_adicional', 'ganar', 'Ofrecé un adicional al cobrar', 'Una frase fija en la caja, como "¿Le sumo una medialuna?". Con un producto chico y de buen margen sube el ticket sin que se note.'),
      a('combo_precio', 'ganar', 'LumoBi te arma un combo para subir el ticket', 'Elige los productos que tus clientes ya compran juntos, calcula el precio cuidando tu margen y te deja los textos listos.', true),
      a('revisar_precios', 'perder_menos', 'Revisá si tus precios siguieron a tus costos', 'Si el ticket bajó y tus costos subieron, el margen se achica por los dos lados.'),
    ];
  }
  if (detector === 'aumentos_proveedor') {
    return [
      a('cotizar', 'perder_menos', 'Pedí precio a otro proveedor', 'Con tu última factura en mano, pedí cotización de los productos que más subieron.'),
      a('negociar', 'perder_menos', 'Negociá con el proveedor actual', 'Preguntá por precio por volumen o por pago al contado en los productos que más subieron.'),
      a('ajustar_precio', 'ganar', 'Subí el precio de lo que más te aumentó', 'Si no lo trasladás, el aumento sale de tu ganancia.'),
    ];
  }
  return [];
}

module.exports = { receta, PROMOS };
