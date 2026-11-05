// precios.js — Formula del abono de LumoBi. Es la UNICA fuente de verdad del precio.
//
// Plan normal:
//   base $45.000 (1 local, hasta 3 cajas)
//   + cajas extra: $7.500 cada una a partir de la 4.a, contadas POR LOCAL (cada local trae 3 incluidas)
//   + locales extra: 2.o +$40.000, 3.o +$35.000, 4.o +$30.000
//   + empleados: hasta 5 incluidos; 6-10 +$6.000; 11-20 +$12.000; 21-29 +$20.000 (cada escalon se cobra una vez)
// Plan EMPRESARIAL (precio a medida): 6 cajas o mas en UN local, 5 locales o mas, o 30 empleados o mas.

const BASE = 45000;
const CAJAS_INCLUIDAS_POR_LOCAL = 3;
const PRECIO_CAJA_EXTRA = 7500;
const LOCAL_EXTRA = [40000, 35000, 30000]; // 2.o, 3.o y 4.o local
const ESCALONES_EMPLEADOS = [
  { hasta: 5, extra: 0 },
  { hasta: 10, extra: 6000 },
  { hasta: 20, extra: 12000 },
  { hasta: 29, extra: 20000 },
];
const EMPRESARIAL = { cajas_en_un_local: 6, locales: 5, empleados: 30 };

// cajasPorLocal: arreglo con la cantidad de cajas de cada local activo. Ej: [3, 2]
// empleados: cantidad de empleados activos
function calcularPrecio(cajasPorLocal, empleados) {
  let cajas = Array.isArray(cajasPorLocal)
    ? cajasPorLocal.map((c) => Math.max(1, Math.floor(Number(c) || 1)))
    : [];
  if (cajas.length === 0) cajas = [1];
  const emp = Math.max(0, Math.floor(Number(empleados) || 0));

  // ¿Empresarial?
  const motivos = [];
  if (Math.max.apply(null, cajas) >= EMPRESARIAL.cajas_en_un_local) {
    motivos.push('Tiene ' + EMPRESARIAL.cajas_en_un_local + ' cajas o mas en un mismo local');
  }
  if (cajas.length >= EMPRESARIAL.locales) {
    motivos.push('Tiene ' + EMPRESARIAL.locales + ' locales o mas');
  }
  if (emp >= EMPRESARIAL.empleados) {
    motivos.push('Tiene ' + EMPRESARIAL.empleados + ' empleados o mas');
  }
  if (motivos.length > 0) {
    return {
      plan: 'empresarial',
      precio: null,
      desglose: [],
      motivos_empresarial: motivos,
      locales: cajas.length,
      cajas_por_local: cajas,
      empleados: emp,
    };
  }

  const desglose = [{ concepto: 'Plan base (1 local, hasta 3 cajas)', monto: BASE }];
  let total = BASE;

  // cajas extra, por local
  let cajasExtra = 0;
  cajas.forEach((c) => {
    if (c > CAJAS_INCLUIDAS_POR_LOCAL) cajasExtra += c - CAJAS_INCLUIDAS_POR_LOCAL;
  });
  if (cajasExtra > 0) {
    const monto = cajasExtra * PRECIO_CAJA_EXTRA;
    desglose.push({ concepto: cajasExtra + (cajasExtra === 1 ? ' caja extra' : ' cajas extra'), monto: monto });
    total += monto;
  }

  // locales extra
  for (let i = 1; i < cajas.length; i++) {
    const monto = LOCAL_EXTRA[i - 1];
    desglose.push({ concepto: 'Local ' + (i + 1), monto: monto });
    total += monto;
  }

  // empleados
  for (let i = 0; i < ESCALONES_EMPLEADOS.length; i++) {
    if (emp <= ESCALONES_EMPLEADOS[i].hasta) {
      const extra = ESCALONES_EMPLEADOS[i].extra;
      if (extra > 0) {
        desglose.push({ concepto: emp + ' empleados', monto: extra });
        total += extra;
      }
      break;
    }
  }

  return {
    plan: 'normal',
    precio: total,
    desglose: desglose,
    motivos_empresarial: [],
    locales: cajas.length,
    cajas_por_local: cajas,
    empleados: emp,
  };
}

// Combina lo REAL (locales/cajas/empleados cargados en el sistema) con lo DECLARADO al registrarse.
// Manda el mayor de los dos: asi nadie paga de menos declarando menos, y el que declara de mas empieza con ese piso.
function efectivo(cajasReales, empleadosReales, declarado) {
  const d = declarado || {};
  const reales = Array.isArray(cajasReales) ? cajasReales : [];
  const nLocales = Math.max(reales.length, Math.floor(Number(d.locales) || 0), 1);
  const cajasDecl = Math.floor(Number(d.cajas) || 0);
  const cajas = [];
  for (let i = 0; i < nLocales; i++) {
    const real = i < reales.length ? Math.floor(Number(reales[i]) || 1) : 1;
    cajas.push(Math.max(real, cajasDecl, 1));
  }
  const empleados = Math.max(Math.floor(Number(empleadosReales) || 0), Math.floor(Number(d.empleados) || 0));
  return { cajas: cajas, empleados: empleados };
}

module.exports = { calcularPrecio, efectivo, BASE, EMPRESARIAL };
