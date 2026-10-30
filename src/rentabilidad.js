// rentabilidad.js — LumoBi · Gastos → Rentabilidad (29/10/2026)
//
// · El dueño carga TOTALES por mes y categoría (nunca factura por factura), de un local o de
//   todo el negocio. Los gastos generales se reparten entre locales según lo que vende cada uno.
// · Los egresos de caja que registran los empleados en los turnos se suman solos (línea aparte).
// · Ganancia operativa ANTES de impuestos = ventas − gastos − egresos de caja.
//   Impuestos: opcionales, los declara el dueño (monto fijo o % propio). LumoBi no calcula impuestos.
// · Mes en curso: los gastos cargados se toman proporcionales a los días transcurridos.
// · Punto de equilibrio: con los últimos 3 meses cerrados que tengan gastos cargados.
// Todas las consultas filtran por negocio_id.

const pool = require('./db');

const CATEGORIAS = [
  { id: 'mercaderia',    label: 'Mercadería / proveedores',            variable: true },
  { id: 'alquiler',      label: 'Alquiler',                            variable: false },
  { id: 'sueldos',       label: 'Sueldos y cargas sociales',           variable: false },
  { id: 'servicios',     label: 'Servicios (luz, gas, agua, internet)', variable: false },
  { id: 'comisiones',    label: 'Comisiones (MP, tarjetas)',           variable: true },
  { id: 'mantenimiento', label: 'Mantenimiento',                       variable: false },
  { id: 'marketing',     label: 'Marketing',                           variable: false },
  { id: 'otros',         label: 'Otros',                               variable: false },
];
const CAT_IDS = new Set(CATEGORIAS.map(c => c.id));
const VARIABLES = new Set(CATEGORIAS.filter(c => c.variable).map(c => c.id));

const FL = `(fecha - INTERVAL '3 hours')`;
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function ahoraLocal(opciones = {}) {
  return opciones.ahora ? new Date(opciones.ahora.replace(' ', 'T') + 'Z') : new Date(Date.now() - 3 * 3600000);
}
const claveMes = d => d.toISOString().slice(0, 7);
const diasDelMes = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const r0 = n => (n == null ? null : Math.round(n));
const limpiarNombre = n => String(n ?? '').replace(/^[\s"']+|[\s"']+$/g, '');

async function sucursalesDelNegocio(db, negocioId) {
  const r = await db.query('SELECT id, nombre FROM mis_sucursales WHERE negocio_id = $1 ORDER BY id', [negocioId]);
  return r.rows.map(s => ({ id: s.id, nombre: limpiarNombre(s.nombre) }));
}

// ─── Lectura / escritura de gastos ───────────────────────────────────────────
async function obtenerGastos(negocioId, mes, db = pool) {
  if (!MES_RE.test(mes)) throw Object.assign(new Error('Mes inválido'), { status: 400 });
  const [y, m] = mes.split('-').map(Number);
  const anterior = claveMes(new Date(Date.UTC(y, m - 2, 1)));
  const q = await db.query(
    `SELECT to_char(mes,'YYYY-MM') AS mes, sucursal_id, categoria, monto::float AS monto
     FROM gastos_mensuales WHERE negocio_id = $1 AND mes IN ($2::date, $3::date)`,
    [negocioId, `${mes}-01`, `${anterior}-01`]
  );
  const imp = await db.query('SELECT modo, base, valor::float AS valor FROM impuestos_declarados WHERE negocio_id = $1', [negocioId]);
  return {
    mes, mes_anterior: anterior,
    categorias: CATEGORIAS,
    sucursales: await sucursalesDelNegocio(db, negocioId),
    gastos: q.rows.filter(x => x.mes === mes).map(({ sucursal_id, categoria, monto }) => ({ sucursal_id, categoria, monto })),
    gastos_mes_anterior: q.rows.filter(x => x.mes === anterior).map(({ sucursal_id, categoria, monto }) => ({ sucursal_id, categoria, monto })),
    impuestos: imp.rows[0] || { modo: 'ninguno', base: 'ventas', valor: 0 },
  };
}

// items: [{ sucursal_id: number|null, categoria, monto }] — reemplaza lo cargado para ese mes
// en los locales/categorías que vienen. Monto 0 o vacío = se borra.
async function guardarGastos(negocioId, mes, items, db = pool) {
  if (!MES_RE.test(mes)) throw Object.assign(new Error('Mes inválido'), { status: 400 });
  if (!Array.isArray(items) || items.length > 200) throw Object.assign(new Error('Datos inválidos'), { status: 400 });
  const validas = new Set((await sucursalesDelNegocio(db, negocioId)).map(s => s.id));
  for (const it of items) {
    const suc = it.sucursal_id == null ? null : Number(it.sucursal_id);
    const monto = Number(it.monto || 0);
    if (!CAT_IDS.has(it.categoria)) throw Object.assign(new Error(`Categoría inválida: ${it.categoria}`), { status: 400 });
    if (suc != null && !validas.has(suc)) throw Object.assign(new Error('Local inválido para este negocio'), { status: 400 });
    if (!Number.isFinite(monto) || monto < 0 || monto > 1e12) throw Object.assign(new Error('Monto inválido'), { status: 400 });
  }
  const cli = db.connect ? await db.connect() : db;
  try {
    await cli.query('BEGIN');
    for (const it of items) {
      const suc = it.sucursal_id == null ? null : Number(it.sucursal_id);
      const monto = Math.round(Number(it.monto || 0) * 100) / 100;
      await cli.query(
        `DELETE FROM gastos_mensuales WHERE negocio_id = $1 AND sucursal_id IS NOT DISTINCT FROM $2::integer AND mes = $3::date AND categoria = $4`,
        [negocioId, suc, `${mes}-01`, it.categoria]
      );
      if (monto > 0) {
        await cli.query(
          `INSERT INTO gastos_mensuales (negocio_id, sucursal_id, mes, categoria, monto) VALUES ($1, $2, $3::date, $4, $5)`,
          [negocioId, suc, `${mes}-01`, it.categoria, monto]
        );
      }
    }
    await cli.query('COMMIT');
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (cli !== db && cli.release) cli.release();
  }
  return obtenerGastos(negocioId, mes, db);
}

async function guardarImpuestos(negocioId, { modo, base, valor }, db = pool) {
  if (!['ninguno', 'porcentaje', 'monto'].includes(modo)) throw Object.assign(new Error('Modo inválido'), { status: 400 });
  if (!['ventas', 'ganancia'].includes(base || 'ventas')) throw Object.assign(new Error('Base inválida'), { status: 400 });
  const v = Number(valor || 0);
  if (!Number.isFinite(v) || v < 0 || (modo === 'porcentaje' && v > 100) || v > 1e12) throw Object.assign(new Error('Valor inválido'), { status: 400 });
  await db.query(
    `INSERT INTO impuestos_declarados (negocio_id, modo, base, valor, actualizado_en) VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (negocio_id) DO UPDATE SET modo = EXCLUDED.modo, base = EXCLUDED.base, valor = EXCLUDED.valor, actualizado_en = NOW()`,
    [negocioId, modo, base || 'ventas', modo === 'ninguno' ? 0 : v]
  );
  return { modo, base: base || 'ventas', valor: modo === 'ninguno' ? 0 : v };
}

// ─── Cálculo ─────────────────────────────────────────────────────────────────
async function calcularRentabilidad(negocioId, sucursalId = null, opciones = {}, db = pool) {
  const ahora = ahoraLocal(opciones);
  const yA = ahora.getUTCFullYear(), mA = ahora.getUTCMonth();
  const meses = Array.from({ length: 12 }, (_, i) => claveMes(new Date(Date.UTC(yA, mA - 11 + i, 1))));
  const desde = `${meses[0]}-01`;
  const mesActual = meses[11];
  const fracActual = (ahora.getUTCDate() - 1 + ahora.getUTCHours() / 24) / diasDelMes(yA, mA);

  const [vRes, gRes, eRes, iRes, sucs] = await Promise.all([
    // Ventas por mes y local (de todo el negocio: hace falta para repartir gastos generales)
    db.query(
      `SELECT to_char(${FL},'YYYY-MM') AS mes, sucursal_id, COALESCE(SUM(monto),0)::float AS total
       FROM transacciones WHERE negocio_id = $1 AND ${FL} >= $2::timestamp
       GROUP BY 1, 2`, [negocioId, desde]),
    db.query(
      `SELECT to_char(mes,'YYYY-MM') AS mes, sucursal_id, categoria, monto::float AS monto
       FROM gastos_mensuales WHERE negocio_id = $1 AND mes >= $2::date`, [negocioId, desde]),
    db.query(
      `SELECT to_char(e.hora - INTERVAL '3 hours','YYYY-MM') AS mes, t.sucursal_id, COALESCE(SUM(e.monto),0)::float AS total
       FROM egresos_caja e LEFT JOIN turnos_caja t ON t.id = e.turno_id AND t.negocio_id = e.negocio_id
       WHERE e.negocio_id = $1 AND (e.hora - INTERVAL '3 hours') >= $2::timestamp
       GROUP BY 1, 2`, [negocioId, desde]),
    db.query('SELECT modo, base, valor::float AS valor FROM impuestos_declarados WHERE negocio_id = $1', [negocioId]),
    sucursalesDelNegocio(db, negocioId),
  ]);
  let ipcRows = [];
  try { ipcRows = (await db.query(`SELECT to_char(mes,'YYYY-MM') AS mes, indice::float AS indice FROM ipc_mensual ORDER BY mes`)).rows; } catch { /* sin IPC */ }
  const imp = iRes.rows[0] || { modo: 'ninguno', base: 'ventas', valor: 0 };

  // Participación del local en las ventas del mes (para repartir gastos generales e impuesto fijo)
  function participacion(mes) {
    if (sucursalId == null) return 1;
    const vm = vRes.rows.filter(v => v.mes === mes);
    const tot = vm.reduce((s, v) => s + v.total, 0);
    if (tot > 0) return vm.filter(v => v.sucursal_id === sucursalId).reduce((s, v) => s + v.total, 0) / tot;
    return sucs.length ? 1 / sucs.length : 1;
  }

  const filas = meses.map(mes => {
    const part = participacion(mes);
    const enCurso = mes === mesActual;
    const factor = enCurso ? fracActual : 1;
    const ventas = vRes.rows.filter(v => v.mes === mes && (sucursalId == null || v.sucursal_id === sucursalId)).reduce((s, v) => s + v.total, 0);
    const gm = gRes.rows.filter(g => g.mes === mes);
    const cargados = gm.length > 0;
    const porCat = {};
    const porCatMes = {};   // monto del mes completo (sin proporcional): para comparar mes contra mes
    for (const g of gm) {
      let peso;
      if (sucursalId == null) peso = 1;
      else if (g.sucursal_id === sucursalId) peso = 1;
      else if (g.sucursal_id == null) peso = part;
      else peso = 0;
      if (peso) {
        porCat[g.categoria] = (porCat[g.categoria] || 0) + g.monto * peso * factor;
        porCatMes[g.categoria] = (porCatMes[g.categoria] || 0) + g.monto * peso;
      }
    }
    const egresos = eRes.rows.filter(e => e.mes === mes && (sucursalId == null || e.sucursal_id === sucursalId)).reduce((s, e) => s + e.total, 0);
    const gastos = Object.values(porCat).reduce((s, x) => s + x, 0);
    const ganancia = cargados ? ventas - gastos - egresos : null;
    let impuestos = null;
    if (cargados && imp.modo === 'monto') impuestos = imp.valor * part * factor;
    if (cargados && imp.modo === 'porcentaje') impuestos = (imp.base === 'ganancia' ? Math.max(0, ganancia) : ventas) * imp.valor / 100;
    return {
      mes, en_curso: enCurso, gastos_cargados: cargados,
      ventas: r0(ventas),
      gastos: cargados ? r0(gastos) : null,
      egresos_caja: r0(egresos),
      por_categoria: Object.fromEntries(Object.entries(porCat).map(([k, v]) => [k, r0(v)])),
      por_categoria_mes: Object.fromEntries(Object.entries(porCatMes).map(([k, v]) => [k, r0(v)])),
      ganancia_operativa: r0(ganancia),
      margen: ganancia != null && ventas > 0 ? Math.round((ganancia / ventas) * 1000) / 10 : null,
      impuestos_declarados: r0(impuestos),
      ganancia_despues_impuestos: ganancia != null && impuestos != null ? r0(ganancia - impuestos) : null,
    };
  });

  // Punto de equilibrio: últimos 3 meses cerrados con gastos cargados y ventas
  const base = filas.filter(f => !f.en_curso && f.gastos_cargados && f.ventas > 0).slice(-3);
  let equilibrio = null;
  if (base.length) {
    const ventas = base.reduce((s, f) => s + f.ventas, 0);
    const variables = base.reduce((s, f) => s + Object.entries(f.por_categoria).filter(([k]) => VARIABLES.has(k)).reduce((a, [, v]) => a + v, 0), 0);
    const fijos = base.reduce((s, f) => s + (f.gastos - Object.entries(f.por_categoria).filter(([k]) => VARIABLES.has(k)).reduce((a, [, v]) => a + v, 0)) + f.egresos_caja, 0) / base.length;
    const ratioVar = variables / ventas;
    if (ratioVar < 0.95) {
      const mes = fijos / (1 - ratioVar);
      const diasMes = diasDelMes(yA, mA);
      const actual = filas[11];
      const esperadoALaFecha = mes * fracActual;
      equilibrio = {
        meses_usados: base.map(f => f.mes),
        gastos_fijos_mes: r0(fijos),
        gastos_fijos_mes_sin_caja: r0(fijos - base.reduce((s, f) => s + f.egresos_caja, 0) / base.length),
        costo_variable_pct: Math.round(ratioVar * 1000) / 10,
        ventas_necesarias_mes: r0(mes),
        ventas_necesarias_dia: r0(mes / diasMes),
        mes_en_curso: {
          vendido: actual.ventas,
          necesario_a_la_fecha: r0(esperadoALaFecha),
          diferencia: r0(actual.ventas - esperadoALaFecha),
          avance_pct: mes > 0 ? Math.round((actual.ventas / mes) * 1000) / 10 : null,
        },
      };
    }
  }

  // En qué se va la plata: últimos 12 meses con gastos cargados
  const totalesCat = {};
  for (const f of filas) for (const [k, v] of Object.entries(f.por_categoria)) totalesCat[k] = (totalesCat[k] || 0) + v;
  const egresosTot = filas.reduce((s, f) => s + (f.gastos_cargados ? f.egresos_caja : 0), 0);
  const totalGastos = Object.values(totalesCat).reduce((s, v) => s + v, 0) + egresosTot;
  const enQueSeVa = [
    ...CATEGORIAS.filter(c => totalesCat[c.id]).map(c => ({ categoria: c.id, label: c.label, total: r0(totalesCat[c.id]) })),
    ...(egresosTot ? [{ categoria: 'egresos_caja', label: 'Gastos de caja (registrados en turnos)', total: r0(egresosTot) }] : []),
  ].sort((a, b) => b.total - a.total).map(x => ({ ...x, pct: totalGastos ? Math.round((x.total / totalGastos) * 1000) / 10 : 0 }));

  const recomendaciones = generarRecomendaciones({ filas, equilibrio, ipcRows, ahora, fracActual });

  return {
    sucursal_id: sucursalId,
    ahora: ahora.toISOString().slice(0, 16).replace('T', ' '),
    categorias: CATEGORIAS,
    meses: filas,
    mes_en_curso: { ...filas[11], avance_mes_pct: Math.round(fracActual * 1000) / 10 },
    ultimo_mes_cerrado: [...filas].reverse().find(f => !f.en_curso && f.gastos_cargados) || null,
    equilibrio,
    en_que_se_va: enQueSeVa,
    impuestos: imp,
    hay_gastos: gRes.rows.length > 0,
    recomendaciones,
  };
}


// ─── Recomendaciones: qué hacer para ganar más (sin fotos de facturas, con lo cargado) ───
// Cada una: { id, tipo: 'alerta'|'atencion'|'positiva', titulo, detalle, accion, impacto_pesos }
const fmtP = n => '$' + Math.round(Math.abs(n)).toLocaleString('es-AR');
const fmtPct = n => `${n > 0 ? '+' : ''}${(Math.round(n * 10) / 10).toLocaleString('es-AR')}%`;
const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreMes = m => NOMBRE_MES[Number(m.slice(5, 7)) - 1];

function inflacionDelMes(ipcRows, mes) {
  // Variación mensual del IPC para "mes"; si todavía no se publicó, la última publicada
  const i = ipcRows.findIndex(r => r.mes === mes);
  const k = i > 0 ? i : ipcRows.length - 1;
  if (k < 1) return null;
  return { pct: (ipcRows[k].indice / ipcRows[k - 1].indice - 1) * 100, mes: ipcRows[k].mes, estimada: i < 1 };
}

const CONSEJO = {
  mercaderia: 'Si tus precios de venta no subieron igual, estás perdiendo margen en cada venta. Revisá los precios de lo que más vendés y pedí otra cotización a otro proveedor.',
  servicios: 'Mirá la boleta: si subió el consumo (kWh o m³) y no solo la tarifa, revisá heladeras, freezers y equipos que queden prendidos.',
  alquiler: 'Si es un ajuste del contrato, tenelo en cuenta en tus precios: es un costo fijo que pagás vendas o no.',
  sueldos: 'Revisá cuánta gente tenés por turno contra lo que se vende en cada hora: en las horas flojas puede sobrar personal.',
  comisiones: 'Las comisiones crecen con los cobros con tarjeta y QR. Evaluá un pequeño descuento por efectivo o transferencia.',
  mantenimiento: 'Si se repite mes a mes, puede convenir reemplazar el equipo en vez de seguir arreglándolo.',
  marketing: 'Fijate si este gasto trajo más ventas en Períodos; si no, ajustalo.',
  otros: 'Revisá qué entró en "Otros": si es un gasto que se repite, conviene darle su categoría.',
};

function generarRecomendaciones({ filas, equilibrio, ipcRows, ahora, fracActual }) {
  const recs = [];
  const conGastos = filas.filter(f => f.gastos_cargados);
  const label = id => (CATEGORIAS.find(c => c.id === id) || { label: id }).label;

  // 1) Cada categoría: último mes cargado contra el anterior, comparado con la inflación
  if (conGastos.length >= 2) {
    const cur = conGastos[conGastos.length - 1], prev = conGastos[conGastos.length - 2];
    const infl = inflacionDelMes(ipcRows, cur.mes);
    const inflPct = infl ? infl.pct : 0;
    const ventasRef = (filas.filter(f => !f.en_curso && f.ventas > 0).slice(-1)[0] || cur).ventas || 0;
    for (const [cat, monto] of Object.entries(cur.por_categoria_mes)) {
      const antes = prev.por_categoria_mes[cat];
      if (!antes || !monto) continue;
      const varPct = (monto / antes - 1) * 100;
      const exceso = monto - antes * (1 + inflPct / 100);
      if (varPct - inflPct >= 5 && exceso >= Math.max(5000, ventasRef * 0.003)) {
        recs.push({
          id: `suba_${cat}_${cur.mes}`, tipo: varPct - inflPct >= 15 ? 'alerta' : 'atencion',
          titulo: `${label(cat)} subió ${fmtPct(varPct)} en ${nombreMes(cur.mes)}`,
          detalle: `Pasó de ${fmtP(antes)} a ${fmtP(monto)}.` + (infl ? ` La inflación ${infl.estimada ? 'del último mes publicado' : 'del mes'} fue ${fmtPct(inflPct)}: son ${fmtP(exceso)} por encima de la inflación.` : ''),
          accion: CONSEJO[cat] || CONSEJO.otros,
          impacto_pesos: Math.round(exceso),
        });
      }
    }
  }

  // 2) Costo variable: cuánto de cada $100 vendidos se va en mercadería y comisiones (meses cerrados)
  const cerrados = filas.filter(f => !f.en_curso && f.gastos_cargados && f.ventas > 0);
  if (cerrados.length >= 2) {
    const ratio = f => ((f.por_categoria.mercaderia || 0) + (f.por_categoria.comisiones || 0)) / f.ventas;
    const ult = cerrados[cerrados.length - 1];
    const previos = cerrados.slice(-4, -1);
    const antes = previos.reduce((s, f) => s + ratio(f), 0) / previos.length;
    const ahoraR = ratio(ult);
    if (ahoraR - antes >= 0.03 && antes > 0) {
      const impacto = (ahoraR - antes) * ult.ventas;
      recs.push({
        id: `margen_${ult.mes}`, tipo: 'alerta',
        titulo: `Tus precios quedaron atrás de tus costos`,
        detalle: `En ${nombreMes(ult.mes)}, de cada $100 que vendiste se fueron $${Math.round(ahoraR * 100)} en mercadería y comisiones (antes, $${Math.round(antes * 100)}). Son ${fmtP(impacto)} menos de ganancia en el mes.`,
        accion: 'Actualizá los precios de los productos que más vendés. Cuando cargues las facturas de tus proveedores, LumoBi te va a decir producto por producto cuál quedó atrasado.',
        impacto_pesos: Math.round(impacto),
      });
    }
  }

  // 3) Ventas reales del último mes cerrado contra el anterior
  const conVentas = filas.filter(f => !f.en_curso && f.ventas > 0);
  if (conVentas.length >= 2) {
    const a = conVentas[conVentas.length - 1], b = conVentas[conVentas.length - 2];
    const infl = inflacionDelMes(ipcRows, a.mes);
    if (infl && b.ventas > 0) {
      const nominal = (a.ventas / b.ventas - 1) * 100;
      const real = ((1 + nominal / 100) / (1 + infl.pct / 100) - 1) * 100;
      if (real <= -3) {
        recs.push({
          id: `ventas_reales_${a.mes}`, tipo: 'atencion',
          titulo: `En ${nombreMes(a.mes)} vendiste ${(Math.round(-real * 10) / 10).toLocaleString('es-AR')}% menos en términos reales`,
          detalle: `Tus ventas cambiaron ${fmtPct(nominal)} y la inflación fue ${fmtPct(infl.pct)}: en plata de hoy, vendiste menos.`,
          accion: 'Mirá en Períodos qué días, horarios o locales cayeron, y si subiste precios por encima de lo que acepta tu clientela.',
          impacto_pesos: Math.round(b.ventas * (1 + infl.pct / 100) - a.ventas),
        });
      }
    }
  }

  // 4) Mes en curso contra el punto de equilibrio
  const act = filas[filas.length - 1];
  if (equilibrio && fracActual > 0.1) {
    const diasMes = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() + 1, 0)).getUTCDate();
    const diasRestantes = Math.max(1, Math.ceil(diasMes * (1 - fracActual)));
    const falta = equilibrio.ventas_necesarias_mes - act.ventas;
    const promedio = act.ventas / Math.max(1, diasMes * fracActual);
    if (equilibrio.mes_en_curso.diferencia < 0) {
      recs.push({
        id: `equilibrio_${act.mes}`, tipo: 'alerta',
        titulo: `Vas ${fmtP(equilibrio.mes_en_curso.diferencia)} abajo de lo necesario para cubrir el mes`,
        detalle: `Para cubrir tus gastos de ${nombreMes(act.mes)} te faltan ${fmtP(falta)}: unos ${fmtP(falta / diasRestantes)} por día en los ${diasRestantes} días que quedan (hoy promediás ${fmtP(promedio)} por día).`,
        accion: 'Mirá en Predicciones qué días vienen mejor y reforzá esos; evitá gastos que se puedan pasar al mes que viene.',
        impacto_pesos: Math.round(-equilibrio.mes_en_curso.diferencia),
      });
    } else {
      recs.push({
        id: `equilibrio_ok_${act.mes}`, tipo: 'positiva',
        titulo: falta <= 0 ? `Ya cubriste todos tus gastos de ${nombreMes(act.mes)}` : `Vas ${fmtP(equilibrio.mes_en_curso.diferencia)} arriba de lo necesario`,
        detalle: falta <= 0
          ? `Desde acá, lo que vendas (menos el costo de la mercadería) es ganancia.`
          : `A este ritmo cubrís el mes. Te faltan ${fmtP(falta)} para el punto de equilibrio.`,
        accion: 'Buen momento para guardar un colchón o adelantar una compra a buen precio.',
        impacto_pesos: 0,
      });
    }
  }

  // 5) Cuánto se movió el punto de equilibrio con los gastos del último mes cargado
  if (equilibrio && conGastos.length) {
    const ult = conGastos[conGastos.length - 1];
    const fijosNuevos = Object.entries(ult.por_categoria_mes).filter(([k]) => !VARIABLES.has(k)).reduce((s, [, v]) => s + v, 0);
    const ratioVar = equilibrio.costo_variable_pct / 100;
    const egresosProm = equilibrio.gastos_fijos_mes - (equilibrio.gastos_fijos_mes_sin_caja ?? equilibrio.gastos_fijos_mes);
    const nuevoMes = (fijosNuevos + egresosProm) / (1 - ratioVar);
    const cambio = nuevoMes / equilibrio.ventas_necesarias_mes - 1;
    if (cambio >= 0.03) {
      const diasMes = 30;
      recs.push({
        id: `equilibrio_sube_${ult.mes}`, tipo: 'atencion',
        titulo: `Con los gastos de ${nombreMes(ult.mes)}, tu punto de equilibrio sube ${fmtPct(cambio * 100)}`,
        detalle: `Ahora necesitás vender unos ${fmtP(nuevoMes)} por mes para cubrir todo: ${fmtP((nuevoMes - equilibrio.ventas_necesarias_mes) / diasMes)} más por día que antes.`,
        accion: 'Si estos gastos van a seguir, ajustá precios ahora y no a fin de mes.',
        impacto_pesos: Math.round(nuevoMes - equilibrio.ventas_necesarias_mes),
      });
    }
  }

  // 6) Último mes cerrado con pérdida
  const ultCerrado = [...filas].reverse().find(f => !f.en_curso && f.gastos_cargados);
  if (ultCerrado && ultCerrado.ganancia_operativa < 0) {
    const top = Object.entries(ultCerrado.por_categoria).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${label(k).split(' (')[0].toLowerCase()} (${fmtP(v)})`);
    recs.push({
      id: `perdida_${ultCerrado.mes}`, tipo: 'alerta',
      titulo: `En ${nombreMes(ultCerrado.mes)} perdiste ${fmtP(ultCerrado.ganancia_operativa)}`,
      detalle: `Vendiste ${fmtP(ultCerrado.ventas)} y gastaste más. Lo que más pesa: ${top.join(' y ')}.`,
      accion: 'Empezá por el gasto más grande: es donde un 10% menos se nota de verdad.',
      impacto_pesos: Math.round(-ultCerrado.ganancia_operativa),
    });
  }

  const orden = { alerta: 0, atencion: 1, positiva: 2 };
  return recs.sort((a, b) => orden[a.tipo] - orden[b.tipo] || b.impacto_pesos - a.impacto_pesos).slice(0, 6);
}

module.exports = { CATEGORIAS, obtenerGastos, guardarGastos, guardarImpuestos, calcularRentabilidad };
