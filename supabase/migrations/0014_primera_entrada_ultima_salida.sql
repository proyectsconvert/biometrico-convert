-- Migración 0014: Garantizar que la primera marcación es entrada y la última es salida sin importar la puerta ni clasificación
-- Actualiza sugerir_clasificacion, procesar_importacion, recalcular_asistencia y biometric_daily view

create or replace function public.sugerir_clasificacion(_name text)
returns public.device_class language sql immutable as $$
  select case
    when _name ilike '%salida%' and _name not ilike '%entrada%' then 'salida'::public.device_class
    when _name ilike '%entrada%' and _name not ilike '%salida%' then 'entrada'::public.device_class
    else 'entrada_salida'::public.device_class
  end;
$$;

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

  -- crear empleados automáticamente desde el biométrico si no existen
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

  -- Todas las marcaciones exitosas con documento son consideradas asistencia, sin importar la puerta ni el dispositivo
  update public.biometric_events e
  set device_id = d.id,
      employee_id = emp.id,
      is_attendance = (e.document is not null and e.event_type ilike '%exitosa%' and e.event_type not ilike '%fallida%')
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

-- Recalcular asistencia: la primera marcación es entrada y la última es salida sin importar la puerta
create or replace function public.recalcular_asistencia(_tenant uuid, _desde date, _hasta date)
returns integer language plpgsql security definer set search_path = public as $function$
declare
  v_rows integer; v_ventana integer; v_jornada integer; v_extra integer;
  v_ni time; v_nf time; v_dias int[]; v_dom boolean;
begin
  if coalesce(auth.role(),'') <> 'service_role' and not public.tenant_visible(_tenant) then
    raise exception 'Sin acceso a esta empresa';
  end if;

  select coalesce(max(case when key='ventana_nocturna_horas' then (value#>>'{}')::int end),4),
         coalesce(max(case when key='jornada_minutos' then (value#>>'{}')::int end),480),
         coalesce(max(case when key='horas_extra_despues' then round((value#>>'{}')::numeric*60)::int end),480),
         coalesce(max(case when key='nocturna_inicio' then (value#>>'{}')::time end),'21:00'),
         coalesce(max(case when key='nocturna_fin' then (value#>>'{}')::time end),'06:00'),
         coalesce(max(case when key='aplica_dominical_festivo' then (value#>>'{}')::boolean end),true)
    into v_ventana, v_jornada, v_extra, v_ni, v_nf, v_dom
  from public.rules where tenant_id=_tenant;

  select coalesce(array(select jsonb_array_elements_text(value)::int), array[1,2,3,4,5]) into v_dias
    from public.rules where tenant_id=_tenant and key='dias_laborales';
  v_dias := coalesce(v_dias, array[1,2,3,4,5]);

  with base as (
    select e.employee_id, emp.tenant_id, coalesce(emp.shift_id, c.shift_id) as shift_id,
           s.start_time, s.break_minutes, s.tolerance_in_minutes, e.event_at,
           case when s.crosses_midnight and e.event_at::time < (s.end_time + make_interval(hours => v_ventana))
             then (e.event_at::date - 1) else e.event_at::date end as work_date
    from public.biometric_events e
    join public.employees emp on emp.id = e.employee_id
    left join public.campaigns c on c.id = emp.campaign_id
    left join public.shifts s on s.id = coalesce(emp.shift_id, c.shift_id)
    where e.tenant_id = _tenant and e.is_attendance and not e.is_duplicate
      and e.event_at::date between _desde - 1 and _hasta + 1
  ), agrupado as (
    select employee_id, tenant_id, work_date, min(shift_id::text)::uuid as shift_id,
           min(start_time) as start_time, min(break_minutes) as break_minutes,
           min(tolerance_in_minutes) as tolerance_in_minutes,
           -- Regla universal: Primera hora registrada es Entrada
           min(event_at) as first_in,
           -- Regla universal: Última hora registrada es Salida (si hay más de 1 marcación)
           case when max(event_at) > min(event_at) then max(event_at) else null end as last_out
    from base where work_date between _desde and _hasta
    group by employee_id, tenant_id, work_date
  ), calculado as (
    select a.*,
      case when first_in is not null and last_out is not null and last_out > first_in
        then greatest(0, (extract(epoch from (last_out - first_in))/60)::int - coalesce(break_minutes,0)) else 0 end as worked,
      case when first_in is not null and last_out is not null and last_out > first_in then 'completa'::attendance_status
           when first_in is not null or last_out is not null then 'incompleta'::attendance_status
           else 'sin_marcacion'::attendance_status end as status,
      case when first_in is not null and start_time is not null
             and first_in::time > (start_time + make_interval(mins => coalesce(tolerance_in_minutes,0)))
        then (extract(epoch from (first_in::time - start_time))/60)::int else 0 end as late_minutes,
      public.minutos_en_ventana(first_in, last_out, v_ni, v_nf) as night,
      (extract(dow from work_date)::int = 0
        or exists (select 1 from public.holidays h where h.tenant_id=_tenant and h.is_active and h.holiday_date=a.work_date)) as dom_fest,
      not (extract(dow from work_date)::int = any(v_dias)) as rest
    from agrupado a
  )
  insert into public.attendance_daily as ad
    (tenant_id, employee_id, work_date, shift_id, first_in, last_out, worked_minutes, expected_minutes, late_minutes, status,
     ordinary_minutes, overtime_minutes, night_minutes, sunday_holiday_minutes, is_rest_day, updated_at)
  select tenant_id, employee_id, work_date, shift_id, first_in, last_out, worked,
         case when rest then 0 else v_jornada end, late_minutes, status,
         least(worked, v_extra), greatest(0, worked - v_extra), least(night, worked),
         case when v_dom and dom_fest then worked else 0 end, rest, now()
  from calculado
  on conflict (employee_id, work_date) do update
    set first_in = case when ad.is_manual then ad.first_in else excluded.first_in end,
        last_out = case when ad.is_manual then ad.last_out else excluded.last_out end,
        worked_minutes = case when ad.is_manual then ad.worked_minutes else excluded.worked_minutes end,
        status = case when ad.is_manual then ad.status else excluded.status end,
        ordinary_minutes = case when ad.is_manual then ad.ordinary_minutes else excluded.ordinary_minutes end,
        overtime_minutes = case when ad.is_manual then ad.overtime_minutes else excluded.overtime_minutes end,
        night_minutes = case when ad.is_manual then ad.night_minutes else excluded.night_minutes end,
        sunday_holiday_minutes = case when ad.is_manual then ad.sunday_holiday_minutes else excluded.sunday_holiday_minutes end,
        is_rest_day = excluded.is_rest_day,
        late_minutes = excluded.late_minutes, shift_id = excluded.shift_id,
        expected_minutes = excluded.expected_minutes, updated_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;

-- Vista biometric_daily actualizada
create or replace view public.biometric_daily with (security_invoker = true) as
select e.tenant_id, e.document, max(e.biometric_name) as nombre, e.event_at::date as fecha,
       min(e.event_at) filter (where e.is_attendance and not e.is_duplicate) as primera_entrada,
       case when max(e.event_at) filter (where e.is_attendance and not e.is_duplicate) > min(e.event_at) filter (where e.is_attendance and not e.is_duplicate)
         then max(e.event_at) filter (where e.is_attendance and not e.is_duplicate) else null end as ultima_salida,
       min(e.event_at) filter (where e.is_attendance) as primera_marcacion,
       max(e.event_at) filter (where e.is_attendance) as ultima_marcacion,
       count(*) filter (where e.is_attendance and not e.is_duplicate) as marcaciones_validas,
       count(*) as eventos_totales
from public.biometric_events e
group by e.tenant_id, e.document, e.event_at::date;

grant execute on function public.procesar_importacion(uuid) to authenticated, service_role;
grant execute on function public.recalcular_asistencia(uuid,date,date) to authenticated, service_role;
