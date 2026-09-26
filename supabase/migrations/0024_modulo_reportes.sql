-- Migración 0024: Módulo de Reportes
-- Todas las funciones son SECURITY INVOKER: respetan la RLS del usuario que consulta.
--   · Asesor/BO con alcance «solo yo»: solo el empleado vinculado a su usuario.
--   · Con campañas asignadas: todas las personas de esas campañas.
--   · Admin/Nómina/Super: toda la empresa.
-- Por defecto excluyen al personal de empleadores que no cuentan en reportes.

-- 1. La vista del control diario expone campaña, extra nocturna y centro de costo
create or replace view public.asistencia_reporte with (security_invoker = true) as
select a.id, a.tenant_id, a.employee_id, a.work_date, a.shift_id, a.first_in, a.last_out,
       a.worked_minutes, a.expected_minutes, a.late_minutes, a.status, a.overtime_minutes,
       a.night_minutes, a.sunday_holiday_minutes, a.is_rest_day, a.is_manual, a.notes,
       e.document, e.full_name, e.position, e.employer_id, e.biometric_group,
       em.name as employer_name, c.name as campaign_name, s.name as shift_name,
       case when e.employer_id is null then coalesce(cfg.sin_empresa, true)
            else coalesce(em.include_in_reports, true) end as en_reportes,
       a.first_in::time as hora_entrada, a.last_out::time as hora_salida,
       e.campaign_id, a.overtime_night_minutes, cc.name as cost_center_name
from public.attendance_daily a
join public.employees e on e.id = a.employee_id
left join public.employers em on em.id = e.employer_id
left join public.campaigns c on c.id = e.campaign_id
left join public.cost_centers cc on cc.id = e.cost_center_id
left join public.shifts s on s.id = a.shift_id
left join lateral (
  select (r.value#>>'{}')::boolean as sin_empresa from public.rules r
  where r.tenant_id = a.tenant_id and r.key = 'reportes_incluir_sin_empresa'
) cfg on true;
grant select on public.asistencia_reporte to authenticated, service_role;

-- 2. Horas y recargos por empleado (resumen del periodo, formato nómina)
create or replace function public.reporte_asistencia_empleado(_desde date, _hasta date, _campaign uuid default null, _incluir_excluidos boolean default false)
returns table (documento text, empleado text, cargo text, campana text, centro_costo text, empleador text,
  dias_marcados bigint, completas bigint, incompletas bigint, horas_trabajadas numeric, horas_esperadas numeric,
  extra_diurnas numeric, extra_nocturnas numeric, recargo_nocturno numeric, dominical_festivo numeric,
  llegadas_tarde bigint, minutos_tarde bigint)
language sql stable security invoker set search_path = public as $$
  select document, max(full_name), max(position), max(campaign_name), max(cost_center_name), max(employer_name),
    count(*), count(*) filter (where status = 'completa'), count(*) filter (where status = 'incompleta'),
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

-- 3. Asistencia por campaña
create or replace function public.reporte_asistencia_campana(_desde date, _hasta date, _campaign uuid default null, _incluir_excluidos boolean default false)
returns table (campana text, personas bigint, jornadas bigint, completas bigint, incompletas bigint, pct_completas numeric,
  horas_trabajadas numeric, horas_esperadas numeric, extra_diurnas numeric, extra_nocturnas numeric,
  recargo_nocturno numeric, dominical_festivo numeric, llegadas_tarde bigint)
language sql stable security invoker set search_path = public as $$
  select coalesce(campaign_name, 'Sin campaña'), count(distinct employee_id), count(*),
    count(*) filter (where status = 'completa'), count(*) filter (where status = 'incompleta'),
    round(100.0 * count(*) filter (where status = 'completa') / nullif(count(*), 0), 1),
    round(sum(worked_minutes) / 60.0, 1), round(sum(expected_minutes) / 60.0, 1),
    round(sum(overtime_minutes - overtime_night_minutes) / 60.0, 1), round(sum(overtime_night_minutes) / 60.0, 1),
    round(sum(greatest(0, night_minutes - overtime_night_minutes)) / 60.0, 1), round(sum(sunday_holiday_minutes) / 60.0, 1),
    count(*) filter (where late_minutes > 0)
  from asistencia_reporte
  where work_date between _desde and _hasta and (_incluir_excluidos or en_reportes)
    and (_campaign is null or campaign_id = _campaign)
  group by 1
  order by 3 desc;
$$;

-- 4. Marcaciones incompletas (una sola marcación en el día)
create or replace function public.reporte_incompletas(_desde date, _hasta date, _campaign uuid default null, _incluir_excluidos boolean default false)
returns table (fecha date, documento text, empleado text, campana text, empleador text, unica_marcacion time)
language sql stable security invoker set search_path = public as $$
  select work_date, document, full_name, campaign_name, employer_name, hora_entrada
  from asistencia_reporte
  where status = 'incompleta' and work_date between _desde and _hasta and (_incluir_excluidos or en_reportes)
    and (_campaign is null or campaign_id = _campaign)
  order by work_date desc, full_name;
$$;

-- 5. Llegadas tarde (requiere turno asignado)
create or replace function public.reporte_tardanzas(_desde date, _hasta date, _campaign uuid default null, _incluir_excluidos boolean default false)
returns table (fecha date, documento text, empleado text, campana text, turno text, entrada time, minutos_tarde integer)
language sql stable security invoker set search_path = public as $$
  select work_date, document, full_name, campaign_name, shift_name, hora_entrada, late_minutes
  from asistencia_reporte
  where late_minutes > 0 and work_date between _desde and _hasta and (_incluir_excluidos or en_reportes)
    and (_campaign is null or campaign_id = _campaign)
  order by late_minutes desc;
$$;

-- 6. Ausentismo: días laborales sin marcación de personas activas que sí marcaron en el periodo
create or replace function public.reporte_ausentismo(_desde date, _hasta date, _campaign uuid default null, _incluir_excluidos boolean default false)
returns table (fecha date, documento text, empleado text, campana text, empleador text, novedad text)
language sql stable security invoker set search_path = public as $$
  with dias_lab as (
    select coalesce((select array(select jsonb_array_elements_text(value)::int) from rules
                     where tenant_id = public.current_tenant_id() and key = 'dias_laborales'), array[1,2,3,4,5]) as dias
  ),
  personas as (
    select distinct employee_id, document, full_name, campaign_name, employer_name
    from asistencia_reporte
    where work_date between _desde and _hasta and (_incluir_excluidos or en_reportes)
      and (_campaign is null or campaign_id = _campaign)
  ),
  calendario as (
    select d::date as fecha from generate_series(_desde, _hasta, interval '1 day') d, dias_lab
    where extract(dow from d)::int = any(dias_lab.dias)
      and not exists (select 1 from holidays h where h.holiday_date = d::date and h.is_active)
  )
  select c.fecha, p.document, p.full_name, p.campaign_name, p.employer_name, n.novelty_type
  from personas p
  join employees e on e.id = p.employee_id and e.status = 'activo'
  cross join calendario c
  left join novelty_entries n on n.document = p.document and n.work_date = c.fecha
  where not exists (select 1 from attendance_daily a where a.employee_id = p.employee_id and a.work_date = c.fecha)
  order by c.fecha desc, p.full_name;
$$;

-- 7. Novedades por empleado y tipo
create or replace function public.reporte_novedades(_desde date, _hasta date, _campaign uuid default null, _incluir_excluidos boolean default false)
returns table (documento text, empleado text, campana text, tipo text, dias bigint, desde date, hasta date, estado text)
language sql stable security invoker set search_path = public as $$
  select n.document, max(n.full_name), max(coalesce(c.name, n.campaign_label)), n.novelty_type, count(*),
         min(n.work_date), max(n.work_date), string_agg(distinct n.status, ', ')
  from novelty_entries n
  left join employees e on e.tenant_id = n.tenant_id and e.document = n.document
  left join campaigns c on c.id = e.campaign_id
  where n.work_date between _desde and _hasta
    and (_incluir_excluidos or public.incluye_en_reportes(e.employer_id, n.tenant_id))
    and (_campaign is null or e.campaign_id = _campaign)
  group by n.document, n.novelty_type
  order by 2, 4;
$$;

grant execute on function public.reporte_asistencia_empleado(date, date, uuid, boolean),
  public.reporte_asistencia_campana(date, date, uuid, boolean), public.reporte_incompletas(date, date, uuid, boolean),
  public.reporte_tardanzas(date, date, uuid, boolean), public.reporte_ausentismo(date, date, uuid, boolean),
  public.reporte_novedades(date, date, uuid, boolean) to authenticated;

-- 8. El asesor puede ver y descargar sus propios reportes (la RLS limita a su información)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.module = 'reportes' and p.action in ('ver', 'exportar')
where r.code = 'asesor'
on conflict do nothing;
