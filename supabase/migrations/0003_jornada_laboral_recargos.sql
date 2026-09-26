alter table public.attendance_daily
  add column if not exists ordinary_minutes integer not null default 0,
  add column if not exists overtime_minutes integer not null default 0,
  add column if not exists night_minutes integer not null default 0,
  add column if not exists sunday_holiday_minutes integer not null default 0,
  add column if not exists is_rest_day boolean not null default false;

insert into public.rules (tenant_id, key, value, description)
select t.id, r.key, r.value::jsonb, r.descr from public.tenants t,
(values
 ('dias_laborales','[1,2,3,4,5]','Días laborales ordinarios (0=domingo … 6=sábado)'),
 ('horario_ordinario_inicio','"08:00"','Hora inicio del horario ordinario'),
 ('horario_ordinario_fin','"17:00"','Hora fin del horario ordinario'),
 ('nocturna_inicio','"21:00"','Desde qué hora se considera hora nocturna'),
 ('nocturna_fin','"06:00"','Hasta qué hora se considera hora nocturna'),
 ('horas_extra_despues','8','Horas trabajadas a partir de las cuales se cuenta hora extra'),
 ('aplica_dominical_festivo','true','Calcular recargo dominical y festivo')
) as r(key,value,descr)
on conflict do nothing;

insert into public.holidays (tenant_id, country, holiday_date, description)
select t.id, 'CO', h.d::date, h.n from public.tenants t,
(values ('2026-01-01','Año Nuevo'),('2026-01-12','Reyes Magos'),('2026-03-23','San José'),('2026-04-02','Jueves Santo'),('2026-04-03','Viernes Santo'),('2026-05-01','Día del Trabajo'),('2026-05-18','Ascensión'),('2026-06-08','Corpus Christi'),('2026-06-15','Sagrado Corazón'),('2026-06-29','San Pedro y San Pablo'),('2026-07-20','Independencia'),('2026-08-07','Batalla de Boyacá'),('2026-08-17','Asunción'),('2026-10-12','Día de la Raza'),('2026-11-02','Todos los Santos'),('2026-11-16','Independencia de Cartagena'),('2026-12-08','Inmaculada Concepción'),('2026-12-25','Navidad'),
('2027-01-01','Año Nuevo'),('2027-01-11','Reyes Magos'),('2027-03-22','San José'),('2027-03-25','Jueves Santo'),('2027-03-26','Viernes Santo'),('2027-05-01','Día del Trabajo'),('2027-05-10','Ascensión'),('2027-05-31','Corpus Christi'),('2027-06-07','Sagrado Corazón'),('2027-07-05','San Pedro y San Pablo'),('2027-07-20','Independencia'),('2027-08-07','Batalla de Boyacá'),('2027-08-16','Asunción'),('2027-10-18','Día de la Raza'),('2027-11-01','Todos los Santos'),('2027-11-15','Independencia de Cartagena'),('2027-12-08','Inmaculada Concepción'),('2027-12-25','Navidad')) as h(d,n)
where not exists (select 1 from public.holidays x where x.tenant_id=t.id and x.holiday_date=h.d::date);

create or replace function public.minutos_en_ventana(_ini timestamp, _fin timestamp, _vi time, _vf time)
returns integer language plpgsql immutable set search_path = public as $$
declare d date; total numeric := 0; a timestamp; b timestamp;
begin
  if _ini is null or _fin is null or _fin <= _ini then return 0; end if;
  d := _ini::date - 1;
  while d <= _fin::date loop
    a := d + _vi;
    b := case when _vf <= _vi then (d + 1) + _vf else d + _vf end;
    total := total + greatest(0, extract(epoch from (least(b,_fin) - greatest(a,_ini)))/60);
    d := d + 1;
  end loop;
  return total::int;
end $$;

create or replace function public.recalcular_asistencia(_tenant uuid, _desde date, _hasta date)
returns integer language plpgsql security definer set search_path = public as $function$
declare
  v_rows integer; v_ventana integer; v_jornada integer; v_extra integer;
  v_ni time; v_nf time; v_dias int[]; v_dom boolean;
begin
  if not public.tenant_visible(_tenant) then raise exception 'Sin acceso a esta empresa'; end if;
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
           s.start_time, s.break_minutes, s.tolerance_in_minutes, d.classification, e.event_at,
           case when s.crosses_midnight and e.event_at::time < (s.end_time + make_interval(hours => v_ventana))
             then (e.event_at::date - 1) else e.event_at::date end as work_date
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