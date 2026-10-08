-- Migración 0057: El motor de jornadas respeta todas las Reglas de cálculo
-- 1. «Máximo de horas por jornada» (max_horas_jornada): lo trabajado no pasa del máximo, y con ello
--    tampoco las extras (antes la regla se guardaba pero no se aplicaba).
-- 2. Dominical y festivo por horas reales: cuentan los minutos que caen en domingo o festivo. Un turno
--    de sábado 22:00 a domingo 06:00 suma 6 h dominicales; uno de domingo 22:00 a lunes 06:00, 2 h
--    (antes se tomaba la jornada completa según el día de entrada).
-- 3. Los festivos son día de descanso: no se espera jornada (expected_minutes = 0), igual que los días
--    no laborales de «dias_laborales».

create or replace function public.minutos_dom_fest(_tenant uuid, _ini timestamp, _fin timestamp)
returns integer
language plpgsql
stable
set search_path = public
as $$
declare dia date; total numeric := 0;
begin
  if _ini is null or _fin is null or _fin <= _ini then return 0; end if;
  dia := _ini::date;
  while dia <= _fin::date loop
    if extract(dow from dia)::int = 0
       or exists (select 1 from holidays h where h.tenant_id = _tenant and h.is_active and h.holiday_date = dia) then
      total := total + greatest(0, extract(epoch from (least(dia + 1, _fin) - greatest(dia::timestamp, _ini))) / 60);
    end if;
    dia := dia + 1;
  end loop;
  return total::int;
end $$;

CREATE OR REPLACE FUNCTION public.recalcular_asistencia(_tenant uuid, _desde date, _hasta date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rows integer; v_ventana integer; v_jornada integer; v_extra integer;
  v_ni time; v_nf time; v_dias int[]; v_dom boolean; v_desc integer; v_desc_desde integer; v_descontar boolean;
  v_max integer;
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
         coalesce(bool_or(case when key='descontar_descanso' then (value#>>'{}')::boolean end),false),
         coalesce(max(case when key='max_horas_jornada' then round((value#>>'{}')::numeric*60)::int end),1440)
    into v_ventana, v_jornada, v_extra, v_ni, v_nf, v_dom, v_desc, v_desc_desde, v_descontar, v_max
  from public.rules where tenant_id=_tenant;

  select coalesce(array(select jsonb_array_elements_text(value)::int), array[1,2,3,4,5]) into v_dias
    from public.rules where tenant_id=_tenant and key='dias_laborales';
  v_dias := coalesce(v_dias, array[1,2,3,4,5]);

  with prog as (
    select t.employee_id, t.fecha, t.shift_id, t.laborable
    from public._turnos_programados(_tenant, array(select generate_series(_desde - 2, _hasta + 1, interval '1 day')::date)) t
  ), ev as (
    select e.employee_id, emp.tenant_id, e.event_at, e.is_duplicate,
           -- con programación: el turno del día (ninguno si es su día de descanso); sin ella, el fijo
           case when pp.employee_id is not null then case when pp.laborable then pp.shift_id end
                else coalesce(emp.shift_id, c.shift_id) end as shift_prev,
           case when pc.employee_id is not null then case when pc.laborable then pc.shift_id end
                else coalesce(emp.shift_id, c.shift_id) end as shift_cur
    from public.biometric_events e
    join public.employees emp on emp.id = e.employee_id
    left join public.campaigns c on c.id = emp.campaign_id
    left join prog pp on pp.employee_id = e.employee_id and pp.fecha = e.event_at::date - 1
    left join prog pc on pc.employee_id = e.employee_id and pc.fecha = e.event_at::date
    where e.tenant_id = _tenant and e.is_attendance
      and e.event_at::date between _desde - 1 and _hasta + 1
  ), ev2 as (
    select ev.*, coalesce(sp.crosses_midnight and ev.event_at::time < (sp.end_time + make_interval(hours => v_ventana)), false) as noc
    from ev left join public.shifts sp on sp.id = ev.shift_prev
  ), base as (
    select ev2.employee_id, ev2.tenant_id, case when ev2.noc then ev2.shift_prev else ev2.shift_cur end as shift_id,
           s.start_time, s.break_minutes, s.tolerance_in_minutes, ev2.event_at, ev2.is_duplicate,
           case when ev2.noc then ev2.event_at::date - 1 else ev2.event_at::date end as work_date
    from ev2
    left join public.shifts s on s.id = case when ev2.noc then ev2.shift_prev else ev2.shift_cur end
  ), agrupado as (
    select employee_id, tenant_id, work_date, min(shift_id::text)::uuid as shift_id,
           min(start_time) as start_time, min(break_minutes) as break_minutes,
           min(tolerance_in_minutes) as tolerance_in_minutes,
           -- Regla universal: primera marcación = entrada, última = salida (sin importar la puerta)
           min(event_at) as first_in,
           case when count(*) filter (where not is_duplicate) > 1 then max(event_at) else null end as last_out
    from base where work_date between _desde and _hasta
    group by employee_id, tenant_id, work_date
  ), permanencia as (
    select a.*,
      case when first_in is not null and last_out is not null and last_out > first_in
        then floor(extract(epoch from (last_out - first_in))/60)::int else 0 end as stay
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
      least(greatest(0, stay - brk), v_max) as worked,
      case when first_in is not null and last_out is not null and last_out > first_in then 'completa'::attendance_status
           when first_in is not null or last_out is not null then 'incompleta'::attendance_status
           else 'sin_marcacion'::attendance_status end as status,
      case when first_in is not null and start_time is not null
             and first_in::time > (start_time + make_interval(mins => coalesce(tolerance_in_minutes,0)))
        then (extract(epoch from (first_in::time - start_time))/60)::int else 0 end as late_minutes,
      public.minutos_en_ventana(first_in, last_out, v_ni, v_nf) as night,
      public.minutos_dom_fest(_tenant, first_in, last_out) as dom_fest_min,
      -- descanso: día no laboral o festivo (no se espera jornada)
      (not (extract(dow from work_date)::int = any(v_dias))
        or exists (select 1 from public.holidays h where h.tenant_id=_tenant and h.is_active and h.holiday_date=d.work_date)) as rest
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
         case when v_dom then least(dom_fest_min, worked) else 0 end, rest,
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
