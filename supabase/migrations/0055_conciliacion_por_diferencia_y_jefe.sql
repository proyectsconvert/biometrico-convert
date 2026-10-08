-- Migración 0055: Conciliación por diferencia de horas, aprobación automática sin horas y jefe inmediato
-- 1. Conciliación: cuadra si el biométrico respalda igual o más de lo reportado; «revisar» si respalda
--    un poco menos (dentro de la tolerancia); «no cuadra» si respalda menos más allá de la tolerancia.
--    Los días trabajados sin marcación ya no cambian el resultado (se ven en el detalle por día).
-- 2. Totales sin horas, ajustes, bonificaciones ni comisiones: no hay nada que revisar y quedan
--    aprobados de una vez (también los pendientes que ya existen). Si después se les reportan horas,
--    vuelven a «pendiente».
-- 3. employees.jefe_id: jefe inmediato (supervisor, coordinador…) de cada persona, para filtrar y
--    ordenar por supervisor.

/* ---------- 1. Conciliación ---------- */
CREATE OR REPLACE FUNCTION public.conciliacion_novedades(_desde date, _hasta date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with cfg as (
  select coalesce((select (value#>>'{}')::numeric from rules
    where tenant_id = public.current_tenant_id() and key = 'tolerancia_conciliacion_horas'), 0.5) as tol
),
t as (
  select nt.*, e.id as emp_id, e.employer_id,
         (select c.name from campaigns c where c.id = e.campaign_id) as campana_empleado
  from novelty_totals nt
  left join employees e on e.tenant_id = nt.tenant_id and e.document = nt.document
  where nt.period_start <= _hasta and nt.period_end >= _desde
    and public.incluye_en_reportes(e.employer_id, nt.tenant_id)
),
bio as (
  select t.id,
    count(a.id) as dias_marcados,
    count(a.id) filter (where a.status = 'incompleta') as dias_incompletos,
    round(coalesce(sum(greatest(0, a.night_minutes - a.overtime_night_minutes)),0)/60.0, 2) as nocturnas,
    round(coalesce(sum(a.sunday_holiday_minutes),0)/60.0, 2) as dom_fest,
    round(coalesce(sum(a.overtime_minutes - a.overtime_night_minutes),0)/60.0, 2) as extra_diurnas,
    round(coalesce(sum(a.overtime_night_minutes),0)/60.0, 2) as extra_nocturnas,
    round(coalesce(sum(a.worked_minutes),0)/60.0, 2) as trabajadas
  from t left join attendance_daily a on a.employee_id = t.emp_id and a.work_date between t.period_start and t.period_end
  group by t.id
),
dias as (
  select t.id,
    count(*) filter (where public.es_dia_trabajado(n.novelty_type) and a.id is null) as asiste_sin_marca,
    count(*) filter (where public.es_dia_trabajado(n.novelty_type) and a.status = 'incompleta') as asiste_incompleta,
    count(*) filter (where not public.es_dia_trabajado(n.novelty_type) and a.status = 'completa') as marca_en_novedad,
    count(*) filter (where public.es_dia_trabajado(n.novelty_type)) as dias_asiste
  from t join novelty_entries n on n.tenant_id = t.tenant_id and n.document = t.document
    and n.work_date between t.period_start and t.period_end
  left join attendance_daily a on a.employee_id = t.emp_id and a.work_date = n.work_date
  group by t.id
),
cobertura as (
  -- ¿hay datos del biométrico en el periodo? (si no, no se puede validar)
  select t.id, exists (select 1 from attendance_daily x where x.tenant_id = t.tenant_id
                         and x.work_date between t.period_start and t.period_end) as hay_biometria
  from t
),
fila as (
  select t.*, b.dias_marcados, b.dias_incompletos, b.nocturnas, b.dom_fest, b.extra_diurnas, b.extra_nocturnas, b.trabajadas,
         coalesce(d.asiste_sin_marca,0) asiste_sin_marca, coalesce(d.asiste_incompleta,0) asiste_incompleta,
         coalesce(d.marca_en_novedad,0) marca_en_novedad, coalesce(d.dias_asiste,0) dias_asiste, c.hay_biometria, cfg.tol,
         (t.horas_dom_fest_090 + t.horas_dom_fest_190) as rep_dom_fest
  from t join bio b using (id) left join dias d using (id) join cobertura c using (id) cross join cfg
)
select coalesce(jsonb_agg(jsonb_build_object(
  'id', f.id, 'document', f.document, 'full_name', f.full_name, 'position', f.position,
  'campaign_label', f.campaign_label, 'campana_empleado', f.campana_empleado, 'period_start', f.period_start, 'period_end', f.period_end,
  'encontrado', f.emp_id is not null, 'hay_biometria', f.hay_biometria,
  'dias_asiste', f.dias_asiste, 'dias_marcados', f.dias_marcados, 'trabajadas', f.trabajadas,
  'asiste_sin_marca', f.asiste_sin_marca, 'asiste_incompleta', f.asiste_incompleta, 'marca_en_novedad', f.marca_en_novedad,
  'conceptos', jsonb_build_array(
     jsonb_build_object('clave','nocturnas','etiqueta','Nocturnas (0,35)','reportado',f.horas_nocturnas,'biometrico',f.nocturnas),
     jsonb_build_object('clave','dom_fest','etiqueta','Dom. y festivos (0,90 + 1,90)','reportado',f.rep_dom_fest,'biometrico',f.dom_fest),
     jsonb_build_object('clave','extra_diurnas','etiqueta','Extras diurnas (1,25)','reportado',f.horas_extra_diurnas,'biometrico',f.extra_diurnas),
     jsonb_build_object('clave','extra_nocturnas','etiqueta','Extras nocturnas (1,75)','reportado',f.horas_extra_nocturnas,'biometrico',f.extra_nocturnas)),
  'ajustes', f.ajuste_horas_nocturnas + f.ajuste_dom_fest_090 + f.ajuste_dom_fest_190 + f.ajuste_extra_diurnas + f.ajuste_extra_nocturnas,
  'bonificacion', f.bonificacion, 'comisiones', f.comisiones, 'observaciones', f.observaciones,
  'estado', case
     when f.emp_id is null then 'no_encontrado'
     when not f.hay_biometria then 'sin_biometria'
     when f.horas_nocturnas - f.nocturnas > f.tol or f.rep_dom_fest - f.dom_fest > f.tol
       or f.horas_extra_diurnas - f.extra_diurnas > f.tol or f.horas_extra_nocturnas - f.extra_nocturnas > f.tol
       then 'inconsistente'
     -- Revisar: reporta un poco más de lo que respalda el biométrico (dentro de la tolerancia).
     -- Si el biométrico respalda igual o más, cuadra (los días sin marcación son informativos).
     when f.horas_nocturnas - f.nocturnas > 0.01 or f.rep_dom_fest - f.dom_fest > 0.01
       or f.horas_extra_diurnas - f.extra_diurnas > 0.01 or f.horas_extra_nocturnas - f.extra_nocturnas > 0.01
       then 'advertencia'
     else 'coherente' end,
  'review_status', f.review_status, 'review_comment', f.review_comment, 'reviewed_at', f.reviewed_at,
  'reviewed_by', (select p.full_name from profiles p where p.id = f.reviewed_by)
) order by f.full_name), '[]'::jsonb)
from fila f;
$function$;

/* ---------- 2. Aprobación automática sin horas ---------- */
create or replace function public._total_sin_horas(t public.novelty_totals)
returns boolean
language sql
immutable
as $$
  select coalesce(t.horas_nocturnas, 0) = 0 and coalesce(t.ajuste_horas_nocturnas, 0) = 0
     and coalesce(t.horas_dom_fest_090, 0) = 0 and coalesce(t.ajuste_dom_fest_090, 0) = 0
     and coalesce(t.horas_dom_fest_190, 0) = 0 and coalesce(t.ajuste_dom_fest_190, 0) = 0
     and coalesce(t.horas_extra_diurnas, 0) = 0 and coalesce(t.ajuste_extra_diurnas, 0) = 0
     and coalesce(t.horas_extra_nocturnas, 0) = 0 and coalesce(t.ajuste_extra_nocturnas, 0) = 0
     and coalesce(t.bonificacion, 0) = 0 and coalesce(t.comisiones, 0) = 0;
$$;

create or replace function public.aprobar_total_sin_horas()
returns trigger
language plpgsql
set search_path = public
as $$
declare c_auto constant text := 'Aprobado automáticamente: sin horas, bonificaciones ni comisiones reportadas';
begin
  if public._total_sin_horas(new) then
    -- Al crearlo, o cuando le quitan todas las horas (no cuando Nómina lo reabre a mano)
    if new.review_status = 'pendiente'
       and (tg_op = 'INSERT' or not public._total_sin_horas(old)) then
      new.review_status := 'aprobado';
      new.review_comment := c_auto;
      new.reviewed_by := null;
      new.reviewed_at := now();
    end if;
  elsif tg_op = 'UPDATE' and old.review_status = 'aprobado' and old.review_comment = c_auto then
    -- Le reportaron horas a un total aprobado automáticamente: necesita revisión
    new.review_status := 'pendiente';
    new.review_comment := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
  end if;
  return new;
end $$;

drop trigger if exists aprobar_total_sin_horas on public.novelty_totals;
create trigger aprobar_total_sin_horas before insert or update on public.novelty_totals
  for each row execute function public.aprobar_total_sin_horas();

update public.novelty_totals t set
  review_status = 'aprobado',
  review_comment = 'Aprobado automáticamente: sin horas, bonificaciones ni comisiones reportadas',
  reviewed_by = null,
  reviewed_at = now()
where t.review_status = 'pendiente' and public._total_sin_horas(t);

/* ---------- 3. Jefe inmediato ---------- */
alter table public.employees add column if not exists jefe_id uuid references public.employees(id) on delete set null;
create index if not exists employees_jefe_idx on public.employees (jefe_id);
alter table public.employees drop constraint if exists employees_jefe_no_propio;
alter table public.employees add constraint employees_jefe_no_propio check (jefe_id is null or jefe_id <> id);

notify pgrst, 'reload schema';
