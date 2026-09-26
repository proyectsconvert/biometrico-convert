-- limpiar importación atascada
delete from public.biometric_events where import_id in (select id from public.biometric_imports where status='procesando');
delete from public.biometric_imports where status='procesando';

alter table public.biometric_imports add column if not exists rows_duplicated integer not null default 0;
alter table public.biometric_imports add column if not exists error_message text;
create unique index if not exists biometric_imports_tenant_filename_key on public.biometric_imports (tenant_id, lower(filename));

-- permitir ejecución desde el servidor (service_role) en recalcular
do $$
declare d text;
begin
  d := pg_get_functiondef('public.recalcular_asistencia(uuid,date,date)'::regprocedure);
  d := replace(d, 'if not public.tenant_visible(_tenant) then', 'if coalesce(auth.role(),'''') <> ''service_role'' and not public.tenant_visible(_tenant) then');
  execute d;
end $$;

create or replace function public.procesar_importacion(_import_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_tenant uuid; v_dedupe integer; v_valid integer; v_ignored integer; v_total integer; v_dup integer;
  v_desde timestamp; v_hasta timestamp;
begin
  select tenant_id into v_tenant from public.biometric_imports where id = _import_id;
  if v_tenant is null then raise exception 'Importación no encontrada'; end if;
  if coalesce(auth.role(),'') <> 'service_role' and not public.tenant_visible(v_tenant) then
    raise exception 'Sin acceso a esta empresa';
  end if;
  select coalesce((value#>>'{}')::integer, 60) into v_dedupe from public.rules where tenant_id = v_tenant and key = 'dedupe_seconds';
  v_dedupe := coalesce(v_dedupe, 60);

  insert into public.devices (tenant_id, device_code, name, door_name, classification)
  select v_tenant, e.device_code, min(coalesce(e.device_name, e.device_code)), min(e.door),
         public.sugerir_clasificacion(min(coalesce(e.device_name,'')) || ' ' || coalesce(min(e.door),''))
  from public.biometric_events e where e.import_id = _import_id
  group by e.device_code
  on conflict (tenant_id, device_code) do nothing;

  -- crear empleados automáticamente desde el biométrico
  insert into public.employees (tenant_id, document, full_name)
  select v_tenant, e.document, coalesce(max(e.biometric_name), 'SIN NOMBRE ' || e.document)
  from public.biometric_events e
  where e.import_id = _import_id and e.document is not null
  group by e.document
  on conflict (tenant_id, document) do nothing;

  update public.employees emp set full_name = x.n
  from (select document, max(biometric_name) n from public.biometric_events
        where import_id=_import_id and biometric_name is not null group by document) x
  where emp.tenant_id=v_tenant and emp.document=x.document and emp.full_name like 'SIN NOMBRE %';

  update public.biometric_events e
  set device_id = d.id,
      employee_id = emp.id,
      is_attendance = (e.document is not null and e.event_type ilike '%exitosa%' and e.event_type not ilike '%fallida%'
                       and d.is_active and d.classification in ('entrada','salida','entrada_salida'))
  from public.devices d
  left join lateral (select id from public.employees where tenant_id=v_tenant and document = e.document) emp on true
  where e.import_id = _import_id and d.tenant_id = v_tenant and d.device_code = e.device_code;

  select min(event_at) - interval '1 day', max(event_at) + interval '1 day' into v_desde, v_hasta
  from public.biometric_events where import_id = _import_id;

  with ordenados as (
    select e.id, e.import_id,
           lag(e.event_at) over (partition by e.document, e.device_code order by e.event_at) as prev_at
    from public.biometric_events e
    where e.tenant_id = v_tenant and e.is_attendance and e.event_at between v_desde and v_hasta
      and e.document in (select distinct document from public.biometric_events where import_id=_import_id)
  )
  update public.biometric_events e
  set is_duplicate = (o.prev_at is not null and e.event_at - o.prev_at < make_interval(secs => v_dedupe))
  from ordenados o where o.id = e.id and o.import_id = _import_id;

  select count(*), count(*) filter (where is_attendance and not is_duplicate),
         count(*) filter (where not is_attendance), count(*) filter (where is_duplicate)
    into v_total, v_valid, v_ignored, v_dup
  from public.biometric_events where import_id = _import_id;

  update public.biometric_imports
  set rows_processed = v_total, rows_valid = v_valid, rows_ignored = v_ignored, rows_duplicated = v_dup
  where id = _import_id;

  return jsonb_build_object('total', v_total, 'validas', v_valid, 'ignoradas', v_ignored, 'duplicadas', v_dup,
    'desde', v_desde::date + 1, 'hasta', v_hasta::date - 1);
end $$;
grant execute on function public.procesar_importacion(uuid) to authenticated, service_role;
grant execute on function public.recalcular_asistencia(uuid,date,date) to authenticated, service_role;

-- vista diaria de resultados biométricos (respeta RLS del usuario)
create or replace view public.biometric_daily with (security_invoker = true) as
select e.tenant_id, e.document, max(e.biometric_name) as nombre, e.event_at::date as fecha,
       min(e.event_at) filter (where e.is_attendance and not e.is_duplicate and d.classification in ('entrada','entrada_salida')) as primera_entrada,
       max(e.event_at) filter (where e.is_attendance and not e.is_duplicate and d.classification in ('salida','entrada_salida')) as ultima_salida,
       min(e.event_at) filter (where e.is_attendance) as primera_marcacion,
       max(e.event_at) filter (where e.is_attendance) as ultima_marcacion,
       count(*) filter (where e.is_attendance and not e.is_duplicate) as marcaciones_validas,
       count(*) as eventos_totales
from public.biometric_events e
left join public.devices d on d.id = e.device_id
where e.document is not null
group by e.tenant_id, e.document, e.event_at::date;
grant select on public.biometric_daily to authenticated, service_role;

create index if not exists bio_events_tenant_date_idx on public.biometric_events (tenant_id, event_at);
create index if not exists bio_events_name_trgm_idx on public.biometric_events (tenant_id, biometric_name);