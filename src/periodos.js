#### transacciones ####
                                        Tabla «public.transacciones»
    Columna    |            Tipo             | Ordenamiento | Nulable  |                 Por omisi                 
---------------+-----------------------------+--------------+----------+-------------------------------------------
 id            | integer                     |              | not null | nextval('transacciones_id_seq'::regclass)
 usuario_id    | integer                     |              |          | 
 monto         | numeric(10,2)               |              |          | 
 tipo          | character varying(50)       |              |          | 
 empleado      | character varying(100)      |              |          | 
 turno         | character varying(50)       |              |          | 
 fecha         | timestamp without time zone |              |          | now()
 metodo_pago   | text                        |              |          | 
 mp_payment_id | bigint                      |              |          | 
 origin        | character varying(50)       |              |          | 'real'::character varying
 sucursal_id   | integer                     |              |          | 
 negocio_id    | integer                     |              | not null | 
Índices:
    "transacciones_pkey" PRIMARY KEY, btree (id)
    "idx_tx_mp_payment" UNIQUE, btree (usuario_id, mp_payment_id) WHERE mp_payment_id IS NOT NULL
Restricciones de llave foránea:
    "transacciones_negocio_id_fkey" FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE CASCADE
    "transacciones_sucursal_id_fkey" FOREIGN KEY (sucursal_id) REFERENCES mis_sucursales(id)
    "transacciones_usuario_id_fkey" FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
Referenciada por:
    TABLE "transacciones_detalle" CONSTRAINT "transacciones_detalle_transaccion_id_fkey" FOREIGN KEY (transaccion_id) REFERENCES transacciones(id)

#### muestra ####
     origin      | metodo_pago  | count |   desde    |   hasta    
-----------------+--------------+-------+------------+------------
 seed_prediccion | efectivo     |   918 | 2026-09-28 | 2026-10-27
 seed_prediccion | mp           |   738 | 2026-09-28 | 2026-10-27
 real            | efectivo     |    35 | 2026-06-25 | 2026-10-29
 real            | mercado_pago |    16 | 2026-06-25 | 2026-07-05
 real            | mp           |     1 | 2026-08-25 | 2026-08-25
(5 filas)

#### turnos ####
                                                Tabla «public.turnos_caja»
           Columna            |            Tipo             | Ordenamiento | Nulable  |                Por omisi                
------------------------------+-----------------------------+--------------+----------+-----------------------------------------
 id                           | integer                     |              | not null | nextval('turnos_caja_id_seq'::regclass)
 usuario_id                   | integer                     |              |          | 
 nombre_empleado              | character varying(100)      |              | not null | 
 tipo_turno                   | character varying(20)       |              | not null | 
 caja_apertura                | numeric(12,2)               |              | not null | 
 caja_cierre                  | numeric(12,2)               |              |          | 
 caja_esperada                | numeric(12,2)               |              |          | 
 brecha                       | numeric(12,2)               |              |          | 
 hora_apertura                | timestamp without time zone |              |          | now()
 hora_cierre                  | timestamp without time zone |              |          | 
 estado                       | character varying(20)       |              |          | 'activo'::character varying
 conteo_aleatorio_hora        | timestamp without time zone |              |          | 
 conteo_aleatorio_respondido  | boolean                     |              |          | false
 conteo_aleatorio_omitido     | boolean                     |              |          | false
 conteo_aleatorio2_hora       | timestamp without time zone |              |          | 
 conteo_aleatorio2_respondido | boolean                     |              |          | false
 conteo_aleatorio2_omitido    | boolean                     |              |          | false
 gasto_inesperado             | boolean                     |              |          | false
 sucursal_id                  | integer                     |              |          | 
 negocio_id                   | integer                     |              | not null | 
 sesion_token_hash            | text                        |              |          | 
Índices:
    "turnos_caja_pkey" PRIMARY KEY, btree (id)
    "idx_turnos_caja_sesion_token" btree (sesion_token_hash) WHERE sesion_token_hash IS NOT NULL
Restricciones de llave foránea:
    "turnos_caja_negocio_id_fkey" FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE CASCADE
    "turnos_caja_sucursal_id_fkey" FOREIGN KEY (sucursal_id) REFERENCES mis_sucursales(id)
    "turnos_caja_usuario_id_fkey" FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
Referenciada por:
    TABLE "carrito_items" CONSTRAINT "carrito_items_turno_id_fkey" FOREIGN KEY (turno_id) REFERENCES turnos_caja(id)
    TABLE "conteos_caja" CONSTRAINT "conteos_caja_turno_id_fkey" FOREIGN KEY (turno_id) REFERENCES turnos_caja(id)
    TABLE "egresos_caja" CONSTRAINT "egresos_caja_turno_id_fkey" FOREIGN KEY (turno_id) REFERENCES turnos_caja(id)
    TABLE "sesiones_scanner" CONSTRAINT "sesiones_scanner_turno_id_fkey" FOREIGN KEY (turno_id) REFERENCES turnos_caja(id)

#### dashboard: quÃ© endpoints usa ####
grep: Invalid range end
