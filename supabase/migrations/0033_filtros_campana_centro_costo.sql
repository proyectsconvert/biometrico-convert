-- 0033: Soporte de filtros por campaña y centro de costo en marcaciones_reporte y panel_bi

-- 1. Vista marcaciones_reporte con campaña y centro de costo
create or replace view public.marcaciones_reporte with (security_invoker = true) as
select b.id, b.tenant_id, b.import_id, b.event_at, b.door, b.device_code, b.device_name, b.user_group,
       b.raw_user, b.document, b.biometric_name, b.event_type, b.is_attendance, b.is_duplicate,
       b.employee_id, e.employer_id, em.name as employer_name,
       case when e.id is null then true
            when e.employer_id is null then (select public.incluye_sin_empresa())
            else coalesce(em.include_in_reports, true) end as en_reportes,
       e.campaign_id, c.name as campaign_name, cc.name as cost_center_name
from public.biometric_events b
left join public.employees e on e.id = b.employee_id
left join public.employers em on em.id = e.employer_id
left join public.campaigns c on c.id = e.campaign_id
left join public.cost_centers cc on cc.id = e.cost_center_id;

grant select on public.marcaciones_reporte to authenticated, service_role;

-- 2. Función panel_bi con soporte a _cost_center
drop function if exists public.panel_bi(date, date, uuid);
create or replace function public.panel_bi(
  _desde date,
  _hasta date,
  _campaign uuid default null,
  _cost_center uuid default null
)
returns jsonb language sql stable security invoker set search_path = public as $$
with cfg as (
  select coalesce((select (value#>>'{}')::boolean from rules
    where tenant_id = public.current_tenant_id() and key = 'reportes_incluir_sin_empresa'), true) as sin_empresa
),
emp as (
  select e.id, e.document, e.full_name, e.status, e.campaign_id, e.cost_center_id, coalesce(c.name, 'Sin campaña') as campana
  from employees e
  left join campaigns c on c.id = e.campaign_id
  left join employers em on em.id = e.employer_id
  cross join cfg
  where (_campaign is null or e.campaign_id = _campaign)
    and (_cost_center is null or e.cost_center_id = _cost_center)
    and case when e.employer_id is null then cfg.sin_empresa else coalesce(em.include_in_reports, true) end
),
ad as (
  select a.*, emp.full_name, emp.campana, emp.document
  from attendance_daily a join emp on emp.id = a.employee_id
  where a.work_date between _desde and _hasta
),
nov as (
  select n.novelty_type from novelty_entries n
  where n.work_date between _desde and _hasta and n.status <> 'rechazada'
    and n.document in (select document from emp)
)
select jsonb_build_object(
  'kpis', (select jsonb_build_object(
      'empleados_activos', (select count(*) from emp where status = 'activo'),
      'empleados_con_marcacion', count(distinct employee_id),
      'jornadas', count(*),
      'completas', count(*) filter (where status = 'completa'),
      'incompletas', count(*) filter (where status = 'incompleta'),
      'sin_marcacion', count(*) filter (where status = 'sin_marcacion'),
      'horas_trabajadas', round(coalesce(sum(worked_minutes),0)/60.0, 1),
      'horas_esperadas', round(coalesce(sum(expected_minutes),0)/60.0, 1),
      'horas_extra', round(coalesce(sum(overtime_minutes),0)/60.0, 1),
      'horas_nocturnas', round(coalesce(sum(night_minutes),0)/60.0, 1),
      'horas_dominicales', round(coalesce(sum(sunday_holiday_minutes),0)/60.0, 1),
      'minutos_tarde', coalesce(sum(late_minutes),0),
      'llegadas_tarde', count(*) filter (where late_minutes > 0),
      'ajustes_manuales', count(*) filter (where is_manual),
      'jornadas_con_turno', count(*) filter (where shift_id is not null),
      'sin_empresa', (select count(*) from employees where employer_id is null and status = 'activo'),
      'excluidos', (select count(*) from employees e join employers em on em.id = e.employer_id
                    where not em.include_in_reports and e.status = 'activo'),
      'incluye_sin_empresa', (select sin_empresa from cfg)
    ) from ad),
  'serie', (select coalesce(jsonb_agg(x order by x->>'fecha'), '[]') from (
      select jsonb_build_object('fecha', work_date,
        'completas', count(*) filter (where status='completa'),
        'incompletas', count(*) filter (where status='incompleta'),
        'sin_marcacion', count(*) filter (where status='sin_marcacion'),
        'horas_extra', round(coalesce(sum(overtime_minutes),0)/60.0,1),
        'tarde', count(*) filter (where late_minutes > 0)) x
      from ad group by work_date) s),
  'campanas', (select coalesce(jsonb_agg(x order by (x->>'jornadas')::int desc), '[]') from (
      select jsonb_build_object('campana', campana,
        'personas', count(distinct employee_id),
        'jornadas', count(*),
        'cumplimiento', round(100.0 * count(*) filter (where status='completa') / nullif(count(*),0), 1),
        'horas_extra', round(coalesce(sum(overtime_minutes),0)/60.0,1),
        'tarde', count(*) filter (where late_minutes > 0)) x
      from ad group by campana) s),
  'semana', (select coalesce(jsonb_agg(x order by (x->>'dow')::int), '[]') from (
      select jsonb_build_object('dow', extract(dow from work_date)::int,
        'jornadas', count(*),
        'incompletas', count(*) filter (where status <> 'completa'),
        'tarde', count(*) filter (where late_minutes > 0)) x
      from ad group by extract(dow from work_date)) s),
  'horas_entrada', (select coalesce(jsonb_agg(x order by (x->>'hora')::int), '[]') from (
      select jsonb_build_object('hora', extract(hour from first_in)::int, 'personas', count(*)) x
      from ad where first_in is not null group by extract(hour from first_in)) s),
  'top_tarde', (select coalesce(jsonb_agg(x), '[]') from (
      select jsonb_build_object('nombre', full_name, 'documento', document, 'campana', campana,
        'veces', count(*) filter (where late_minutes > 0), 'minutos', sum(late_minutes)) x
      from ad group by full_name, document, campana having sum(late_minutes) > 0
      order by sum(late_minutes) desc limit 8) s),
  'top_extra', (select coalesce(jsonb_agg(x), '[]') from (
      select jsonb_build_object('nombre', full_name, 'documento', document, 'campana', campana,
        'horas', round(sum(overtime_minutes)/60.0,1)) x
      from ad group by full_name, document, campana having sum(overtime_minutes) > 0
      order by sum(overtime_minutes) desc limit 8) s),
  'novedades', (select coalesce(jsonb_agg(x order by (x->>'total')::int desc), '[]') from (
      select jsonb_build_object('tipo', novelty_type, 'total', count(*)) x from nov group by novelty_type) s),
  'rango', (select jsonb_build_object('min', min(work_date), 'max', max(work_date)) from attendance_daily)
);
$$;

grant execute on function public.panel_bi(date, date, uuid, uuid) to authenticated;
