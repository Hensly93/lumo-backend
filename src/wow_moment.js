// wow_moment.js (v2)
// Patrones del negocio calculados SOLO con sus datos reales, en hora de Argentina.
// Lee por negocio (no por usuario) y usa los ultimos 30 dias de datos que haya,
// aunque el historial sea viejo. No usa estadisticas inventadas ni benchmarks escritos a mano.
const pool = require('./db');

const TZ = 'America/Argentina/Buenos_Aires';
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const peso = (n) => '$' + Math.round(n).toLocaleString('es-AR');
const pct = (n) => Math.round(n);

function sumarDias(dia, n) {
  const d = new Date(dia + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diaSemana(dia) {
  return new Date(dia + 'T12:00:00Z').getUTCDay();
}
function ddmm(dia) {
  const p = dia.split('-');
  return p[2] + '/' + p[1];
}

async function negocioDe(db, usuario_id) {
  try {
    const r = await db.query('SELECT negocio_id FROM negocio_usuarios WHERE usuario_id=$1 LIMIT 1', [usuario_id]);
    if (r.rows[0] && r.rows[0].negocio_id) return r.rows[0].negocio_id;
  } catch (e) { /* tabla o columna distinta: se prueba la otra via */ }
  try {
    const r = await db.query('SELECT id FROM negocios WHERE created_by=$1 ORDER BY id LIMIT 1', [usuario_id]);
    if (r.rows[0]) return r.rows[0].id;
  } catch (e) { /* sin negocio */ }
  return null;
}

async function patronesBasicos(usuario_id, db = pool, negocioForzado = null) {
  try {
    const negocio_id = negocioForzado || await negocioDe(db, usuario_id);

    const txRes = await db.query(
      `SELECT t.monto::float AS monto, t.metodo_pago,
              to_char((t.fecha AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS dia,
              EXTRACT(HOUR FROM (t.fecha AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::int AS hora
         FROM transacciones t
        WHERE (t.negocio_id = $1 OR (t.negocio_id IS NULL AND t.usuario_id = $2))
          AND COALESCE(t.origin, 'real') IN ('real', 'importado')
          AND t.monto > 0
        ORDER BY t.fecha DESC
        LIMIT 20000`,
      [negocio_id, usuario_id]
    );

    const todas = txRes.rows;
    if (todas.length === 0) {
      return { patrones: [], mensaje: 'Todavía no hay ventas. Abrí la caja del local y cobrá la primera venta: desde el primer turno cerrado LumoBi empieza a contarte qué pasa en tu negocio.' };
    }

    const hasta = todas[0].dia;
    const desde = sumarDias(hasta, -29);
    const filas = todas.filter((r) => r.dia >= desde);

    const totalPorDia = new Map();
    filas.forEach((r) => totalPorDia.set(r.dia, (totalPorDia.get(r.dia) || 0) + r.monto));
    const nDias = totalPorDia.size;

    if (filas.length < 10 || nDias < 3) {
      return {
        patrones: [],
        mensaje: 'Necesitamos al menos 10 ventas en 3 días distintos para encontrar patrones. Hoy hay ' + filas.length + ' ventas en ' + nDias + ' día(s).',
        resumen: { ventas: filas.length, dias: nDias, desde: desde, hasta: hasta },
      };
    }

    const totalGeneral = filas.reduce((a, r) => a + r.monto, 0);
    const ventanaDias = Math.max(1, Math.round((new Date(hasta + 'T12:00:00Z') - new Date(desde + 'T12:00:00Z')) / 86400000) + 1);
    const confianza = Math.min(90, 40 + nDias * 2);
    const advertencia = 'Lectura preliminar con ' + nDias + ' días de datos. Con más historial, NICOLE la afina.';
    const patrones = [];

    // A. Dia de la semana: promedio vendido por dia (no ticket promedio)
    const porDow = {};
    totalPorDia.forEach((total, dia) => {
      const d = diaSemana(dia);
      (porDow[d] = porDow[d] || []).push(total);
    });
    const dows = Object.keys(porDow).filter((d) => porDow[d].length >= 2).map((d) => {
      const v = porDow[d];
      return { dia: Number(d), prom: v.reduce((a, b) => a + b, 0) / v.length, n: v.length };
    });
    if (dows.length >= 2) {
      dows.sort((a, b) => b.prom - a.prom);
      const mejor = dows[0];
      const peor = dows[dows.length - 1];
      const dif = mejor.prom - peor.prom;
      const p = peor.prom > 0 ? (dif / peor.prom) * 100 : 0;
      if (p >= 10) {
        patrones.push({
          id: 'dia_semana',
          icono: '',
          titulo: cap(DIAS[mejor.dia]) + ' es tu día más fuerte: vende ' + pct(p) + '% más que ' + DIAS[peor.dia],
          descripcion: 'En promedio, un ' + DIAS[mejor.dia] + ' vendés ' + peso(mejor.prom) + ' (sobre ' + mejor.n + ' días) y un ' + DIAS[peor.dia] + ' ' + peso(peor.prom) + ' (sobre ' + peor.n + ' días).',
          duele: 'Cada ' + DIAS[peor.dia] + ' vendés en promedio ' + peso(dif) + ' menos que cada ' + DIAS[mejor.dia] + '.',
          recomendacion: 'Mirá qué pasa los ' + DIAS[peor.dia] + ': personal, horarios abiertos, stock o promociones. Confirmalo con más semanas antes de cambiar algo grande.',
          advertencia: advertencia,
          impacto_pesos: dif,
          confianza: confianza,
          detalle: { mejor_dia: DIAS[mejor.dia], mejor_promedio: Math.round(mejor.prom), peor_dia: DIAS[peor.dia], peor_promedio: Math.round(peor.prom), diferencia_diaria: Math.round(dif), ventas_analizadas: filas.length },
        });
      }
    }

    // B. Franja horaria
    const FRANJAS = [
      { id: 'madrugada', nombre: 'la madrugada (0 a 6 h)', desde: 0, hasta: 5 },
      { id: 'manana', nombre: 'la mañana (6 a 12 h)', desde: 6, hasta: 11 },
      { id: 'tarde', nombre: 'la tarde (12 a 18 h)', desde: 12, hasta: 17 },
      { id: 'noche', nombre: 'la noche (18 a 24 h)', desde: 18, hasta: 23 },
    ].map((f) => ({ ...f, total: 0, n: 0 }));
    filas.forEach((r) => {
      const f = FRANJAS.find((x) => r.hora >= x.desde && r.hora <= x.hasta);
      if (f) { f.total += r.monto; f.n += 1; }
    });
    const franjas = FRANJAS.filter((f) => f.n >= 3).sort((a, b) => b.total - a.total);
    if (franjas.length >= 2) {
      const mejor = franjas[0];
      const peor = franjas[franjas.length - 1];
      const base = franjas.reduce((a, f) => a + f.total, 0);
      const pMejor = (mejor.total / base) * 100;
      const pPeor = (peor.total / base) * 100;
      const gap = ((mejor.total - peor.total) * 30) / ventanaDias;
      patrones.push({
        id: 'turno_peak',
        icono: '',
        titulo: cap(mejor.nombre) + ' concentra el ' + pct(pMejor) + '% de tus ventas',
        descripcion: franjas.map((f) => cap(f.nombre) + ': ' + peso(f.total) + ' (' + pct((f.total / base) * 100) + '%)').join('. ') + '.',
        duele: cap(peor.nombre) + ' es la franja más baja: aporta el ' + pct(pPeor) + '% de lo que vendés.',
        recomendacion: 'Revisá si ' + peor.nombre + ' tiene la dotación y el stock que necesita. NICOLE lo va a seguir midiendo turno a turno.',
        advertencia: advertencia,
        impacto_pesos: gap,
        confianza: confianza,
        detalle: { franjas: franjas.map((f) => ({ franja: f.id, total: Math.round(f.total), ventas: f.n })) },
      });
    }

    // C. Mix de cobro (sin comparar contra valores inventados del sector)
    const conMedio = filas.filter((r) => r.metodo_pago && String(r.metodo_pago).trim() !== '');
    if (conMedio.length >= 20) {
      let ef = 0;
      let dig = 0;
      conMedio.forEach((r) => {
        const m = String(r.metodo_pago || '').toLowerCase();
        if (m.includes('efectivo') || m === 'cash') ef += r.monto; else dig += r.monto;
      });
      const pEf = (ef / (ef + dig)) * 100;
      patrones.push({
        id: 'efectivo_digital',
        icono: '',
        titulo: pct(pEf) + '% de tus ventas se cobra en efectivo',
        descripcion: 'Efectivo: ' + peso(ef) + '. Digital (Mercado Pago, tarjetas, transferencias): ' + peso(dig) + '.',
        duele: pEf >= 60 ? 'Con tanto efectivo, controlar la caja de cada turno es lo que más protege tu plata.' : 'Buena parte de tus ventas queda registrada digitalmente, lo que facilita el control.',
        recomendacion: 'Cerrá cada turno con el conteo de caja: NICOLE compara lo vendido con lo que entra.',
        advertencia: advertencia,
        impacto_pesos: 0,
        confianza: confianza,
        detalle: { pct_efectivo: Math.round(pEf * 10) / 10, total_efectivo: Math.round(ef), total_digital: Math.round(dig) },
      });
    }

    // D. Ultimos 7 dias contra los 7 anteriores (sobre el tramo final de datos)
    const ini7 = sumarDias(hasta, -6);
    const ini14 = sumarDias(hasta, -13);
    let rec = 0; let ant = 0; const dRec = new Set(); const dAnt = new Set();
    filas.forEach((r) => {
      if (r.dia >= ini7) { rec += r.monto; dRec.add(r.dia); }
      else if (r.dia >= ini14) { ant += r.monto; dAnt.add(r.dia); }
    });
    // Se compara por día con ventas: si la semana anterior tiene menos días cargados no parece una suba
    if (dRec.size >= 3 && dAnt.size >= 3 && ant > 0) {
      rec = (rec / dRec.size) * 7; ant = (ant / dAnt.size) * 7;
      const cambio = rec - ant;
      const p = (cambio / ant) * 100;
      if (Math.abs(p) >= 8) {
        const baja = cambio < 0;
        patrones.push({
          id: 'tendencia_semanal',
          icono: '',
          titulo: 'Los últimos 7 días vendiste ' + pct(Math.abs(p)) + '% ' + (baja ? 'menos' : 'más') + ' que los 7 anteriores',
          descripcion: 'Del ' + ddmm(ini7) + ' al ' + ddmm(hasta) + ': ' + peso(rec) + '. Del ' + ddmm(ini14) + ' al ' + ddmm(sumarDias(ini7, -1)) + ': ' + peso(ant) + '.',
          duele: baja ? 'Son ' + peso(Math.abs(cambio)) + ' menos en una semana.' : 'Son ' + peso(cambio) + ' más en una semana.',
          recomendacion: baja
            ? 'Mirá qué cambió: personal, horarios, stock o clima. Si se repite otra semana, conviene actuar.'
            : 'Identificá qué funcionó (promoción, horario, producto) para repetirlo.',
          advertencia: advertencia,
          impacto_pesos: Math.abs(cambio),
          confianza: confianza,
          detalle: { ultimos_7: Math.round(rec), anteriores_7: Math.round(ant), cambio_pesos: Math.round(cambio), hasta: hasta },
        });
      }
    }

    // E. Hora pico (2 horas seguidas), solo si hay horarios reales distintos
    const porHora = new Array(24).fill(0);
    const horasVistas = new Set();
    filas.forEach((r) => { porHora[r.hora] += r.monto; horasVistas.add(r.hora); });
    if (filas.length >= 30 && horasVistas.size >= 4) {
      let mejorH = 0; let mejorV = -1;
      for (let h = 0; h < 23; h++) {
        const v = porHora[h] + porHora[h + 1];
        if (v > mejorV) { mejorV = v; mejorH = h; }
      }
      const p = (mejorV / totalGeneral) * 100;
      if (p >= 25) {
        patrones.push({
          id: 'hora_pico',
          icono: '',
          titulo: 'Entre las ' + mejorH + ' y las ' + (mejorH + 2) + ' h se concentra el ' + pct(p) + '% de tus ventas',
          descripcion: 'Son ' + peso(mejorV) + ' de ' + peso(totalGeneral) + ' en ' + nDias + ' días.',
          duele: 'Es la franja donde una caja cerrada o un faltante de stock más te cuesta.',
          recomendacion: 'Asegurate de tener todas las cajas abiertas y la mercadería lista en esa franja.',
          advertencia: advertencia,
          impacto_pesos: 0,
          confianza: confianza,
          detalle: { desde_hora: mejorH, hasta_hora: mejorH + 2, total: Math.round(mejorV) },
        });
      }
    }

    patrones.sort((a, b) => b.impacto_pesos - a.impacto_pesos);
    return {
      patrones: patrones.slice(0, 3),
      mensaje: patrones.length === 0 ? 'Cargamos tus ventas y todavía no vemos diferencias marcadas. Con más semanas de datos aparecen los patrones.' : undefined,
      resumen: { ventas: filas.length, dias: nDias, desde: desde, hasta: hasta, total: Math.round(totalGeneral) },
    };
  } catch (e) {
    console.error('[WOW_MOMENT ERROR]', e);
    return { patrones: [], error: e.message };
  }
}

// v3 (14/11/2026): primero los hallazgos con plata (hallazgos_wow.js); los patrones básicos completan.
async function calculateWowMoment(usuario_id, db = pool, negocioId = null) {
  const negocio_id = negocioId || await negocioDe(db, usuario_id);
  const [nuevos, basicos] = await Promise.all([
    require('./hallazgos_wow').hallazgosWow(negocio_id, db).catch((e) => { console.error('[wow] v3:', e.message); return []; }),
    patronesBasicos(usuario_id, db, negocio_id),
  ]);
  const ids = new Set(nuevos.map((h) => h.id));
  // concentracion_pico y hora_pico dicen lo mismo: queda el nuevo
  const resto = (basicos.patrones || []).filter((p) => !ids.has(p.id) && !(ids.has('concentracion_pico') && p.id === 'hora_pico'));
  const patrones = [...nuevos, ...resto];
  return {
    ...basicos,
    patrones,
    mensaje: patrones.length ? undefined : basicos.mensaje,
  };
}

module.exports = { calculateWowMoment };
