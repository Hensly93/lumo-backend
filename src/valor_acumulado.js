// valor_acumulado.js — "Lo que LumoBi ya sabe de tu negocio".
// Hace visible lo que se junta con el tiempo y no se puede copiar: historia conectada, costos y precios, caja, y lo que LumoBi aprendió y midió.
// Todo sale de datos reales del negocio. Si algo todavía no existe, no se inventa: se muestra como "todavía no" y qué hacer para sumarlo.
const pool = require('./db');

const n0 = (x) => Number(x) || 0;
const miles = (x) => Math.round(n0(x)).toLocaleString('es-AR');

async function valorAcumulado(negocioId, db = pool) {
  const q = (sql, args = [negocioId]) => db.query(sql, args).then((r) => r.rows[0] || {}).catch(() => ({}));
  const [v, p, pr, cp, co, pred, resp, rec] = await Promise.all([
    q(`SELECT COUNT(*)::int AS ventas, MIN(fecha) AS desde,
              COALESCE(EXTRACT(DAY FROM (NOW() - MIN(fecha))), 0)::int AS dias,
              COUNT(DISTINCT (fecha - INTERVAL '3 hours')::date)::int AS dias_con_ventas
         FROM transacciones WHERE negocio_id = $1 AND COALESCE(tipo,'venta') = 'venta'`),
    q(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE precio_costo > 0)::int AS con_costo FROM productos WHERE negocio_id = $1 AND COALESCE(activo, true)`),
    q(`SELECT (SELECT COUNT(*) FROM cambios_precios WHERE negocio_id = $1 AND campo = 'precio_venta')::int AS cambios_venta,
              (SELECT COUNT(*) FROM productos_historico_precios WHERE negocio_id = $1)::int AS historico`),
    q(`SELECT COUNT(DISTINCT c.id)::int AS facturas, COUNT(DISTINCT LOWER(TRIM(c.proveedor)))::int AS proveedores,
              (SELECT COUNT(*) FROM (SELECT i.clave FROM compras_items i JOIN compras c2 ON c2.id = i.compra_id WHERE c2.negocio_id = $1 GROUP BY i.clave HAVING COUNT(DISTINCT c2.id) >= 2) z)::int AS productos_con_historia
         FROM compras c WHERE c.negocio_id = $1`),
    q(`SELECT COUNT(*)::int AS turnos, COUNT(*) FILTER (WHERE estado = 'cerrado')::int AS cerrados,
              (SELECT COUNT(*) FROM hechos_caja WHERE negocio_id = $1)::int AS hechos,
              (SELECT COUNT(*) FROM (SELECT nombre_empleado FROM turnos_caja WHERE negocio_id = $1 AND estado = 'cerrado' GROUP BY 1 HAVING COUNT(*) >= 5) z)::int AS personas_conocidas
         FROM turnos_caja WHERE negocio_id = $1`),
    q(`SELECT COUNT(DISTINCT fecha_target::date)::int AS dias FROM predicciones_negocio WHERE negocio_id = $1 AND fecha_target::date < (NOW() - INTERVAL '3 hours')::date`),
    q(`SELECT (SELECT COUNT(*) FROM hallazgos WHERE negocio_id = $1 AND feedback IS NOT NULL)::int
            + (SELECT COUNT(*) FROM alertas_gestionadas WHERE negocio_id = $1 AND feedback_at IS NOT NULL)::int
            + (SELECT COUNT(*) FROM alertas_instante WHERE negocio_id = $1 AND feedback IS NOT NULL)::int AS respondidos`),
    q(`SELECT COUNT(*)::int AS medidos, COALESCE(SUM(recuperado) FILTER (WHERE recuperado > 0), 0)::float AS recuperado,
              COUNT(*) FILTER (WHERE recuperado > 0)::int AS funcionaron FROM hallazgos WHERE negocio_id = $1 AND evaluado_en IS NOT NULL`),
  ]);
  const aj = await require('./precision').precision(negocioId, db).then((x) => x.ajustes.length).catch(() => 0);

  const dias = n0(v.dias);
  const items = [
    { clave: 'historia', titulo: 'Historia de ventas', hecho: n0(v.ventas) > 0,
      dato: n0(v.ventas) ? `${miles(v.ventas)} ventas en ${miles(v.dias_con_ventas)} días` : 'Todavía no hay ventas',
      sirve: 'Con ella LumoBi sabe qué es un día normal en tu negocio, y avisa cuando algo se sale.',
      sumar: n0(v.ventas) ? null : 'Cargá o cobrá ventas todos los días.' },
    { clave: 'costos', titulo: 'Costos y márgenes', hecho: n0(p.total) > 0 && n0(p.con_costo) / n0(p.total) >= 0.5,
      dato: n0(p.total) ? `${miles(p.con_costo)} de ${miles(p.total)} productos con costo cargado` : 'Todavía no hay productos',
      sirve: 'Sabe cuánto te deja cada producto y avisa si vendés algo por debajo de lo que te cuesta.',
      sumar: n0(p.total) > n0(p.con_costo) ? 'Cargá el costo de los productos que faltan.' : null },
    { clave: 'precios', titulo: 'Historia de precios y proveedores', hecho: n0(cp.facturas) >= 2,
      dato: [n0(cp.facturas) ? `${miles(cp.facturas)} facturas de ${miles(cp.proveedores)} ${n0(cp.proveedores) === 1 ? 'proveedor' : 'proveedores'}` : null,
             n0(cp.productos_con_historia) ? `${miles(cp.productos_con_historia)} productos con su historia de costos` : null,
             n0(pr.cambios_venta) + n0(pr.historico) ? `${miles(n0(pr.cambios_venta) + n0(pr.historico))} cambios de precio de venta` : null].filter(Boolean).join(' · ') || 'Todavía no hay facturas',
      sirve: 'Detecta cuánto te subió cada proveedor y cuánta ganancia te saca la suba. Esa historia solo se arma con el tiempo.',
      sumar: n0(cp.facturas) ? null : 'Subí tus facturas de compra.' },
    { clave: 'caja', titulo: 'Caja y equipo', hecho: n0(co.cerrados) >= 5,
      dato: n0(co.turnos) ? `${miles(co.cerrados)} turnos cerrados${n0(co.hechos) ? ` · ${miles(co.hechos)} movimientos de caja registrados` : ''}${n0(co.personas_conocidas) ? ` · ${miles(co.personas_conocidas)} ${n0(co.personas_conocidas) === 1 ? 'persona' : 'personas'} con su forma de trabajar conocida` : ''}` : 'Todavía no se usó la caja',
      sirve: 'Compara a cada persona con ella misma y con el equipo, y encuentra dónde se pierde plata en la caja.',
      sumar: n0(co.turnos) ? null : 'Que el equipo cobre desde la caja de LumoBi.' },
    { clave: 'aprendizaje', titulo: 'Lo que aprendió de vos', hecho: n0(pred.dias) >= 3 || n0(resp.respondidos) > 0,
      dato: [n0(pred.dias) ? `${miles(pred.dias)} ${n0(pred.dias) === 1 ? 'día' : 'días'} de predicciones comparadas con lo que vendiste` : null,
             n0(resp.respondidos) ? `${miles(resp.respondidos)} ${n0(resp.respondidos) === 1 ? 'aviso que respondiste' : 'avisos que respondiste'}` : null,
             aj ? `${aj} ${aj === 1 ? 'aviso ajustado' : 'avisos ajustados'} a tu gusto` : null].filter(Boolean).join(' · ') || 'Todavía no hay',
      sirve: 'Cada semana acierta más en tu negocio y te avisa solo lo que te importa.',
      sumar: n0(resp.respondidos) ? null : 'Respondé "me sirvió" o "no era nada" en los avisos.' },
    { clave: 'resultados', titulo: 'Consejos medidos', hecho: n0(rec.medidos) > 0,
      dato: n0(rec.medidos) ? `${miles(rec.medidos)} ${n0(rec.medidos) === 1 ? 'consejo medido' : 'consejos medidos'}${n0(rec.recuperado) > 0 ? ` · $${miles(rec.recuperado)} recuperados por mes` : ''}` : 'Todavía no probaste consejos',
      sirve: 'Sabe qué le funciona a tu negocio y qué no, y deja de insistir con lo que no.',
      sumar: n0(rec.medidos) ? null : 'Probá un consejo desde Oportunidades: a los 28 días se mide.' },
  ];
  const hechos = items.filter((x) => x.hecho).length;
  const etapa = dias < 14 ? 'Recién empezando a conocerte' : dias < 60 ? 'Ya conoce tus semanas' : dias < 180 ? 'Conoce tus meses y tus temporadas' : 'Conoce tu negocio de punta a punta';
  const frase = n0(v.ventas)
    ? `LumoBi te conoce hace ${dias <= 1 ? 'un día' : dias + ' días'}. ${etapa}.`
    : 'Cuando empieces a vender, LumoBi empieza a conocer tu negocio.';
  return {
    dias, etapa, frase, hechos, total: items.length, items,
    aviso: 'Tus datos son tuyos: descargalos cuando quieras (Excel). Lo que no se puede llevar es lo que LumoBi aprendió con ellos.',
  };
}

module.exports = { valorAcumulado };
