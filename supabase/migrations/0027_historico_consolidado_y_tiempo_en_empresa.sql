-- Migración 0027: Histórico consolidado de CSV y tiempo total en la empresa
-- 1. Cada jornada guarda la permanencia total (primera → última marcación) y el descanso
--    descontado por separado. El descuento del almuerzo es opcional (regla descontar_descanso,
--    por defecto NO se descuenta: horas = tiempo total en la empresa, como el histórico en Excel).
-- 2. Al procesar un archivo, las marcaciones repetidas se revisan contra TODO el histórico del
--    rango (antes solo contra el propio archivo).
-- 3. reconstruir_historico(): une todo lo cargado, limpia, marca repetidos y recalcula desde cero
--    (equivalente a combinar todos los CSV en Power Query y volver a calcular).

insert into public.rules (tenant_id, key, value, description)
select t.id, 'descontar_descanso', 'false'::jsonb,
       'Descontar el descanso/almuerzo de las horas trabajadas (si no, horas = tiempo total en la empresa)'
from public.tenants t
on conflict (tenant_id, key) do nothing;

alter table public.attendance_daily
  add column if not exists stay_minutes integer not null default 0,
  add column if not exists break_applied_minutes integer not null default 0;

create or replace function public.recalcular_asistencia(_tenant uuid, _desde date, _hasta date)
returns integer language plpgsql security definer set search_path = public as $function$
declare
  v_rows integer; v_ventana integer; v_jornada integer; v_extra integer;
  v_ni time; v_nf time; v_dias int[]; v_dom boolean; v_desc integer; v_desc_desde integer; v_descontar boolean;
begin
  if coalesce(auth.role(),'') <> 'service_role' and not public.tenant_visible(_tenant) then
    raise exception 'Sin acceso a esta empresa';
  end if;

  select coalesce(max(case when key='ventana_nocturna_horas' then (value#>>'{}')::int end),4),
         coalesce(max(case when key='jornada_minutos' then (value#>>'{}')::int end),480),
         coalesce(max(case when key='horas_extra_despues' then round((value#>>'{}')::numeric*60)::int end),480),
         coalesce(max(case when key='nocturna_inicio' then (value#>>'{}')::time end),'21:00'),
         coalesce(max(case when key='nocturna_fin' then (value#>>'{}')::time end),'06:00'),
         coalesce(bool_or(case when key='aplica_dominical_festivo' then (value#>>'{}')::boolean end),true),
         coalesce(max(case when key='descanso_minutos' then (value#>>'{}')::numeric::int end),0),
         coalesce(max(case when key='descanso_desde_horas' then round((value#>>'{}')::numeric*60)::int end),300),
         coalesce(bool_or(case when key='descontar_descanso' then (value#>>'{}')::boolean end),false)
    into v_ventana, v_jornada, v_extra, v_ni, v_nf, v_dom, v_desc, v_desc_desde, v_descontar
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
           -- Regla universal: primera marcación = entrada, última = salida (sin importar la puerta)
           min(event_at) as first_in,
           case when max(event_at) > min(event_at) then max(event_at) else null end as last_out
    from base where work_date between _desde and _hasta
    group by employee_id, tenant_id, work_date
  ), permanencia as (
    select a.*,
      case when first_in is not null and last_out is not null and last_out > first_in
        then (extract(epoch from (last_out - first_in))/60)::int else 0 end as stay
    from agrupado a
  ), descanso as (
    select p.*,
      -- el descanso solo se descuenta si la regla está activa: con turno, el del turno;
      -- sin turno, el descanso por defecto cuando la permanencia lo amerita
      case when not v_descontar then 0
           when shift_id is not null then least(stay, coalesce(break_minutes,0))
           when stay >= v_desc_desde then least(stay, v_desc) else 0 end as brk
    from permanencia p
  ), calculado as (
    select d.*,
      greatest(0, stay - brk) as worked,
      case when first_in is not null and last_out is not null and last_out > first_in then 'completa'::attendance_status
           when first_in is not null or last_out is not null then 'incompleta'::attendance_status
           else 'sin_marcacion'::attendance_status end as status,
      case when first_in is not null and start_time is not null
             and first_in::time > (start_time + make_interval(mins => coalesce(tolerance_in_minutes,0)))
        then (extract(epoch from (first_in::time - start_time))/60)::int else 0 end as late_minutes,
      public.minutos_en_ventana(first_in, last_out, v_ni, v_nf) as night,
      (extract(dow from work_date)::int = 0
        or exists (select 1 from public.holidays h where h.tenant_id=_tenant and h.is_active and h.holiday_date=d.work_date)) as dom_fest,
      not (extract(dow from work_date)::int = any(v_dias)) as rest
    from descanso d
  ), final as (
    select c.*, greatest(0, worked - v_extra) as overtime
    from calculado c
  )
  insert into public.attendance_daily as ad
    (tenant_id, employee_id, work_date, shift_id, first_in, last_out, worked_minutes, expected_minutes, late_minutes, status,
     ordinary_minutes, overtime_minutes, overtime_night_minutes, night_minutes, sunday_holiday_minutes, is_rest_day,
     stay_minutes, break_applied_minutes, updated_at)
  select tenant_id, employee_id, work_date, shift_id, first_in, last_out, worked,
         case when rest then 0 else v_jornada end, late_minutes, status,
         least(worked, v_extra), overtime,
         case when overtime > 0 then least(overtime, public.minutos_en_ventana(last_out - make_interval(mins => overtime), last_out, v_ni, v_nf)) else 0 end,
         least(night, worked),
         case when v_dom and dom_fest then worked else 0 end, rest,
         stay, brk, now()
  from final
  on conflict (employee_id, work_date) do update
    set first_in = case when ad.is_manual then ad.first_in else excluded.first_in end,
        last_out = case when ad.is_manual then ad.last_out else excluded.last_out end,
        worked_minutes = case when ad.is_manual then ad.worked_minutes else excluded.worked_minutes end,
        status = case when ad.is_manual then ad.status else excluded.status end,
        ordinary_minutes = case when ad.is_manual then ad.ordinary_minutes else excluded.ordinary_minutes end,
        overtime_minutes = case when ad.is_manual then ad.overtime_minutes else excluded.overtime_minutes end,
        overtime_night_minutes = case when ad.is_manual then ad.overtime_night_minutes else excluded.overtime_night_minutes end,
        night_minutes = case when ad.is_manual then ad.night_minutes else excluded.night_minutes end,
        sunday_holiday_minutes = case when ad.is_manual then ad.sunday_holiday_minutes else excluded.sunday_holiday_minutes end,
        stay_minutes = case when ad.is_manual then ad.stay_minutes else excluded.stay_minutes end,
        break_applied_minutes = case when ad.is_manual then ad.break_applied_minutes else excluded.break_applied_minutes end,
        is_rest_day = excluded.is_rest_day,
        late_minutes = excluded.late_minutes, shift_id = excluded.shift_id,
        expected_minutes = excluded.expected_minutes, updated_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;
grant execute on function public.recalcular_asistencia(uuid,date,date) to authenticated, service_role;

-- Repetidas: revisar TODO el histórico del rango, no solo lo que trae el archivo nuevo
do $$
declare d text;
begin
  d := pg_get_functiondef('public.procesar_importacion(uuid)'::regprocedure);
  d := replace(d,
    'from ordenados o where o.id = e.id and o.import_id = _import_id;',
    'from ordenados o where o.id = e.id' || chr(10) ||
    '    and e.is_duplicate is distinct from (o.prev_at is not null and e.event_at - o.prev_at < make_interval(secs => v_dedupe));');
  if position('e.is_duplicate is distinct from' in d) = 0 then raise exception 'No se pudo actualizar procesar_importacion'; end if;
  execute d;
end $$;

-- Reconstruir el histórico completo
create or replace function public.reconstruir_historico(_tenant uuid)
returns jsonb language plpgsql security definer set search_path = public set statement_timeout = '15min' as $$
declare
  v_dedupe integer; v_desde date; v_hasta date; d date; n_emp integer; n_val integer; n_dup integer; n_jor integer := 0; k integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'No autorizado'; end if;
  perform pg_advisory_xact_lock(hashtext('procesar_importacion:' || _tenant::text));
  select coalesce((value#>>'{}')::integer, 60) into v_dedupe from rules where tenant_id = _tenant and key = 'dedupe_seconds';
  v_dedupe := coalesce(v_dedupe, 60);

  -- 1. Qué cuenta como marcación (mismo criterio para todo el histórico)
  update biometric_events set is_attendance = (document is not null and es_marcacion_valida(event_type))
  where tenant_id = _tenant and is_attendance is distinct from (document is not null and es_marcacion_valida(event_type));

  -- 2. Empleados para personas con marcaciones válidas y enlace de cada evento
  insert into employees (tenant_id, document, full_name)
  select _tenant, document, coalesce(max(biometric_name), 'SIN NOMBRE ' || document)
  from biometric_events where tenant_id = _tenant and is_attendance group by document
  on conflict (tenant_id, document) do nothing;
  get diagnostics n_emp = row_count;
  update biometric_events e set employee_id = emp.id
  from employees emp
  where e.tenant_id = _tenant and emp.tenant_id = _tenant and emp.document = e.document
    and e.employee_id is distinct from emp.id;

  -- 3. Repetidas en todo el histórico (misma persona y lector dentro de la tolerancia)
  with o as (
    select id, is_attendance and coalesce(event_at - lag(event_at) over (partition by document, device_code order by event_at) < make_interval(secs => v_dedupe), false) as dup
    from biometric_events where tenant_id = _tenant and is_attendance
  )
  update biometric_events e set is_duplicate = o.dup from o where o.id = e.id and e.is_duplicate is distinct from o.dup;
  update biometric_events set is_duplicate = false where tenant_id = _tenant and not is_attendance and is_duplicate;

  -- 4. Recalcular todas las jornadas desde cero (se conservan las ajustadas a mano)
  select min(event_at)::date, max(event_at)::date into v_desde, v_hasta
  from biometric_events where tenant_id = _tenant and is_attendance;
  delete from attendance_daily a where a.tenant_id = _tenant and not a.is_manual
    and not exists (select 1 from attendance_adjustments x where x.attendance_id = a.id);
  if v_desde is not null then
    d := date_trunc('month', v_desde)::date;
    while d <= v_hasta loop
      k := recalcular_asistencia(_tenant, greatest(d, v_desde), least((d + interval '1 month - 1 day')::date, v_hasta));
      n_jor := n_jor + coalesce(k, 0);
      d := (d + interval '1 month')::date;
    end loop;
  end if;

  -- 5. Conteos de cada importación
  update biometric_imports i set rows_valid = x.v, rows_ignored = x.ig, rows_duplicated = x.du
  from (select import_id, count(*) filter (where is_attendance and not is_duplicate) v,
               count(*) filter (where not is_attendance) ig, count(*) filter (where is_duplicate) du
        from biometric_events where tenant_id = _tenant group by import_id) x
  where x.import_id = i.id;

  select count(*) filter (where is_attendance and not is_duplicate), count(*) filter (where is_duplicate)
    into n_val, n_dup from biometric_events where tenant_id = _tenant;
  return jsonb_build_object('desde', v_desde, 'hasta', v_hasta, 'jornadas', n_jor, 'marcaciones_validas', n_val,
                            'repetidas', n_dup, 'empleados_nuevos', n_emp);
end $$;
revoke all on function public.reconstruir_historico(uuid) from public, anon, authenticated;
grant execute on function public.reconstruir_historico(uuid) to service_role;

-- Vista del control diario: tiempo en la empresa y descanso descontado
create or replace view public.asistencia_reporte with (security_invoker = true) as
select a.id, a.tenant_id, a.employee_id, a.work_date, a.shift_id, a.first_in, a.last_out,
       a.worked_minutes, a.expected_minutes, a.late_minutes, a.status, a.overtime_minutes,
       a.night_minutes, a.sunday_holiday_minutes, a.is_rest_day, a.is_manual, a.notes,
       e.document, e.full_name, e.position, e.employer_id, e.biometric_group,
       em.name as employer_name, c.name as campaign_name, s.name as shift_name,
       case when e.employer_id is null then (select public.incluye_sin_empresa())
            else coalesce(em.include_in_reports, true) end as en_reportes,
       a.first_in::time as hora_entrada, a.last_out::time as hora_salida,
       e.campaign_id, a.overtime_night_minutes, cc.name as cost_center_name,
       a.stay_minutes, a.break_applied_minutes
from public.attendance_daily a
join public.employees e on e.id = a.employee_id
left join public.employers em on em.id = e.employer_id
left join public.campaigns c on c.id = e.campaign_id
left join public.cost_centers cc on cc.id = e.cost_center_id
left join public.shifts s on s.id = a.shift_id;
grant select on public.asistencia_reporte to authenticated, service_role;

-- Reporte por empleado con tiempo en la empresa y descanso
drop function if exists public.reporte_asistencia_empleado(date, date, uuid, boolean);
create function public.reporte_asistencia_empleado(_desde date, _hasta date, _campaign uuid default null, _incluir_excluidos boolean default false)
returns table (documento text, empleado text, cargo text, campana text, centro_costo text, empleador text,
  dias_marcados bigint, completas bigint, incompletas bigint, tiempo_en_empresa numeric, descanso_descontado numeric,
  horas_trabajadas numeric, horas_esperadas numeric, extra_diurnas numeric, extra_nocturnas numeric,
  recargo_nocturno numeric, dominical_festivo numeric, llegadas_tarde bigint, minutos_tarde bigint)
language sql stable security invoker set search_path = public as $$
  select document, max(full_name), max(position), max(campaign_name), max(cost_center_name), max(employer_name),
    count(*), count(*) filter (where status = 'completa'), count(*) filter (where status = 'incompleta'),
    round(sum(stay_minutes) / 60.0, 2), round(sum(break_applied_minutes) / 60.0, 2),
    round(sum(worked_minutes) / 60.0, 2), round(sum(expected_minutes) / 60.0, 2),
    round(sum(overtime_minutes - overtime_night_minutes) / 60.0, 2), round(sum(overtime_night_minutes) / 60.0, 2),
    round(sum(greatest(0, night_minutes - overtime_night_minutes)) / 60.0, 2), round(sum(sunday_holiday_minutes) / 60.0, 2),
    count(*) filter (where late_minutes > 0), coalesce(sum(late_minutes), 0)
  from asistencia_reporte
  where work_date between _desde and _hasta and (_incluir_excluidos or en_reportes)
    and (_campaign is null or campaign_id = _campaign)
  group by document
  order by 2;
$$;
grant execute on function public.reporte_asistencia_empleado(date, date, uuid, boolean) to authenticated;
