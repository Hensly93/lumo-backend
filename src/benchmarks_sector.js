const pool = require('./db');

const DATOS_SECTOR = [
  { tipo_negocio: 'KIOSKO',      metrica: 'ticket_promedio',   valor_min: 2500,   valor_max: 8000,    valor_promedio: 5000   },
  { tipo_negocio: 'KIOSKO',      metrica: 'ratio_efectivo',    valor_min: 0.75,   valor_max: 0.95,    valor_promedio: 0.85   },
  { tipo_negocio: 'KIOSKO',      metrica: 'ventas_por_turno',  valor_min: 15000,  valor_max: 80000,   valor_promedio: 40000  },
  { tipo_negocio: 'ALMACEN',     metrica: 'ticket_promedio',   valor_min: 3000,   valor_max: 10000,   valor_promedio: 6000   },
  { tipo_negocio: 'ALMACEN',     metrica: 'ratio_efectivo',    valor_min: 0.70,   valor_max: 0.90,    valor_promedio: 0.80   },
  { tipo_negocio: 'ALMACEN',     metrica: 'ventas_por_turno',  valor_min: 20000,  valor_max: 100000,  valor_promedio: 55000  },
  { tipo_negocio: 'CAFETERIA',   metrica: 'ticket_promedio',   valor_min: 20000,  valor_max: 45000,   valor_promedio: 30000  },
  { tipo_negocio: 'CAFETERIA',   metrica: 'ratio_efectivo',    valor_min: 0.30,   valor_max: 0.60,    valor_promedio: 0.45   },
  { tipo_negocio: 'CAFETERIA',   metrica: 'ventas_por_turno',  valor_min: 80000,  valor_max: 400000,  valor_promedio: 200000 },
  { tipo_negocio: 'RESTAURANTE', metrica: 'ticket_promedio',   valor_min: 35000,  valor_max: 70000,   valor_promedio: 50000  },
  { tipo_negocio: 'RESTAURANTE', metrica: 'ratio_efectivo',    valor_min: 0.25,   valor_max: 0.55,    valor_promedio: 0.40   },
  { tipo_negocio: 'RESTAURANTE', metrica: 'ventas_por_turno',  valor_min: 150000, valor_max: 800000,  valor_promedio: 400000 },
  { tipo_negocio: 'PARRILLA',    metrica: 'ticket_promedio',   valor_min: 50000,  valor_max: 100000,  valor_promedio: 72000  },
  { tipo_negocio: 'PARRILLA',    metrica: 'ratio_efectivo',    valor_min: 0.30,   valor_max: 0.60,    valor_promedio: 0.45   },
  { tipo_negocio: 'PARRILLA',    metrica: 'ventas_por_turno',  valor_min: 200000, valor_max: 1000000, valor_promedio: 550000 },
  { tipo_negocio: 'PANADERIA',   metrica: 'ticket_promedio',   valor_min: 3000,   valor_max: 12000,   valor_promedio: 7000   },
  { tipo_negocio: 'PANADERIA',   metrica: 'ratio_efectivo',    valor_min: 0.65,   valor_max: 0.90,    valor_promedio: 0.78   },
  { tipo_negocio: 'PANADERIA',   metrica: 'ventas_por_turno',  valor_min: 30000,  valor_max: 150000,  valor_promedio: 80000  },
  { tipo_negocio: 'FARMACIA',    metrica: 'ticket_promedio',   valor_min: 8000,   valor_max: 30000,   valor_promedio: 18000  },
  { tipo_negocio: 'FARMACIA',    metrica: 'ratio_efectivo',    valor_min: 0.20,   valor_max: 0.50,    valor_promedio: 0.35   },
  { tipo_negocio: 'FARMACIA',    metrica: 'ventas_por_turno',  valor_min: 50000,  valor_max: 300000,  valor_promedio: 150000 },
  { tipo_negocio: 'RETAIL',      metrica: 'ticket_promedio',   valor_min: 15000,  valor_max: 60000,   valor_promedio: 35000  },
  { tipo_negocio: 'RETAIL',      metrica: 'ratio_efectivo',    valor_min: 0.15,   valor_max: 0.45,    valor_promedio: 0.30   },
  { tipo_negocio: 'RETAIL',      metrica: 'ventas_por_turno',  valor_min: 40000,  valor_max: 250000,  valor_promedio: 120000 },
];

async function poblarBenchmarksSector() {
  for (const d of DATOS_SECTOR) {
    await pool.query(
      `INSERT INTO benchmarks_sector(tipo_negocio, metrica, valor_min, valor_max, valor_promedio, fuente)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tipo_negocio, metrica) DO UPDATE SET
         valor_min=EXCLUDED.valor_min,
         valor_max=EXCLUDED.valor_max,
         valor_promedio=EXCLUDED.valor_promedio,
         updated_at=NOW()`,
      [d.tipo_negocio, d.metrica, d.valor_min, d.valor_max, d.valor_promedio, 'Maxirest/CAME abril 2026']
    );
  }
}

async function getBenchmarkSector(tipoNegocio) {
  const result = await pool.query(
    'SELECT * FROM benchmarks_sector WHERE tipo_negocio = $1',
    [tipoNegocio.toUpperCase()]
  );
  const benchmarks = {};
  result.rows.forEach(r => { benchmarks[r.metrica] = r; });
  return benchmarks;
}

// Valores canónicos aceptados por el sistema (vienen de tipo_negocio en usuarios)
const TIPOS_VALIDOS = ['kiosko', 'almacen', 'cafeteria_bar', 'restaurante', 'panaderia', 'farmacia', 'retail_indumentaria', 'parrilla'];

const MAP_CANONICO = {
  kiosko:               'KIOSKO',
  almacen:              'ALMACEN',
  cafeteria_bar:        'CAFETERIA',
  restaurante:          'RESTAURANTE',
  panaderia:            'PANADERIA',
  farmacia:             'FARMACIA',
  retail_indumentaria:  'RETAIL',
  parrilla:             'PARRILLA',
};

function normalizarTipoNegocio(negocio) {
  if (!negocio) return null;
  const canónico = MAP_CANONICO[negocio.toLowerCase().trim()];
  if (canónico) return canónico;

  // Fallback fuzzy para el campo libre `negocio` de usuarios legacy
  const n = negocio.toUpperCase();
  if (n.includes('KIOSK') || n.includes('KIOSCO'))                                               return 'KIOSKO';
  if (n.includes('ALMAC'))                                                                        return 'ALMACEN';
  if (n.includes('CAFE') || n.includes('BAR'))                                                   return 'CAFETERIA';
  if (n.includes('RESTAURANT') || n.includes('RESTAU'))                                          return 'RESTAURANTE';
  if (n.includes('PARRILL') || n.includes('ASAD'))                                               return 'PARRILLA';
  if (n.includes('PANAD') || n.includes('BOLLERIA'))                                             return 'PANADERIA';
  if (n.includes('FARMAC') || n.includes('DROGU'))                                               return 'FARMACIA';
  if (n.includes('RETAIL') || n.includes('INDUMENT') || n.includes('ROPA') || n.includes('TIEND')) return 'RETAIL';
  return null;
}

// Trata el rango min-max como ±2σ de una distribución normal → std_estimada = rango / 4
function calcularZScoreSector(valor, benchmark) {
  const std_estimada = (Number(benchmark.valor_max) - Number(benchmark.valor_min)) / 4;
  if (std_estimada === 0) return 0;
  return (valor - Number(benchmark.valor_promedio)) / std_estimada;
}

module.exports = { poblarBenchmarksSector, getBenchmarkSector, normalizarTipoNegocio, calcularZScoreSector, TIPOS_VALIDOS };
