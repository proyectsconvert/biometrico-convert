-- Migración 0051: Reproceso del histórico en segundo plano, con reintentos y sin duplicados
-- 1. Reparación: varios archivos quedaron con su capa cruda cargada varias veces (reintentos que
--    se solaparon cuando Cloudflare cortaba a los 100 s mientras el servidor seguía insertando).
--    Se dejan una sola vez por línea del CSV y se marca el contador real.
-- 2. Cada línea de un archivo existe una sola vez en la capa cruda (índice único): un lote que se
--    reintenta ya no duplica filas.
-- 3. Trabajos de reproceso: estado por archivo y por tramo, para reanudar tras un error o un
--    reinicio del servidor, y para seguir el avance aunque se cierre la pestaña.

/* ---------- 1. Reparación de la capa cruda duplicada ---------- */
-- Solo los archivos con más filas crudas que líneas tiene el CSV
create temp table _conteo_crudo on commit drop as
  select import_id, count(*) as n from public.biometric_raw group by import_id;
delete from public.biometric_raw r
using (
  select id from (
    select id, row_number() over (partition by import_id, line_no order by id) as k
    from public.biometric_raw
    where import_id in (select c.import_id from _conteo_crudo c join public.biometric_imports i on i.id = c.import_id where c.n > i.rows_found)
  ) x where x.k > 1
) d
where r.id = d.id;

/* ---------- 2. Una línea del CSV = una fila cruda ---------- */
drop index if exists public.biometric_raw_import_idx;
create unique index if not exists biometric_raw_import_linea on public.biometric_raw (import_id, line_no);

-- El contador refleja lo que realmente hay; si falta algo (rows_found mayor) el reproceso lo relee
update public.biometric_imports i set rows_raw = x.n
from (select import_id, count(*) as n from public.biometric_raw group by import_id) x
where x.import_id = i.id and i.rows_raw is distinct from x.n;

create or replace function public.cargar_crudo(_import_id uuid, _filas jsonb)
returns integer language plpgsql security definer set search_path = public as $function$
declare v_tenant uuid; n integer;
begin
  select tenant_id into v_tenant from public.biometric_imports where id = _import_id;
  if v_tenant is null then raise exception 'Importación no encontrada'; end if;
  if coalesce(auth.role(),'') <> 'service_role'
     and not (public.tenant_visible(v_tenant) and public.has_permission('importaciones','importar')) then
    raise exception 'Sin permiso para importar';
  end if;
  insert into public.biometric_raw
    (tenant_id, import_id, line_no, event_at, door, device_code, device_name, user_group, raw_user, document, biometric_name, event_type)
  select v_tenant, _import_id, (r->>0)::int, (r->>1)::timestamp, nullif(r->>2,''), r->>3, nullif(r->>4,''), nullif(r->>5,''),
         nullif(r->>6,''),
         nullif(regexp_replace(coalesce(m[1], r->>6, ''), '\D', '', 'g'), ''),
         upper(trim(m[2])),
         coalesce(r->>7, '')
  from jsonb_array_elements(_filas) r
  left join lateral regexp_match(r->>6, '^\s*([0-9A-Za-z.\-]+)\s*\((.+)\)\s*$') m on true
  where nullif(r->>1,'') is not null and nullif(r->>3,'') is not null
  -- reintentar un lote no duplica: cada línea del archivo entra una sola vez
  on conflict (import_id, line_no) do nothing;
  get diagnostics n = row_count;
  return n;
end $function$;
revoke execute on function public.cargar_crudo(uuid, jsonb) from public, anon;
grant execute on function public.cargar_crudo(uuid, jsonb) to authenticated, service_role;

-- Filas crudas por archivo (para verificar que cada archivo está completo)
create or replace function public.conteo_crudo_por_archivo(_tenant uuid)
returns table(import_id uuid, filas bigint) language sql stable security definer set search_path = public as $$
  select r.import_id, count(*) from public.biometric_raw r where r.tenant_id = _tenant group by r.import_id;
$$;
revoke execute on function public.conteo_crudo_por_archivo(uuid) from public, anon, authenticated;
grant execute on function public.conteo_crudo_por_archivo(uuid) to service_role;

/* ---------- 3. Trabajos de reproceso ---------- */
create table if not exists public.reprocess_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  modo text not null default 'completo' check (modo in ('completo', 'verificar')),
  releer_todo boolean not null default false,
  status text not null default 'en_curso' check (status in ('en_curso', 'completado', 'error', 'cancelado', 'interrumpido')),
  fase text,
  detalle text,
  total integer not null default 0,
  hechos integer not null default 0,
  conexion text,
  archivos jsonb not null default '{}',   -- id → { nombre, estado, intentos, filas, error }
  tramos jsonb not null default '[]',     -- [{ ini, fin, recalcular, etiqueta, estado, intentos, error }]
  errores jsonb not null default '[]',
  resultado jsonb,
  iniciado_por uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists reprocess_jobs_tenant on public.reprocess_jobs (tenant_id, created_at desc);
-- Un solo reproceso en curso por empresa
create unique index if not exists reprocess_jobs_uno_activo on public.reprocess_jobs (tenant_id) where status = 'en_curso';
grant select on public.reprocess_jobs to authenticated;
grant all on public.reprocess_jobs to service_role;
alter table public.reprocess_jobs enable row level security;
create policy "reprocesos lectura" on public.reprocess_jobs for select
  using (public.tenant_visible(tenant_id)
         and (public.has_permission('importaciones', 'importar') or public.has_permission('importaciones', 'crear')
              or public.has_permission('importaciones', 'ver')));

-- Proceso del servidor que ejecuta el trabajo (solo uno a la vez; si su latido vence, otro lo reanuda)
alter table public.reprocess_jobs add column if not exists owner text;

-- El cierre ya no pisa rows_found (líneas del CSV): así un archivo incompleto se detecta
CREATE OR REPLACE FUNCTION public.finalizar_reconstruccion(_tenant uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_crudas bigint; v_limpias bigint;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'No autorizado'; end if;
  perform pg_advisory_xact_lock(hashtext('procesar_importacion:' || _tenant::text));

  -- dos eventos de puerta sin usuario idénticos también son el mismo evento
  if not exists (select 1 from pg_constraint where conname = 'biometric_events_evento_unico') then
    alter table biometric_events drop constraint if exists biometric_events_tenant_id_event_at_device_code_event_type__key;
    alter table biometric_events add constraint biometric_events_evento_unico
      unique nulls not distinct (tenant_id, event_at, device_code, event_type, raw_user);
  end if;

  update biometric_imports i set
    rows_raw = x.crudas,
    -- rows_found = líneas del CSV (se fija al leer el archivo); no se pisa con lo que haya en la capa cruda
    rows_repeated_in_file = x.crudas - x.unicas,
    rows_new = coalesce(n.aporta, 0),
    rows_existing = greatest(0, x.unicas - coalesce(n.aporta, 0)),
    rows_valid = coalesce(n.validas, 0),
    rows_ignored = coalesce(n.no_cuentan, 0),
    rows_duplicated = coalesce(n.repetidas, 0),
    status = 'completado', error_message = null, finished_at = coalesce(i.finished_at, now())
  from (select import_id, count(*) crudas,
               count(distinct (event_at, device_code, event_type, coalesce(raw_user, ''))) unicas
        from biometric_raw where tenant_id = _tenant group by import_id) x
  left join (select import_id, count(*) aporta,
                    count(*) filter (where is_attendance and not is_duplicate) validas,
                    count(*) filter (where not is_attendance) no_cuentan,
                    count(*) filter (where is_duplicate) repetidas
             from biometric_events where tenant_id = _tenant group by import_id) n on n.import_id = x.import_id
  where x.import_id = i.id;

  select count(*) into v_crudas from biometric_raw where tenant_id = _tenant;
  select count(*) into v_limpias from biometric_events where tenant_id = _tenant;
  return jsonb_build_object('filas_crudas', v_crudas, 'eventos_limpios', v_limpias);
end $function$;

-- Reintentos automáticos con espera creciente (1, 5, 15, 30 y 60 min)
alter table public.reprocess_jobs add column if not exists reintentos integer not null default 0;
alter table public.reprocess_jobs add column if not exists proximo_intento_at timestamptz;
