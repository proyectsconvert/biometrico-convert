-- Ausentismo correcto para cualquier usuario (también asesores que solo ven lo suyo).
-- Antes, «¿ese día hay datos cargados?» se respondía con los permisos de quien consulta: un asesor solo
-- ve sus jornadas, así que los días que NO vino parecían días sin datos y no contaban como ausencia.
-- Ahora se revisa a nivel de empresa (solo se devuelven fechas, ningún dato de personas), y la tendencia
-- diaria muestra todos los días con datos del periodo.

create or replace function public.dias_con_datos(_desde date, _hasta date)
returns table (fecha date, laboral boolean)
language sql stable security definer set search_path = public as $$
  with dias_lab as (
    select coalesce((select array(select jsonb_array_elements_text(value)::int) from rules
                     where tenant_id = public.current_tenant_id() and key = 'dias_laborales'), array[1,2,3,4,5]) as dias
  )
  select d::date,
         extract(dow from d)::int = any(dias_lab.dias)
         and not exists (select 1 from holidays h where h.tenant_id = public.current_tenant_id()
                         and h.holiday_date = d::date and h.is_active)
  from generate_series(_desde, _hasta, interval '1 day') d, dias_lab
  where exists (select 1 from attendance_daily x where x.tenant_id = public.current_tenant_id() and x.work_date = d::date);
$$;
revoke all on function public.dias_con_datos(date, date) from public, anon;
grant execute on function public.dias_con_datos(date, date) to authenticated;

create or replace function public.dias_laborales_con_datos(_desde date, _hasta date)
returns table (fecha date) language sql stable set search_path = public as $$
  select fecha from public.dias_con_datos(_desde, _hasta) where laboral;
$$;

CREATE OR REPLACE FUNCTION public.panel_bi(_desde date, _hasta date, _campaigns uuid[] DEFAULT NULL::uuid[], _cost_centers uuid[] DEFAULT NULL::uuid[], _employees uuid[] DEFAULT NULL::uuid[], _search text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
  where (_campaigns is null or cardinality(_campaigns) = 0 or e.campaign_id = any(_campaigns))
    and (_cost_centers is null or cardinality(_cost_centers) = 0 or e.cost_center_id = any(_cost_centers))
    and (_employees is null or cardinality(_employees) = 0 or e.id = any(_employees))
    and (_search is null or _search = '' or e.document ilike '%' || _search || '%' or e.full_name ilike '%' || _search || '%' or coalesce(e.position, '') ilike '%' || _search || '%')
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
),
-- Ausentismo: personas activas que marcan en el periodo × días laborales con datos, sin marcación ese día
cal as (select fecha from public.dias_laborales_con_datos(_desde, _hasta)),
base as (
  select distinct on (ad.employee_id) ad.employee_id, ad.full_name, ad.document, ad.campana,
         greatest(coalesce(e.hire_date, '-infinity'::date),
                  (select min(x.work_date) from attendance_daily x where x.employee_id = ad.employee_id)) as desde_p,
         case when e.termination_date is not null then e.termination_date
              when e.status = 'activo' then 'infinity'::date
              else (select max(x.work_date) from attendance_daily x where x.employee_id = ad.employee_id) end as hasta_p
  from ad join employees e on e.id = ad.employee_id
),
-- días en que cada persona podía faltar (se busca la marcación por índice, no en el CTE)
elig as (
  select c.fecha, b.employee_id, b.full_name, b.document, b.campana,
         not exists (select 1 from attendance_daily a where a.employee_id = b.employee_id and a.work_date = c.fecha) as ausente
  from base b join cal c on c.fecha between b.desde_p and b.hasta_p
),
aus as (
  select el.fecha, el.employee_id, el.full_name, el.document, el.campana,
         (select n.novelty_type from novelty_entries n
          where n.document = el.document and n.work_date = el.fecha and n.status <> 'rechazada' limit 1) as novedad
  from elig el where el.ausente
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
      'incluye_sin_empresa', (select sin_empresa from cfg),
      'dias_laborales', (select count(*) from cal),
      'personas_base', (select count(*) from base),
      'ausencias', (select count(*) from aus),
      'ausencias_justificadas', (select count(*) from aus where novedad is not null),
      'personas_ausentes', (select count(distinct employee_id) from aus),
      'dias_posibles', (select count(*) from elig),
      'tasa_ausentismo', (select round(100.0 * (select count(*) from aus) / nullif((select count(*) from elig), 0), 2))
    ) from ad),
  -- Todos los días con datos del periodo (aunque la persona no haya marcado), no solo los días con jornadas visibles
  'serie', (select coalesce(jsonb_agg(x order by x->>'fecha'), '[]') from (
      select jsonb_build_object('fecha', c.fecha,
        'completas', coalesce(d.completas, 0), 'incompletas', coalesce(d.incompletas, 0),
        'horas_extra', coalesce(d.horas_extra, 0), 'tarde', coalesce(d.tarde, 0),
        'laboral', c.laboral,
        'ausentes', case when c.laboral then coalesce(a.ausentes, 0) end,
        'ausentes_justificados', case when c.laboral then coalesce(a.justificados, 0) end) x
      from public.dias_con_datos(_desde, _hasta) c
      left join (select work_date,
                   count(*) filter (where status='completa') completas,
                   count(*) filter (where status='incompleta') incompletas,
                   round(coalesce(sum(overtime_minutes),0)/60.0,1) horas_extra,
                   count(*) filter (where late_minutes > 0) tarde
            from ad group by work_date) d on d.work_date = c.fecha
      left join (select fecha, count(*) ausentes, count(*) filter (where novedad is not null) justificados
                 from aus group by fecha) a on a.fecha = c.fecha) s),
  'campanas', (select coalesce(jsonb_agg(x order by (x->>'jornadas')::int desc), '[]') from (
      select jsonb_build_object('campana', g.campana,
        'personas', g.personas, 'jornadas', g.jornadas, 'cumplimiento', g.cumplimiento,
        'horas_extra', g.horas_extra, 'horas_trabajadas', g.horas_trabajadas, 'tarde', g.tarde,
        'ausencias', coalesce(a.ausencias, 0),
        'tasa_ausentismo', round(100.0 * coalesce(a.ausencias, 0) / nullif(a.posibles, 0), 2)) x
      from (select campana, count(distinct employee_id) personas, count(*) jornadas,
                   round(100.0 * count(*) filter (where status='completa') / nullif(count(*),0), 1) cumplimiento,
                   round(coalesce(sum(overtime_minutes),0)/60.0,1) horas_extra,
                   round(coalesce(sum(worked_minutes),0)/60.0,1) horas_trabajadas,
                   count(*) filter (where late_minutes > 0) tarde
            from ad group by campana) g
      left join (select campana, count(*) posibles, count(*) filter (where ausente) ausencias
                 from elig group by campana) a on a.campana = g.campana) s),
  'semana', (select coalesce(jsonb_agg(x order by (x->>'dow')::int), '[]') from (
      select jsonb_build_object('dow', w.dow, 'jornadas', w.jornadas, 'incompletas', w.incompletas, 'tarde', w.tarde,
        'ausencias', coalesce(a.ausencias, 0)) x
      from (select extract(dow from work_date)::int dow, count(*) jornadas,
                   count(*) filter (where status <> 'completa') incompletas,
                   count(*) filter (where late_minutes > 0) tarde
            from ad group by 1) w
      left join (select extract(dow from fecha)::int dow, count(*) ausencias from aus group by 1) a on a.dow = w.dow) s),
  'horas_entrada', (select coalesce(jsonb_agg(x order by (x->>'hora')::int), '[]') from (
      select jsonb_build_object('hora', extract(hour from first_in)::int, 'personas', count(*)) x
      from ad where first_in is not null group by extract(hour from first_in)) s),
  -- Rankings completos (el panel los pagina)
  'top_tarde', (select coalesce(jsonb_agg(x), '[]') from (
      select jsonb_build_object('nombre', full_name, 'documento', document, 'campana', campana,
        'veces', count(*) filter (where late_minutes > 0), 'minutos', sum(late_minutes)) x
      from ad group by full_name, document, campana having sum(late_minutes) > 0
      order by sum(late_minutes) desc limit 3000) s),
  'top_extra', (select coalesce(jsonb_agg(x), '[]') from (
      select jsonb_build_object('nombre', full_name, 'documento', document, 'campana', campana,
        'horas', round(sum(overtime_minutes)/60.0,1), 'jornadas', count(*) filter (where overtime_minutes > 0)) x
      from ad group by full_name, document, campana having sum(overtime_minutes) > 0
      order by sum(overtime_minutes) desc limit 3000) s),
  'top_ausentes', (select coalesce(jsonb_agg(x), '[]') from (
      select jsonb_build_object('nombre', full_name, 'documento', document, 'campana', campana,
        'dias', count(*), 'justificados', count(*) filter (where novedad is not null),
        'ultima', max(fecha),
        'ultima_marca', (select max(x.work_date) from attendance_daily x where x.employee_id = aus.employee_id)) x
      from aus group by employee_id, full_name, document, campana
      order by count(*) desc, count(*) filter (where novedad is null) desc limit 3000) s),
  'motivos_ausencia', (select coalesce(jsonb_agg(x order by (x->>'total')::int desc), '[]') from (
      select jsonb_build_object('motivo', coalesce(novedad, 'Sin novedad reportada'), 'total', count(*)) x
      from aus group by coalesce(novedad, 'Sin novedad reportada')) s),
  'novedades', (select coalesce(jsonb_agg(x order by (x->>'total')::int desc), '[]') from (
      select jsonb_build_object('tipo', novelty_type, 'total', count(*)) x from nov group by novelty_type) s),
  'rango', (select jsonb_build_object('min', min(work_date), 'max', max(work_date)) from attendance_daily)
);
$function$;
