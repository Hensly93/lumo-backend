// detector_equipo.js — el equipo, dentro del libro único de hallazgos (hallazgos.js).
// Antes las señales del equipo salían sueltas del motor viejo (erm). Ahora pasan por el mismo filtro de calidad
// que el resto: plata en juego, evidencia, feedback del dueño ("me sirvió", "no me sirve") y silencio.
// Cuatro señales, todas sacadas de lo que pasa en la caja:
//   · equipo_caja       diferencias de caja que se repiten (usa el nivel que ya calcula erm.js)
//   · equipo_borrados   productos sacados del carrito antes de cobrar, mucho más que el resto  (hechos_caja)
//   · equipo_egresos    plata sacada de la caja por turno, mucho más que el resto
//   · equipo_precios    precios bajados por el equipo, y cuánto se vendió con ese precio más bajo
// Reglas de trato: los títulos y la primera línea de evidencia NO llevan nombres (es lo que sale en el aviso del celular);
// los nombres van en el detalle dentro de la app. Nunca se acusa: se muestra qué pasó y se sugiere revisarlo.
const pool = require('./db');

const DIAS = 30;
const MIN_BORRADOS = 8;
const MIN_EGRESOS = 3;
const fmt = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('es-AR');
const sinTabla = (e) => e && (e.code === '42P01' || e.code === '42703');

// ── 1) Diferencias de caja que se repiten ───────────────────────────────────────
async function detCaja(negocioId, db, opts) {
  const erm = await (opts.erm || ((id) => require('./erm').calcularERMNegocio(id, null)))(negocioId);
  const marcados = ((erm && erm.empleados) || []).filter((e) => e.nivel === 'rojo' || e.nivel === 'amarillo');
  if (!marcados.length) return null;
  const nombres = marcados.map((e) => e.empleado);
  const r = await db.query(
    `SELECT nombre_empleado AS empleado, COUNT(*)::int AS turnos, COALESCE(SUM(brecha),0)::float AS falto
       FROM turnos_caja
      WHERE negocio_id = $1 AND estado = 'cerrado' AND brecha > 200 AND nombre_empleado = ANY($2::text[])
        AND hora_apertura >= NOW() - ($3::int * INTERVAL '1 day')
      GROUP BY nombre_empleado ORDER BY 3 DESC`, [negocioId, nombres, DIAS]);
  const total = Math.round(r.rows.reduce((s, x) => s + x.falto, 0));
  if (total <= 0) return null;
  const turnos = r.rows.reduce((s, x) => s + x.turnos, 0);
  const rojos = marcados.filter((e) => e.nivel === 'rojo').length;
  const nivel = new Map(marcados.map((e) => [e.empleado, e.nivel]));
  return {
    id: 'equipo_caja', tipo: 'calculado', ignora_suficiente: true,
    titulo: `La caja cerró con faltantes repetidos: ${fmt(total)} en ${DIAS} días`,
    detalle: `${turnos} ${turnos === 1 ? 'turno cerró' : 'turnos cerraron'} con menos plata de la esperada${rojos ? ' y hay señales fuertes en el equipo' : ''}. No es una acusación: es una inconsistencia para revisar con el detalle.`,
    evidencia: [
      `Faltaron ${fmt(total)} en ${turnos} ${turnos === 1 ? 'cierre' : 'cierres'} de caja de los últimos ${DIAS} días, en turnos de personas con señales repetidas.`,
      ...r.rows.slice(0, 4).map((x) => `${x.empleado}: ${fmt(x.falto)} de faltante en ${x.turnos} ${x.turnos === 1 ? 'turno' : 'turnos'} (nivel ${nivel.get(x.empleado)}).`),
    ],
    monto: total, monto_texto: `${fmt(total)} de faltante en la caja`, url: '/empleados',
  };
}

// ── 2) Productos sacados del carrito antes de cobrar ─────────────────────────────
async function detBorrados(negocioId, db) {
  const h = await db.query(
    `SELECT empleado, COUNT(*)::int AS n, COALESCE(SUM(valor),0)::float AS valor
       FROM hechos_caja WHERE negocio_id = $1 AND tipo IN ('item_borrado','cantidad_reducida')
        AND creado >= NOW() - ($2::int * INTERVAL '1 day') AND empleado IS NOT NULL GROUP BY empleado`, [negocioId, DIAS]);
  if (!h.rows.length) return null;
  const v = await db.query(
    `SELECT empleado, COUNT(*)::int AS ventas FROM transacciones
      WHERE negocio_id = $1 AND tipo = 'venta' AND fecha >= NOW() - ($2::int * INTERVAL '1 day') AND empleado IS NOT NULL GROUP BY empleado`, [negocioId, DIAS]);
  const ventas = new Map(v.rows.map((x) => [x.empleado, x.ventas]));
  const filas = h.rows.map((x) => ({ ...x, ventas: ventas.get(x.empleado) || 0 }));
  const marcados = [];
  for (const f of filas) {
    if (f.n < MIN_BORRADOS || f.ventas < 20) continue;
    const otros = filas.filter((o) => o.empleado !== f.empleado);
    const nOtros = otros.reduce((s, o) => s + o.n, 0), vOtros = otros.reduce((s, o) => s + o.ventas, 0);
    f.tasa = (f.n / f.ventas) * 100;
    f.tasaOtros = vOtros > 0 ? (nOtros / vOtros) * 100 : 0;
    if (f.tasa >= Math.max(6, f.tasaOtros * 3)) marcados.push(f);
  }
  if (!marcados.length) return null;
  const total = Math.round(marcados.reduce((s, x) => s + x.valor, 0));
  if (total <= 0) return null;
  const nTot = marcados.reduce((s, x) => s + x.n, 0);
  const top = await db.query(
    `SELECT COALESCE(producto_nombre,'(sin nombre)') AS nombre, COUNT(*)::int AS n, SUM(valor)::float AS valor
       FROM hechos_caja WHERE negocio_id = $1 AND tipo IN ('item_borrado','cantidad_reducida') AND empleado = ANY($2::text[])
        AND creado >= NOW() - ($3::int * INTERVAL '1 day') GROUP BY 1 ORDER BY 3 DESC LIMIT 3`, [negocioId, marcados.map((m) => m.empleado), DIAS]);
  const m0 = marcados[0];
  return {
    id: 'equipo_borrados', tipo: 'estimado', ignora_suficiente: true,
    titulo: `Se sacaron productos del carrito ${nTot} veces antes de cobrar, mucho más que lo normal`,
    detalle: `Suma ${fmt(total)} en productos. Puede ser gente que se arrepiente o un error al escanear, pero cuando se concentra en un turno conviene mirarlo.`,
    evidencia: [
      `${nTot} productos sacados del carrito en ${DIAS} días, por ${fmt(total)}: ${Math.round(m0.tasa * 10) / 10}% de las ventas de ese turno contra ${Math.round(m0.tasaOtros * 10) / 10}% del resto.`,
      ...marcados.slice(0, 3).map((x) => `${x.empleado}: ${x.n} sacados sobre ${x.ventas} ventas (${fmt(x.valor)}).`),
      ...(top.rows.length ? ['Los que más se sacaron: ' + top.rows.map((x) => `${x.nombre} (${x.n})`).join(', ') + '.'] : []),
      'Es una estimación: no sabemos si el cliente se arrepintió o no. Lo que importa es que se repite más que en el resto del equipo.',
    ],
    monto: total, monto_texto: `${fmt(total)} en productos sacados del carrito`, url: '/empleados',
  };
}

// ── 3) Egresos de caja ───────────────────────────────────────────────────────────
async function detEgresos(negocioId, db) {
  const r = await db.query(
    `SELECT t.nombre_empleado AS empleado, COUNT(DISTINCT t.id)::int AS turnos,
            COUNT(e.id)::int AS n, COALESCE(SUM(e.monto),0)::float AS total
       FROM turnos_caja t LEFT JOIN egresos_caja e ON e.turno_id = t.id
      WHERE t.negocio_id = $1 AND t.hora_apertura >= NOW() - ($2::int * INTERVAL '1 day')
      GROUP BY t.nombre_empleado`, [negocioId, DIAS]);
  const filas = r.rows.filter((x) => x.turnos > 0);
  if (filas.length < 2) return null;     // sin con quién comparar no hay señal
  const marcados = [];
  for (const f of filas) {
    if (f.n < MIN_EGRESOS) continue;
    const otros = filas.filter((o) => o.empleado !== f.empleado);
    const tOtros = otros.reduce((s, o) => s + o.turnos, 0);
    const promOtros = tOtros > 0 ? otros.reduce((s, o) => s + o.total, 0) / tOtros : 0;
    const prom = f.total / f.turnos;
    const exceso = f.total - promOtros * f.turnos;
    if (prom >= Math.max(1500, promOtros * 2.5) && exceso > 0) marcados.push({ ...f, prom, promOtros, exceso });
  }
  if (!marcados.length) return null;
  const total = Math.round(marcados.reduce((s, x) => s + x.exceso, 0));
  const m0 = marcados[0];
  return {
    id: 'equipo_egresos', tipo: 'estimado', ignora_suficiente: true,
    titulo: `Salió más plata de la caja en algunos turnos que en el resto: ${fmt(total)} de diferencia`,
    detalle: 'Los egresos pueden ser reales (proveedores, mandados). La idea es que cada uno tenga su comprobante.',
    evidencia: [
      `En ${DIAS} días hubo turnos donde salió ${fmt(m0.prom)} por turno de la caja, contra ${fmt(m0.promOtros)} del resto del equipo.`,
      ...marcados.slice(0, 3).map((x) => `${x.empleado}: ${x.n} egresos por ${fmt(x.total)} en ${x.turnos} ${x.turnos === 1 ? 'turno' : 'turnos'}.`),
      'Es la diferencia contra lo que sacó el resto del equipo por turno. Pedí el comprobante de cada uno.',
    ],
    monto: total, monto_texto: `${fmt(total)} más de egresos que el resto`, url: '/empleados',
  };
}

// ── 4) Precios bajados por el equipo ─────────────────────────────────────────────
async function detPrecios(negocioId, db) {
  const r = await db.query(
    `WITH c AS (
       SELECT id, producto_id, producto_nombre, valor_anterior::float AS ant, valor_nuevo::float AS nue, empleado, origen, creado,
              LEAD(creado) OVER (PARTITION BY producto_id ORDER BY creado) AS hasta
         FROM cambios_precios WHERE negocio_id = $1 AND campo = 'precio_venta' AND creado >= NOW() - ($2::int * INTERVAL '1 day'))
     SELECT c.producto_nombre, c.ant, c.nue, c.empleado, c.creado, COALESCE(u.unidades,0)::float AS unidades
       FROM c LEFT JOIN LATERAL (
         SELECT SUM(d.cantidad) AS unidades FROM transacciones_detalle d JOIN transacciones t ON t.id = d.transaccion_id
          WHERE t.negocio_id = $1 AND d.producto_id = c.producto_id AND t.fecha >= c.creado AND (c.hasta IS NULL OR t.fecha < c.hasta)) u ON true
      WHERE c.origen = 'empleado' AND c.ant > 0 AND c.nue < c.ant * 0.85
      ORDER BY (c.ant - c.nue) * COALESCE(u.unidades,0) DESC`, [negocioId, DIAS]);
  const filas = r.rows.map((x) => ({ ...x, perdida: (x.ant - x.nue) * x.unidades })).filter((x) => x.perdida > 0);
  if (!filas.length) return null;
  const total = Math.round(filas.reduce((s, x) => s + x.perdida, 0));
  return {
    id: 'equipo_precios', tipo: 'calculado', ignora_suficiente: true,
    titulo: `Se bajaron precios desde la caja y se vendió más barato: ${fmt(total)} menos en ${DIAS} días`,
    detalle: 'Es la diferencia entre el precio de antes y el nuevo, por las unidades vendidas con el precio más bajo.',
    evidencia: [
      `${filas.length} ${filas.length === 1 ? 'precio bajado' : 'precios bajados'} desde la caja en ${DIAS} días, con ${fmt(total)} de diferencia en lo vendido después.`,
      ...filas.slice(0, 3).map((x) => `${x.producto_nombre}: de ${fmt(x.ant)} a ${fmt(x.nue)} (${x.empleado}), ${Math.round(x.unidades)} u. vendidas a ese precio.`),
      'Si el cambio lo autorizaste vos, ignoralo. Si no, podés sacarle el permiso de cambiar precios a quien no lo necesite.',
    ],
    monto: total, monto_texto: `${fmt(total)} menos por precios bajados desde la caja`, url: '/empleados',
  };
}

// Devuelve la lista de hallazgos del equipo (cada señal falla por separado sin tumbar a las demás).
async function detectarEquipo(negocioId, db = pool, opts = {}) {
  const out = [];
  const pasos = [['caja', () => detCaja(negocioId, db, opts)], ['borrados', () => detBorrados(negocioId, db)],
    ['egresos', () => detEgresos(negocioId, db)], ['precios', () => detPrecios(negocioId, db)]];
  for (const [nombre, fn] of pasos) {
    try { const h = await fn(); if (h) out.push(h); }
    catch (e) { if (!sinTabla(e)) console.error('detector_equipo/' + nombre + ':', e.message); }
  }
  return out;
}

module.exports = { detectarEquipo, detCaja, detBorrados, detEgresos, detPrecios };
