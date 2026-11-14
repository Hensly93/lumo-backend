// rearmar_db.js — LumoBi · arma una base de datos vacía con toda la estructura (o pone al día una existente).
// Uso: DATABASE_URL=... node src/rearmar_db.js
// Corre en orden: setup.js (tablas de origen) → migrations/*.sql (salteando las de datos de prueba)
// → migraciones_arranque.js. Todo es "si no existe": no borra ni pisa datos.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SALTEAR = [/_seed_/i]; // datos de prueba, nunca en una base real

async function main() {
  execFileSync(process.execPath, [path.join(__dirname, 'setup.js')], { stdio: 'inherit', env: process.env });
  const pool = require('./db');
  const dir = path.join(__dirname, '..', 'migrations');
  const archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let errores = 0;
  for (const f of archivos) {
    if (SALTEAR.some((r) => r.test(f))) { console.log('-- salteo', f); continue; }
    // los comandos de psql (\echo, \dt) no son SQL: se sacan
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('\\')).join('\n');
    try {
      await pool.query(sql);
      console.log('ok', f);
    } catch (e) {
      errores++;
      console.error('ERROR', f, e.message);
    }
  }
  await require('./migraciones_arranque').ejecutar();
  console.log(errores ? `Terminado con ${errores} errores` : 'Base al dia');
  await pool.end();
  process.exit(errores ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
