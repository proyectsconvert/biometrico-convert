-- Migración 0032: Capa cruda + capa limpia del biométrico (como Power Query)
--  · biometric_raw   = TODAS las filas de TODOS los CSV, tal cual, con archivo y número de línea
--                      (incluidas las repetidas). Nunca se descarta nada.
--  · biometric_events = histórico limpio: una fila por evento distinto (mismo segundo, lector,
--                      evento y usuario = mismo evento), armado a partir de la capa cruda.
-- Un archivo nuevo aporta a la capa limpia solo lo que no existía; lo demás queda registrado en la
-- capa cruda (ya existía en otro archivo o estaba repetido dentro del mismo archivo).

create table if not exists public.biometric_raw (
  id bigserial primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_id uuid not null references public.biometric_imports(id) on delete cascade,
  line_no integer not null,
  event_at timestamp not null,
  door text,
  device_code text not null,
  device_name text,
  user_group text,
  raw_user text,
  document text,
  biometric_name text,
  event_type text not null,
  created_at timestamptz not null default now()
);
create index if not exists biometric_raw_import_idx on public.biometric_raw (import_id, line_no);
create index if not exists biometric_raw_clave_idx on public.biometric_raw (tenant_id, event_at, device_code);
create index if not exists biometric_raw_doc_idx on public.biometric_raw (tenant_id, document, event_at);
grant select on public.biometric_raw to authenticated;
grant all on public.biometric_raw to service_role;
grant usage, select on sequence public.biometric_raw_id_seq to service_role;
alter table public.biometric_raw enable row level security;
drop policy if exists "crudo lectura" on public.biometric_raw;
create policy "crudo lectura" on public.biometric_raw for select to authenticated using (
  ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  and (select public.ve_toda_empresa()) and (select public.has_permission('importaciones', 'ver'))
);

alter table public.biometric_imports
  add column if not exists rows_raw integer not null default 0,
  add column if not exists rows_new integer not null default 0,
  add column if not exists rows_existing integer not null default 0,
  add column if not exists rows_repeated_in_file integer not null default 0;

-- 1. Cargar TODAS las filas del CSV a la capa cruda
--    cada fila: [línea, fecha, puerta, id_dispositivo, dispositivo, grupo, usuario, evento]
create or replace function public.cargar_crudo(_import_id uuid, _filas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
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
  where nullif(r->>1,'') is not null and nullif(r->>3,'') is not null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.cargar_crudo(uuid, jsonb) from public, anon;
grant execute on function public.cargar_crudo(uuid, jsonb) to authenticated, service_role;

-- 2. Consolidar un archivo: pasa a la capa limpia lo que aún no existe en el histórico
create or replace function public.consolidar_importacion(_import_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_crudas integer; v_unicas integer; v_nuevas integer;
begin
  select tenant_id into v_tenant from public.biometric_imports where id = _import_id;
  if v_tenant is null then raise exception 'Importación no encontrada'; end if;
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'No autorizado'; end if;
  perform pg_advisory_xact_lock(hashtext('procesar_importacion:' || v_tenant::text));

  -- idempotente al reprocesar: se retira lo que este archivo había aportado y se vuelve a aportar
  delete from public.biometric_events where import_id = _import_id;

  select count(*) into v_crudas from public.biometric_raw where import_id = _import_id;

  create temp table _unicas on commit drop as
    select distinct on (event_at, device_code, event_type, coalesce(raw_user, ''))
           event_at, door, device_code, device_name, user_group, raw_user, document, biometric_name, event_type
    from public.biometric_raw where import_id = _import_id
    order by event_at, device_code, event_type, coalesce(raw_user, ''), line_no;
  select count(*) into v_unicas from _unicas;

  insert into public.biometric_events
    (tenant_id, import_id, event_at, door, device_code, device_name, user_group, raw_user, document, biometric_name, event_type)
  select v_tenant, _import_id, u.event_at, u.door, u.device_code, u.device_name, u.user_group, u.raw_user, u.document, u.biometric_name, u.event_type
  from _unicas u
  where not exists (
    select 1 from public.biometric_events x
    where x.tenant_id = v_tenant and x.event_at = u.event_at and x.device_code = u.device_code
      and x.event_type = u.event_type and x.raw_user is not distinct from u.raw_user)
  order by u.document nulls last, u.event_at
  on conflict do nothing;
  get diagnostics v_nuevas = row_count;

  update public.biometric_imports
  set rows_raw = v_crudas, rows_new = v_nuevas, rows_existing = v_unicas - v_nuevas,
      rows_repeated_in_file = v_crudas - v_unicas
  where id = _import_id;

  return jsonb_build_object('crudas', v_crudas, 'unicas', v_unicas, 'nuevas', v_nuevas,
    'ya_existian', v_unicas - v_nuevas, 'repetidas_en_archivo', v_crudas - v_unicas);
end $$;
revoke all on function public.consolidar_importacion(uuid) from public, anon, authenticated;
grant execute on function public.consolidar_importacion(uuid) to service_role;

-- 3. Eliminar un archivo sin perder lo que también traen otros archivos
create or replace function public.eliminar_importacion(_import_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_desde timestamp; v_hasta timestamp; v_recuperadas integer := 0;
begin
  select tenant_id into v_tenant from public.biometric_imports where id = _import_id;
  if v_tenant is null then raise exception 'Importación no encontrada'; end if;
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'No autorizado'; end if;
  perform pg_advisory_xact_lock(hashtext('procesar_importacion:' || v_tenant::text));

  select min(event_at), max(event_at) into v_desde, v_hasta from (
    select event_at from public.biometric_events where import_id = _import_id
    union all select event_at from public.biometric_raw where import_id = _import_id) x;

  delete from public.biometric_events where import_id = _import_id;
  delete from public.biometric_raw where import_id = _import_id;

  -- lo que otros archivos también contenían vuelve a la capa limpia, a nombre de esos archivos
  if v_desde is not null then
    insert into public.biometric_events
      (tenant_id, import_id, event_at, door, device_code, device_name, user_group, raw_user, document, biometric_name, event_type)
    select distinct on (r.event_at, r.device_code, r.event_type, coalesce(r.raw_user, ''))
           v_tenant, r.import_id, r.event_at, r.door, r.device_code, r.device_name, r.user_group, r.raw_user, r.document, r.biometric_name, r.event_type
    from public.biometric_raw r
    where r.tenant_id = v_tenant and r.event_at between v_desde and v_hasta
      and not exists (
        select 1 from public.biometric_events x
        where x.tenant_id = v_tenant and x.event_at = r.event_at and x.device_code = r.device_code
          and x.event_type = r.event_type and x.raw_user is not distinct from r.raw_user)
    order by r.event_at, r.device_code, r.event_type, coalesce(r.raw_user, ''), r.id
    on conflict do nothing;
    get diagnostics v_recuperadas = row_count;
  end if;

  delete from public.biometric_imports where id = _import_id;
  return jsonb_build_object('desde', v_desde::date, 'hasta', v_hasta::date, 'recuperadas_de_otros_archivos', v_recuperadas);
end $$;
revoke all on function public.eliminar_importacion(uuid) from public, anon, authenticated;
grant execute on function public.eliminar_importacion(uuid) to service_role;

-- 4. Reconstruir TODA la capa limpia desde la capa cruda (ordenada por persona y hora)
create or replace function public.reconstruir_desde_crudo(_tenant uuid)
returns jsonb language plpgsql security definer set search_path = public set statement_timeout = '30min' as $$
declare v_sin_crudo integer; v_crudas bigint; v_limpias bigint; r jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'No autorizado'; end if;
  select count(*) into v_sin_crudo from public.biometric_imports i
  where i.tenant_id = _tenant and i.status not in ('pendiente', 'error')
    and not exists (select 1 from public.biometric_raw r where r.import_id = i.id);
  if v_sin_crudo > 0 then
    raise exception '% archivos aún no tienen su capa cruda; recárgalos antes de reconstruir', v_sin_crudo;
  end if;
  perform pg_advisory_xact_lock(hashtext('procesar_importacion:' || _tenant::text));

  delete from public.biometric_events where tenant_id = _tenant;
  insert into public.biometric_events
    (tenant_id, import_id, event_at, door, device_code, device_name, user_group, raw_user, document, biometric_name, event_type)
  select tenant_id, import_id, event_at, door, device_code, device_name, user_group, raw_user, document, biometric_name, event_type
  from (
    select distinct on (r.event_at, r.device_code, r.event_type, coalesce(r.raw_user, ''))
           r.tenant_id, r.import_id, r.event_at, r.door, r.device_code, r.device_name, r.user_group, r.raw_user, r.document, r.biometric_name, r.event_type
    from public.biometric_raw r join public.biometric_imports i on i.id = r.import_id
    where r.tenant_id = _tenant
    order by r.event_at, r.device_code, r.event_type, coalesce(r.raw_user, ''), i.started_at, r.line_no
  ) u
  order by u.document nulls last, u.event_at;   -- histórico físicamente ordenado por persona y hora

  -- a partir de aquí, dos eventos de puerta sin usuario idénticos también cuentan como el mismo
  if not exists (select 1 from pg_constraint where conname = 'biometric_events_evento_unico') then
    alter table public.biometric_events drop constraint if exists biometric_events_tenant_id_event_at_device_code_event_type__key;
    alter table public.biometric_events add constraint biometric_events_evento_unico
      unique nulls not distinct (tenant_id, event_at, device_code, event_type, raw_user);
  end if;

  -- estadísticas por archivo
  update public.biometric_imports i set rows_raw = x.crudas, rows_repeated_in_file = x.crudas - x.unicas
  from (select import_id, count(*) crudas,
               count(distinct (event_at, device_code, event_type, coalesce(raw_user, ''))) unicas
        from public.biometric_raw where tenant_id = _tenant group by import_id) x
  where x.import_id = i.id;
  update public.biometric_imports i set rows_new = coalesce(x.n, 0), rows_existing = greatest(0, i.rows_raw - i.rows_repeated_in_file - coalesce(x.n, 0))
  from (select im.id, (select count(*) from public.biometric_events e where e.import_id = im.id) n
        from public.biometric_imports im where im.tenant_id = _tenant) x
  where x.id = i.id;

  -- clasificación, empleados, repetidas y recálculo de todas las jornadas
  r := public.reconstruir_historico(_tenant);
  select count(*) into v_crudas from public.biometric_raw where tenant_id = _tenant;
  select count(*) into v_limpias from public.biometric_events where tenant_id = _tenant;
  return r || jsonb_build_object('filas_crudas', v_crudas, 'eventos_limpios', v_limpias);
end $$;
revoke all on function public.reconstruir_desde_crudo(uuid) from public, anon, authenticated;
grant execute on function public.reconstruir_desde_crudo(uuid) to service_role;

-- 5. Cuántas veces aparece un evento en los CSV cargados (para el histórico consolidado)
create or replace function public.copias_en_csv(_tenant uuid, _event_at timestamp, _device text, _tipo text, _usuario text)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.biometric_raw
  where tenant_id = _tenant and event_at = _event_at and device_code = _device
    and event_type = _tipo and raw_user is not distinct from _usuario;
$$;
grant execute on function public.copias_en_csv(uuid, timestamp, text, text, text) to authenticated;

-- 6. Histórico consolidado: marcaciones válidas por persona en orden cronológico
create or replace view public.historico_marcaciones with (security_invoker = true) as
select b.tenant_id, b.document, coalesce(e.full_name, b.biometric_name) as empleado, c.name as campana,
       e.campaign_id, b.event_at::date as fecha, b.event_at, b.device_name, b.door, b.event_type, b.is_duplicate,
       row_number() over (partition by b.tenant_id, b.document, b.event_at::date order by b.event_at, b.id) as n_marca,
       count(*) over (partition by b.tenant_id, b.document, b.event_at::date) as marcas_dia,
       case when e.employer_id is null then (select public.incluye_sin_empresa())
            else coalesce(em.include_in_reports, true) end as en_reportes,
       b.id
from public.biometric_events b
left join public.employees e on e.id = b.employee_id
left join public.employers em on em.id = e.employer_id
left join public.campaigns c on c.id = e.campaign_id
where b.is_attendance;
grant select on public.historico_marcaciones to authenticated, service_role;
