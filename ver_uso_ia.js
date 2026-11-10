// ver_uso_ia.js — muestra cuanto gasto de IA lleva cada negocio en el mes (solo lectura).
// Uso (desde backend):  node.exe ver_uso_ia.js
try { require('dotenv').config(); } catch (_) {}
const ia = require('./src/ia_presupuesto');
(async () => {
  console.log('Presupuesto de IA por negocio y por mes: USD ' + ia.PRESUPUESTO_USD.toFixed(2));
  const filas = await ia.resumenMes();
  if (filas.length === 0) console.log('Todavia no hay consumo anotado este mes.');
  filas.forEach(f => console.log('negocio ' + f.negocio_id + ': ' + f.llamadas + ' llamadas, USD ' + f.usd.toFixed(3) + ' (' + f.pct_presupuesto + '% del presupuesto)'));
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
