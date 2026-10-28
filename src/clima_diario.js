// clima_diario.js — guarda en clima_historico el clima de los últimos días de cada
// sucursal con coordenadas. Lo corre el job nocturno antes de calcular predicciones.
// Nunca tira error: si algo falla lo informa en el resultado del paso.
const https = require('https');

function etiqueta(p, t) {
  if (p >= 5) return 'lluvia';
  if (t >= 35) return 'calor_extremo';
  if (t <= 5) return 'frio_extremo';
  return 'normal';
}

function getJSON(url, timeoutMs = 8000) {
  return new Promise((ok) => {
    const t = setTimeout(() => ok(null), timeoutMs);
    https.get(url, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => { clearTimeout(t); try { ok(JSON.parse(d)); } catch { ok(null); } });
    }).on('error', () => { clearTimeout(t); ok(null); });
  });
}

async function guardarClimaReciente(db, diasAtras = 3) {
  const res = { paso: 'clima_diario', sucursales: 0, insertadas: 0, errores: 0 };
  try {
    const hoy = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const { rows } = await db.query(
      `SELECT id, latitud, longitud FROM mis_sucursales WHERE latitud IS NOT NULL AND longitud IS NOT NULL`);
    res.sucursales = rows.length;
    for (const s of rows) {
      const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${s.latitud}&longitude=${s.longitud}` +
        `&daily=precipitation_sum,temperature_2m_max&timezone=America%2FArgentina%2FBuenos_Aires&past_days=${diasAtras}&forecast_days=1`);
      if (!j?.daily?.time) { res.errores++; continue; }
      for (let i = 0; i < j.daily.time.length; i++) {
        const fecha = j.daily.time[i];
        if (fecha >= hoy) continue;
        const p = j.daily.precipitation_sum?.[i] ?? 0;
        const t = j.daily.temperature_2m_max?.[i] ?? 20;
        const r = await db.query(
          `INSERT INTO clima_historico(sucursal_id, fecha, clima, precipitacion_mm, temp_max)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT (sucursal_id, fecha) DO NOTHING`,
          [s.id, fecha, etiqueta(p, t), p, t]);
        res.insertadas += r.rowCount;
      }
    }
  } catch (e) {
    res.errores++;
    res.error = e.message;
  }
  console.log('[JOB NOCTURNO] clima_diario:', JSON.stringify(res));
  return res;
}

module.exports = { guardarClimaReciente };
