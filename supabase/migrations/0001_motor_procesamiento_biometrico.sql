-- Sugerir clasificación de dispositivo a partir del nombre
create or replace function public.sugerir_clasificacion(_name text)
returns public.device_class language sql immutable as $$
  select case
    when _name ilike '%bañ%' or _name ilike '%bano%' then 'interno'::public.device_class
    when _name ilike '%paso%' then 'interno'::public.device_class
    when _name ilike '%entrada%' then 'entrada'::public.device_class
    when _name ilike '%salida%' then 'salida'::public.device_class
    when _name ilike '%molinete%' or _name ilike '%molinente%' then 'entrada_salida'::public.device_class
    when _name ilike '%piso%' or _name ilike '%puerta%' then 'interno'::public.device_class
    else 'ignorar'::public.device_class
  end;
$$;

-- Procesa los eventos de una importación: dispositivos, empleados, validez y duplicados
create or replace function public.procesar_importacion(_import_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_dedupe integer;
  v_valid integer;
  v_ignored integer;
  v_total integer;
begin
  select tenant_id into v_tenant from public.biometric_imports where id = _import_id;
  if v_tenant is null then raise exception 'Importación no encontrada'; end if;
  if not public.tenant_visible(v_tenant) then raise exception 'Sin acceso a esta empresa'; end if;

  select coalesce((value)::text::integer, 60) into v_dedupe from public.rules where tenant_id = v_tenant and key = 'dedupe_seconds';
  v_dedupe := coalesce(v_dedupe, 60);

  -- 1. registrar dispositivos nuevos con clasificación sugerida
  insert into public.devices (tenant_id, device_code, name, door_name, classification)
  select v_tenant, e.device_code, min(coalesce(e.device_name, e.device_code)), min(e.door),
         public.sugerir_clasificacion(min(coalesce(e.device_name,'')) || ' ' || coalesce(min(e.door),''))
  from public.biometric_events e
  where e.import_id = _import_id
  group by e.device_code
  on conflict (tenant_id, device_code) do nothing;

  -- 2. enlazar dispositivo y empleado
  update public.biometric_events e
  set device_id = d.id
  from public.devices d
  where e.import_id = _import_id and d.tenant_id = v_tenant and d.device_code = e.device_code;

  update public.biometric_events e
  set employee_id = emp.id
  from public.employees emp
  where e.import_id = _import_id and emp.tenant_id = v_tenant and emp.document = e.document;

  -- 3. marcar eventos válidos para asistencia
  update public.biometric_events e
  set is_attendance = (
    e.document is not null
    and e.event_type ilike '%exitosa%'
    and exists (select 1 from public.devices d where d.id = e.device_id and d.is_active and d.classification in ('entrada','salida','entrada_salida'))
  )
  where e.import_id = _import_id;

  -- 4. marcar duplicados lógicos (misma persona, mismo dispositivo, dentro de la tolerancia)
  with ordenados as (
    select e.id,
           lag(e.event_at) over (partition by e.document, e.device_code order by e.event_at) as prev_at
    from public.biometric_events e
    where e.tenant_id = v_tenant and e.is_attendance
  )
  update public.biometric_events e
  set is_duplicate = (o.prev_at is not null and e.event_at - o.prev_at < make_interval(secs => v_dedupe))
  from ordenados o
  where o.id = e.id and e.import_id = _import_id;

  select count(*), count(*) filter (where is_attendance and not is_duplicate),
         count(*) filter (where not is_attendance)
    into v_total, v_valid, v_ignored
  from public.biometric_events where import_id = _import_id;

  update public.biometric_imports
  set rows_processed = v_total, rows_valid = v_valid, rows_ignored = v_ignored,
      status = case when v_valid = 0 then 'completado_advertencias'::public.import_status else 'completado'::public.import_status end,
      finished_at = now()
  where id = _import_id;

  return jsonb_build_object('total', v_total, 'validos', v_valid, 'ignorados', v_ignored);
end;
$$;

-- Recalcula la asistencia diaria a partir de los eventos válidos
create or replace function public.recalcular_asistencia(_tenant uuid, _desde date, _hasta date)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_rows integer;
  v_ventana integer;
begin
  if not public.tenant_visible(_tenant) then raise exception 'Sin acceso a esta empresa'; end if;
  select coalesce((value)::text::integer, 4) into v_ventana from public.rules where tenant_id = _tenant and key = 'ventana_nocturna_horas';
  v_ventana := coalesce(v_ventana, 4);

  with base as (
    select e.employee_id,
           emp.tenant_id,
           coalesce(emp.shift_id, c.shift_id) as shift_id,
           s.start_time, s.end_time, s.crosses_midnight, s.break_minutes, s.tolerance_in_minutes,
           d.classification,
           e.event_at,
           case
             when s.crosses_midnight and e.event_at::time < (s.end_time + make_interval(hours => v_ventana))
               then (e.event_at::date - 1)
             else e.event_at::date
           end as work_date
    from public.biometric_events e
    join public.employees emp on emp.id = e.employee_id
    join public.devices d on d.id = e.device_id
    left join public.campaigns c on c.id = emp.campaign_id
    left join public.shifts s on s.id = coalesce(emp.shift_id, c.shift_id)
    where e.tenant_id = _tenant and e.is_attendance and not e.is_duplicate
      and e.event_at::date between _desde - 1 and _hasta + 1
  ), agrupado as (
    select employee_id, tenant_id, work_date, min(shift_id::text)::uuid as shift_id,
           min(start_time) as start_time, min(break_minutes) as break_minutes,
           min(tolerance_in_minutes) as tolerance_in_minutes,
           min(event_at) filter (where classification in ('entrada','entrada_salida')) as first_in,
           max(event_at) filter (where classification in ('salida','entrada_salida')) as last_out
    from base
    where work_date between _desde and _hasta
    group by employee_id, tenant_id, work_date
  ), calculado as (
    select a.*,
      case when first_in is not null and last_out is not null and last_out > first_in
        then greatest(0, (extract(epoch from (last_out - first_in))/60)::int - coalesce(break_minutes,0))
        else 0 end as worked_minutes,
      case when first_in is not null and last_out is not null and last_out > first_in then 'completa'::public.attendance_status
           when first_in is not null or last_out is not null then 'incompleta'::public.attendance_status
           else 'sin_marcacion'::public.attendance_status end as status,
      case when first_in is not null and start_time is not null
             and first_in::time > (start_time + make_interval(mins => coalesce(tolerance_in_minutes,0)))
        then (extract(epoch from (first_in::time - start_time))/60)::int else 0 end as late_minutes
    from agrupado a
  )
  insert into public.attendance_daily as ad
    (tenant_id, employee_id, work_date, shift_id, first_in, last_out, worked_minutes, expected_minutes, late_minutes, status, updated_at)
  select tenant_id, employee_id, work_date, shift_id, first_in, last_out, worked_minutes,
         coalesce((select (value)::text::integer from public.rules where tenant_id = _tenant and key='jornada_minutos'), 480),
         late_minutes, status, now()
  from calculado
  on conflict (employee_id, work_date) do update
    set first_in = case when ad.is_manual then ad.first_in else excluded.first_in end,
        last_out = case when ad.is_manual then ad.last_out else excluded.last_out end,
        worked_minutes = case when ad.is_manual then ad.worked_minutes else excluded.worked_minutes end,
        status = case when ad.is_manual then ad.status else excluded.status end,
        late_minutes = excluded.late_minutes,
        shift_id = excluded.shift_id,
        expected_minutes = excluded.expected_minutes,
        updated_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

grant execute on function public.procesar_importacion(uuid) to authenticated;
grant execute on function public.recalcular_asistencia(uuid, date, date) to authenticated;
grant execute on function public.sugerir_clasificacion(text) to authenticated;