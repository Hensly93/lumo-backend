// acciones.js — qué puede hacer el dueño frente a cada hallazgo de la Radiografía.
// Son recetas fijas por tipo de hallazgo (no las inventa la IA en cada consulta): se adaptan con el día o la hora del hallazgo.
// Siempre son ideas para probar, nunca promesas. Si el dueño elige una, LumoBi mide 28 días después si el problema bajó.
const DIAS = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];

function a(id, tipo, titulo, detalle, arma) { return arma ? { id, tipo, titulo, detalle, arma: true } : { id, tipo, titulo, detalle }; }
const PROMOS = ['promo_franja', 'promo_dia', 'combo_precio', 'descuento_efectivo', 'ajustar_precio', 'corregir_precios'];   // acciones que LumoBi arma con los datos del negocio (promo.js)

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
  if (detector === 'precio_bajo_costo' || detector === 'marca_margen_bajo') {
    return [
      a('corregir_precios', 'perder_menos', 'LumoBi calcula el precio nuevo de los productos con margen flojo', 'Mira tus costos y tus ventas y te dice a cuánto subir cada precio para recuperar margen, de a poco para no espantar clientes. Te deja la lista lista para copiar.', true),
      a('revisar_costos', 'perder_menos', 'Revisá que los costos estén bien cargados', 'Si el costo de un producto está mal cargado (por ejemplo, el de la caja en vez del de la unidad), el sistema ve una pérdida que no existe.'),
    ];
  }
  if (detector === 'equipo_caja') {
    return [
      a('hablar_equipo', 'perder_menos', 'Conversá con la persona, con el detalle en la mano', 'No es una acusación: mostrale los cierres con diferencia y preguntale qué pasó. Muchas veces es un vuelto mal dado o un cobro sin registrar.'),
      a('mas_conteos', 'perder_menos', 'Pedí un conteo de caja a mitad de turno', 'Un control a mitad de turno hace que la diferencia se detecte cuando todavía se puede reconstruir qué pasó.'),
    ];
  }
  if (detector === 'equipo_borrados') {
    return [
      a('revisar_borrados', 'perder_menos', 'Mirá qué productos se sacan del carrito', 'Si son siempre los mismos productos o la misma franja horaria, es una señal. Si están repartidos, probablemente sea escaneo con errores.'),
      a('encargado_autoriza', 'perder_menos', 'Pedí que los borrados grandes los avise un encargado', 'Una regla simple: si se saca un producto caro del carrito, se avisa. Alcanza con que el equipo sepa que queda registrado.'),
    ];
  }
  if (detector === 'equipo_egresos') {
    return [
      a('pedir_comprobante', 'perder_menos', 'Pedí el comprobante de cada egreso', 'Un ticket, una foto o un remito. Si hay proveedores que se pagan siempre de la caja, conviene anotarlos como gasto fijo.'),
    ];
  }
  if (detector === 'equipo_frenadas') {
    return [
      a('revisar_frenadas', 'perder_menos', 'Mirá quién pidió esas acciones y en qué horarios', 'Si se concentran en una persona o en una franja, es la señal más clara. Si están repartidas, probablemente el límite está muy ajustado.'),
      a('hablar_equipo', 'perder_menos', 'Conversá con la persona con el detalle en la mano', 'Mostrale lo que se intentó y preguntale qué pasó. El objetivo es que sepa que queda registrado, no acusar.'),
    ];
  }
  if (detector === 'equipo_precios') {
    return [
      a('revisar_precios_caja', 'perder_menos', 'Revisá los precios que se bajaron y volvelos a poner si hace falta', 'Si el cambio lo autorizaste, ignoralo. Si no, corregilo desde Catálogo.'),
      a('sacar_permiso', 'perder_menos', 'Sacale el permiso de cambiar precios a quien no lo necesite', 'Solo quienes tienen el permiso de cargar productos pueden cambiar precios. Lo manejás desde Equipo.'),
    ];
  }
  if (detector === 'aumentos_proveedor') {
    return [
      a('cotizar', 'perder_menos', 'Pedí precio a otro proveedor', 'Con tu última factura en mano, pedí cotización de los productos que más subieron.'),
      a('negociar', 'perder_menos', 'Negociá con el proveedor actual', 'Preguntá por precio por volumen o por pago al contado en los productos que más subieron.'),
      a('ajustar_precio', 'ganar', 'LumoBi calcula el precio nuevo de cada producto que te aumentaron', 'Toma tus facturas y te dice cuánto subir cada precio para mantener tu margen. Te deja la lista lista para copiar.', true),
    ];
  }
  return [];
}

module.exports = { receta, PROMOS };
