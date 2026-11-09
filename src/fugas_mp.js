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

module.exports = { fugasDeMercadoPago, BLOQUES, DIAS_BLOQUE };
