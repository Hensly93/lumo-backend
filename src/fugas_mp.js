// fugas_mp.js — Fuga "Mercado Pago contra caja".
//
// Compara lo que ENTRO por Mercado Pago (pagos_mp, estado approved) contra lo que el negocio REGISTRO como venta
// digital (transacciones con metodo_pago distinto de efectivo). Si entra mas plata por Mercado Pago de la que figura
// en las ventas, hay cobros que no se estan registrando.
//
// Reglas (conservadoras: preferimos no avisar a avisar de mas):
//  - Se compara contra TODA la venta digital registrada (debito, credito, transferencia, QR, Mercado Pago), no solo la
//    marcada "mp": una venta con Point o QR de Mercado Pago puede haberse cargado como debito o credito.
//    Las ventas digitales por otros medios (posnet de un banco) solo suman del lado "registrado": nunca generan fuga.
//  - Bloques de 7 dias hacia atras (hasta 4). Solo cuentan los bloques completos que empiezan despues del primer pago
//    sincronizado y que tienen alguna venta cargada: sin ventas cargadas no hay con que comparar.
//  - Hay fuga con al menos 2 bloques con diferencia relevante (> $5.000 y > 5% de lo cobrado) y un total >= $10.000.
//  - Nunca se dice "fraude" ni se nombra a nadie: son cobros que no figuran en las ventas.
//  - Si el negocio no tiene pagos de Mercado Pago sincronizados, devuelve evaluado=false (queda "pendiente de datos").
//  - Si la cuenta de Mercado Pago tambien recibe plata que no es del negocio, esa plata aparece como diferencia:
//    por eso la correccion sugiere separar las cuentas.

const BLOQUES = 4;
const DIAS_BLOQUE = 7;
const MIN_DIF_BLOQUE = 5000;
const MIN_PCT_BLOQUE = 0.05;
const MIN_TOTAL = 10000;
const GMT = 3 * 3600000; // Argentina = UTC-3 (sin horario de verano)

const fmt = (n) => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('es-AR');
const aNaive = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

async function fugasDeMercadoPago(negocioId, db, ahora) {
  const cob = await db.query(
    `SELECT MIN(fecha)::text AS primero, COUNT(*)::int AS n FROM pagos_mp WHERE negocio_id=$1 AND estado='approved'`,
    [negocioId]
  );
  if (!cob.rows[0] || !cob.rows[0].n) return { evaluado: false, fugas: [] };
  // pagos_mp.fecha esta en UTC sin zona; transacciones.fecha esta en hora de Argentina sin zona.
  const primeroMs = new Date(String(cob.rows[0].primero).replace(' ', 'T') + 'Z').getTime();

  const bloques = [];
  for (let i = 0; i < BLOQUES; i++) {
    const fin = ahora.getTime() - i * DIAS_BLOQUE * 86400000;
    const ini = fin - DIAS_BLOQUE * 86400000;
    if (ini < primeroMs) break; // la sincronizacion todavia no cubre este bloque completo
    const [mp, ven] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(monto),0)::float AS total, COUNT(*)::int AS n FROM pagos_mp
                 WHERE negocio_id=$1 AND estado='approved' AND fecha >= $2 AND fecha < $3`, [negocioId, aNaive(ini), aNaive(fin)]),
      db.query(`SELECT COALESCE(SUM(monto) FILTER (WHERE metodo_pago IS NOT NULL AND lower(metodo_pago) NOT IN ('efectivo','cash')),0)::float AS digital,
                       COUNT(*)::int AS n
                  FROM transacciones WHERE negocio_id=$1 AND fecha >= $2 AND fecha < $3`, [negocioId, aNaive(ini - GMT), aNaive(fin - GMT)]),
    ]);
    bloques.push({ ini, fin, mp: mp.rows[0].total, nMp: mp.rows[0].n, digital: ven.rows[0].digital, nVentas: ven.rows[0].n });
  }
  const validos = bloques.filter((b) => b.nVentas > 0 && b.nMp > 0);
  if (validos.length < 2) return { evaluado: false, fugas: [] }; // todavia no hay 2 semanas completas para comparar

  const relevantes = validos.filter((b) => {
    const d = b.mp - b.digital;
    return d > MIN_DIF_BLOQUE && d > b.mp * MIN_PCT_BLOQUE;
  });
  const total = relevantes.reduce((s, b) => s + (b.mp - b.digital), 0);
  if (relevantes.length < 2 || total < MIN_TOTAL) return { evaluado: true, fugas: [] };

  const sumMp = validos.reduce((s, b) => s + b.mp, 0);
  const sumDig = validos.reduce((s, b) => s + b.digital, 0);
  const dias = validos.length * DIAS_BLOQUE;
  return {
    evaluado: true,
    fugas: [{
      id: 'mp_vs_caja',
      categoria: 'mercadopago',
      categoria_label: 'Mercado Pago',
      donde: 'Cobros de Mercado Pago',
      titulo: 'Entraron ' + fmt(total) + ' por Mercado Pago que no figuran en tus ventas',
      monto: Math.round(total),
      monto_rango: null,
      monto_tipo: 'medido',
      periodo: 'últimos ' + dias + ' días',
      evidencia: [
        'En ' + relevantes.length + ' de las últimas ' + validos.length + ' semanas entró más plata por Mercado Pago que la registrada como venta digital.',
        'En los últimos ' + dias + ' días Mercado Pago acreditó ' + fmt(sumMp) + ' y las ventas digitales registradas suman ' + fmt(sumDig) + '.',
        'Esto compara contra todas las ventas que no son efectivo (débito, crédito, transferencia, QR y Mercado Pago).',
      ],
      como_corregir: [
        'Cargar cada cobro de Mercado Pago como venta: QR, link de pago, Point y transferencias a la cuenta.',
        'Revisar si hubo ventas cobradas por Mercado Pago que no pasaron por la caja ni se cargaron.',
        'Si usás la misma cuenta de Mercado Pago para plata que no es del negocio, esa plata aparece como diferencia: conviene separar las cuentas.',
        'Si una diferencia tiene una explicación, marcala como descartada para que deje de contar.',
      ],
      recuperado: 0,
      url: '/fugas',
      fuente: 'mercadopago',
    }],
  };
}

// ─── Cobros de Mercado Pago que no figuran como venta (uno por uno) ─────────────────────────────────────
// Mira cada pago aprobado de los últimos 7 días y busca su venta: primero por id de pago o por la referencia de LumoBi,
// y si no, por una venta digital del mismo monto y casi la misma hora (una venta se usa para un solo pago).
// Conservador: solo se evalúa si el negocio carga ventas desde la caja, se ignoran los cobros de los últimos 30 minutos
// (puede estar cargándose) y se necesita 1 cobro grande o 2 cobros. Nunca se nombra a nadie.
const VENTANA_SV_DIAS = 7;
const ESPERA_MIN = 30;
const TOL_MONTO = 0.5;
const TOL_MIN = 45;
const MIN_TOTAL_SV = 3000;
const ORIGENES = { point: 'posnet Point', qr: 'QR', link: 'link de pago', checkout: 'link de pago', transfer: 'transferencia' };
let columnasListas = false;

const fmtFecha = (ms) => {
  const d = new Date(ms - GMT);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
};
const msUtc = (t) => new Date(String(t).replace(' ', 'T') + 'Z').getTime();

async function cobrosSinVenta(negocioId, db, ahora) {
  const tabla = await db.query("SELECT to_regclass('pagos_mp') AS t");
  if (!tabla.rows[0] || !tabla.rows[0].t) return [];
  if (!columnasListas) {
    await db.query('ALTER TABLE pagos_mp ADD COLUMN IF NOT EXISTS origen TEXT');
    await db.query('ALTER TABLE pagos_mp ADD COLUMN IF NOT EXISTS referencia TEXT');
    columnasListas = true;
  }
  const ahoraMs = ahora.getTime();
  // solo negocios que usan la caja de LumoBi (ventas cargadas por empleados en las últimas 2 semanas)
  const caja = await db.query(
    `SELECT COUNT(*)::int AS n FROM transacciones WHERE negocio_id=$1 AND fecha >= $2 AND COALESCE(empleado,'') NOT IN ('', 'importado_mp')`,
    [negocioId, aNaive(ahoraMs - 14 * 86400000 - GMT)]);
  if (!caja.rows[0] || !caja.rows[0].n) return [];

  const desde = ahoraMs - VENTANA_SV_DIAS * 86400000;
  const pagos = (await db.query(
    `SELECT mp_payment_id::text AS id, monto::float AS monto, metodo, origen, referencia, fecha::text AS fecha
       FROM pagos_mp WHERE negocio_id=$1 AND estado='approved' AND fecha >= $2 AND fecha <= $3 ORDER BY fecha`,
    [negocioId, aNaive(desde), aNaive(ahoraMs - ESPERA_MIN * 60000)])).rows;
  if (!pagos.length) return [];
  const ventas = (await db.query(
    `SELECT id, monto::float AS monto, fecha::text AS fecha, mp_payment_id::text AS mp_id, metodo_pago
       FROM transacciones WHERE negocio_id=$1 AND fecha >= $2 AND tipo='venta'`,
    [negocioId, aNaive(desde - 3600000 - GMT)])).rows;
  let refs = new Set();
  try {
    refs = new Set((await db.query("SELECT ref FROM cobros_mp WHERE negocio_id=$1 AND estado='pagado' AND creado >= $2", [negocioId, aNaive(desde - 86400000 - GMT)])).rows.map((r) => r.ref));
  } catch (e) { /* la tabla puede no existir todavía */ }

  const idsConocidos = new Set(ventas.filter((v) => v.mp_id).map((v) => v.mp_id));
  const libres = ventas
    .filter((v) => !v.mp_id && String(v.metodo_pago || '').toLowerCase() !== 'efectivo' && String(v.metodo_pago || '').toLowerCase() !== 'cash')
    // la fecha de una venta puede estar guardada en UTC (caja) o en hora de Argentina (archivos subidos): se acepta cualquiera de las dos
    .map((v) => ({ monto: v.monto, ms: [msUtc(v.fecha), msUtc(v.fecha) + GMT], usada: false }));
  const sinVenta = [];
  for (const p of pagos) {
    if (idsConocidos.has(p.id) || (p.referencia && refs.has(p.referencia))) continue;
    const pms = msUtc(p.fecha);
    const par = libres.find((v) => !v.usada && Math.abs(v.monto - p.monto) <= TOL_MONTO && v.ms.some((m) => Math.abs(m - pms) <= TOL_MIN * 60000));
    if (par) { par.usada = true; continue; }
    sinVenta.push({ id: p.id, monto: p.monto, ms: pms, origen: p.origen || null });
  }
  return sinVenta;
}

async function fugasDeCobrosSinVenta(negocioId, db, ahora) {
  const lista = await cobrosSinVenta(negocioId, db, ahora);
  const total = lista.reduce((s, x) => s + x.monto, 0);
  if (!lista.length || (lista.length < 2 && total < MIN_TOTAL_SV)) return [];
  const orden = [...lista].sort((a, b) => b.monto - a.monto).slice(0, 5);
  const origenDe = (x) => ORIGENES[x.origen] || 'Mercado Pago';
  const una = lista.length === 1;
  return [{
    id: 'mp_cobros_sin_venta',
    categoria: 'mercadopago',
    categoria_label: 'Mercado Pago',
    donde: 'Cobros de Mercado Pago',
    titulo: una
      ? 'Un cobro de ' + fmt(total) + ' por Mercado Pago no figura en tus ventas'
      : lista.length + ' cobros por ' + fmt(total) + ' en Mercado Pago no figuran en tus ventas',
    monto: Math.round(total),
    monto_rango: null,
    monto_tipo: 'medido',
    periodo: 'últimos ' + VENTANA_SV_DIAS + ' días',
    evidencia: [
      ...orden.map((x) => fmtFecha(x.ms) + ' · ' + origenDe(x) + ' · ' + fmt(x.monto)),
      'Se buscó la venta de cada cobro por su id de pago y, si no, por una venta digital del mismo monto y hora parecida.',
    ],
    como_corregir: [
      'Cargar cada cobro como venta. Con el posnet y el QR de la caja de LumoBi, la venta se carga sola.',
      'Si el posnet Point cobra por su cuenta, pasalo a modo integrado desde la caja: así todo lo que cobra pasa por LumoBi.',
      'Si la cuenta de Mercado Pago recibe plata que no es del negocio, marcá la diferencia como descartada.',
    ],
    recuperado: 0,
    url: '/fugas',
    fuente: 'mercadopago',
  }];
}


module.exports = { fugasDeMercadoPago, fugasDeCobrosSinVenta, cobrosSinVenta, BLOQUES, DIAS_BLOQUE };
