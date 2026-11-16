// resumen_mensual.js — "Lo que LumoBi hizo por tu negocio este mes".
// Separa con honestidad DOS cosas que no se suman:
//   · RECUPERADO: plata que dejó de irse porque el dueño probó un consejo y se MIDIÓ que el problema bajó (hallazgos medidos a los 28 días).
//   · DETECTÓ: plata en juego que LumoBi encontró (faltantes de caja, subas de proveedores, avisos en el momento). No es plata ganada: es plata que se veía.
// Mes calendario de Argentina. El mes en curso se marca como parcial.
const pool = require('./db');
const CF = require('./caja_faltante');

const $ = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
const n0 = (x) => Number(x) || 0;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const plural = (n, u, p) => `${n} ${n === 1 ? u : p}`;

const hoyAR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7);
function sumarMes(mes, d) { const [a, m] = mes.split('-').map(Number); const x = new Date(Date.UTC(a, m - 1 + d, 1)); return x.toISOString().slice(0, 7); }
const etiqueta = (mes) => { const [a, m] = mes.split('-').map(Number); return `${MESES[m - 1]} ${a}`; };

async function resumenMensual(negocioId, mesPedido, db = pool) {
  const actual = hoyAR();
  const mes = /^\d{4}-(0[1-9]|1[0-2])$/.test(mesPedido || '') && mesPedido <= actual ? mesPedido : actual;
  const desde = mes + '-01';
  const q = (sql, args = []) => db.query(sql, [negocioId, desde, ...args]).then((r) => r.rows[0] || {}).catch(() => ({}));
  const AR = (col) => `(${col} - INTERVAL '3 hours')`;
  const enMes = (col) => `${AR(col)} >= $2::date AND ${AR(col)} < ($2::date + INTERVAL '1 month')`;

  const [ventas, caja, hechos, inst, consejo, medidos, prov] = await Promise.all([
    q(`SELECT COALESCE(SUM(monto),0)::float AS total, COUNT(*)::int AS n FROM transacciones WHERE negocio_id = $1 AND COALESCE(tipo,'venta') = 'venta' AND ${enMes('fecha')}`),
    q(`SELECT COUNT(*) FILTER (WHERE estado = 'cerrado')::int AS cerrados,
              COALESCE(SUM(${CF.sqlFaltante()}) FILTER (WHERE estado = 'cerrado'), 0)::float AS faltante,
              COUNT(*) FILTER (WHERE estado = 'cerrado' AND ${CF.sqlFaltante()} > 0)::int AS con_falta
         FROM turnos_caja WHERE negocio_id = $1 AND ${enMes('hora_apertura')}`),
    q(`SELECT COUNT(*) FILTER (WHERE tipo = 'venta_anulada')::int AS anuladas, COALESCE(SUM(valor) FILTER (WHERE tipo = 'venta_anulada'),0)::float AS anuladas_plata,
              COUNT(*) FILTER (WHERE tipo = 'descuento')::int AS descuentos, COALESCE(SUM(valor) FILTER (WHERE tipo = 'descuento'),0)::float AS descuentos_plata
         FROM hechos_caja WHERE negocio_id = $1 AND ${enMes('creado')}`),
    q(`SELECT COUNT(*)::int AS avisos, COUNT(*) FILTER (WHERE feedback = 'util')::int AS utiles FROM alertas_instante WHERE negocio_id = $1 AND ${enMes('creado')}`),
    q(`SELECT COUNT(DISTINCT producto_id) FILTER (WHERE campo = 'precio_venta')::int AS precios, COUNT(*) FILTER (WHERE campo = 'producto_creado')::int AS combos
         FROM cambios_precios WHERE negocio_id = $1 AND origen = 'consejo' AND ${enMes('creado')}`),
    db.query(`SELECT titulo, accion_titulo, recuperado::float AS recuperado FROM hallazgos
               WHERE negocio_id = $1 AND evaluado_en IS NOT NULL AND ${enMes('evaluado_en')} AND recuperado > 0 ORDER BY recuperado DESC`, [negocioId, desde]).then((r) => r.rows).catch(() => []),
    db.query(`SELECT DISTINCT proveedor FROM compras WHERE negocio_id = $1 AND proveedor IS NOT NULL AND ${enMes('fecha::timestamptz')}`, [negocioId, desde]).then((r) => r.rows.map((x) => x.proveedor)).catch(() => []),
  ]);

  // Subas de proveedores en las compras del mes: cuánta ganancia por mes sacan si no se tocan los precios de venta
  let subas = [], subasPlata = 0;
  try {
    const { fichaProveedor } = require('./ficha');
    for (const nombre of prov.slice(0, 15)) {
      const f = await fichaProveedor(negocioId, nombre, db);
      if (f && f.subieron.length) { subas.push({ proveedor: f.proveedor, productos: f.subieron.length, te_come_mes: f.resumen.te_come_mes || 0 }); subasPlata += f.resumen.te_come_mes || 0; }
    }
  } catch (e) { /* sin compras */ }

  // Lo recuperado total (hoy): lo que dejó de irse por mes gracias a todos los consejos medidos
  const rec = await require('./hallazgos').resumenRecuperado(negocioId, db).catch(() => ({ total_mensual: 0, medidos: [] }));
  const recMes = medidos.reduce((s, x) => s + x.recuperado, 0);

  const hizo = [];
  if (n0(consejo.precios)) hizo.push(`Cambió ${plural(n0(consejo.precios), 'precio', 'precios')} con un consejo (con el botón).`);
  if (n0(consejo.combos)) hizo.push(`Creó ${plural(n0(consejo.combos), 'combo', 'combos')} con un consejo.`);
  if (n0(inst.avisos)) hizo.push(`Te avisó en el momento ${plural(n0(inst.avisos), 'vez', 'veces')} de algo raro en la caja${n0(inst.utiles) ? ` (${n0(inst.utiles)} te ${n0(inst.utiles) === 1 ? 'sirvió' : 'sirvieron'})` : ''}.`);
  if (n0(caja.cerrados)) hizo.push(`Revisó ${plural(n0(caja.cerrados), 'cierre de caja', 'cierres de caja')}.`);

  const detecto = [];
  if (n0(caja.faltante) > 0) detecto.push({ clave: 'faltante', texto: `Faltaron ${$(caja.faltante)} en ${plural(n0(caja.con_falta), 'cierre de caja', 'cierres de caja')}.`, monto: Math.round(caja.faltante), ver: '/empleados' });
  if (n0(hechos.anuladas)) detecto.push({ clave: 'anuladas', texto: `Se anularon ${plural(n0(hechos.anuladas), 'venta', 'ventas')} por ${$(hechos.anuladas_plata)}.`, monto: Math.round(hechos.anuladas_plata), ver: '/en-vivo' });
  if (n0(hechos.descuentos)) detecto.push({ clave: 'descuentos', texto: `Se hicieron ${plural(n0(hechos.descuentos), 'descuento', 'descuentos')} por ${$(hechos.descuentos_plata)} en la caja.`, monto: Math.round(hechos.descuentos_plata), ver: '/en-vivo' });
  if (subasPlata > 0) detecto.push({ clave: 'subas', texto: `Los proveedores subieron precios: si no cambiás los tuyos, te sacan unos ${$(subasPlata)} de ganancia por mes.`, monto: Math.round(subasPlata), ver: '/compras' });

  const parcial = mes === actual;
  let titular;
  if (recMes > 0) titular = `Este mes se midió que dejaste de perder ${$(recMes)} por mes gracias a los consejos que probaste.`;
  else if (parcial && rec.total_mensual > 0) titular = `Con los consejos que probaste ya dejás de perder ${$(rec.total_mensual)} por mes.`;
  else if (n0(caja.faltante) > 0 || subasPlata > 0 || n0(hechos.anuladas)) titular = 'LumoBi encontró plata en juego este mes. Mirá abajo qué es y qué podés hacer.';
  else if (n0(ventas.n)) titular = 'Un mes tranquilo: LumoBi no encontró nada raro.';
  else titular = 'Todavía no hay movimiento en este mes.';

  return {
    mes, etiqueta: etiqueta(mes), parcial, anterior: sumarMes(mes, -1), siguiente: mes < actual ? sumarMes(mes, 1) : null,
    titular,
    ventas: { total: Math.round(ventas.total), cantidad: n0(ventas.n) },
    recuperado: { este_mes: Math.round(recMes), total_por_mes: Math.round(rec.total_mensual || 0), consejos: medidos.map((x) => ({ titulo: x.titulo, accion: x.accion_titulo, recuperado: Math.round(x.recuperado) })) },
    hizo, detecto,
    aviso: 'Lo "recuperado" es plata que se midió: el problema bajó después de que lo resolviste. Lo que "detectó" es plata en juego que LumoBi vio: no se suma a lo recuperado.',
  };
}

// Día 1 del mes (hora Argentina): un aviso con el resumen del mes que terminó. Una sola vez por negocio y mes.
async function enviarResumenesDelMes(db = pool, { forzar = false, ahora = new Date() } = {}) {
  const arg = new Date(ahora.getTime() - 3 * 3600e3);
  if (!forzar && arg.getUTCDate() !== 1) return { enviados: 0, motivo: 'no es día 1' };
  await db.query(`CREATE TABLE IF NOT EXISTS resumen_mensual_enviado (negocio_id INTEGER NOT NULL, mes TEXT NOT NULL, creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (negocio_id, mes))`);
  const mes = sumarMes(arg.toISOString().slice(0, 7), -1);
  const { ownerDeNegocio } = require('./prediccion_adaptativa');
  const { notificarUsuario } = require('./push');
  const negs = (await db.query('SELECT id FROM negocios WHERE deletion_scheduled_at IS NULL')).rows;
  let enviados = 0;
  for (const { id } of negs) {
    try {
      const r = await resumenMensual(id, mes, db);
      if (!r.ventas.cantidad) continue; // sin ventas ese mes: no hay nada que contar
      if ((await db.query('SELECT 1 FROM resumen_mensual_enviado WHERE negocio_id = $1 AND mes = $2', [id, mes])).rows.length) continue; // ya se mandó
      const owner = await ownerDeNegocio(id, db);
      if (!owner) continue;
      const cuerpo = r.recuperado.este_mes > 0 ? `Se midió que dejaste de perder ${$(r.recuperado.este_mes)} por mes con lo que probaste.`
        : r.detecto.length ? r.detecto[0].texto : `Vendiste ${$(r.ventas.total)} y LumoBi no encontró nada raro.`;
      await notificarUsuario(owner, { title: `Tu resumen de ${MESES[Number(mes.slice(5)) - 1]}`, body: cuerpo + ' Tocá para ver todo.', url: `/resumen-mensual?mes=${mes}` }, db, 'resumen_diario');
      // Se marca recién cuando el envío no falló: si falla, la próxima corrida lo reintenta
      await db.query('INSERT INTO resumen_mensual_enviado (negocio_id, mes) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, mes]);
      enviados++;
    } catch (e) { console.error('[resumen mensual] negocio', id, e.message); }
  }
  return { enviados, mes };
}

module.exports = { enviarResumenesDelMes, resumenMensual, etiqueta, sumarMes, hoyAR };
