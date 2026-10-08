-- Migración 0058: Las extras nocturnas no reportadas respaldan las nocturnas y extras diurnas reportadas
-- Los supervisores suelen reportar como «nocturnas» todas las horas de noche, incluidas las que pasan
-- de la jornada (que por ley son extras nocturnas, 1,75). Si no reportan extras nocturnas, esas horas
-- completan primero las nocturnas (0,35) que falten y luego las extras diurnas (1,25) que falten.
-- Una misma hora no respalda dos conceptos. Cada concepto informa cuánto viene de extras nocturnas.

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
fila0 as (
  select t.*, b.dias_marcados, b.dias_incompletos, b.nocturnas, b.dom_fest, b.extra_diurnas, b.extra_nocturnas, b.trabajadas,
         coalesce(d.asiste_sin_marca,0) asiste_sin_marca, coalesce(d.asiste_incompleta,0) asiste_incompleta,
         coalesce(d.marca_en_novedad,0) marca_en_novedad, coalesce(d.dias_asiste,0) dias_asiste, c.hay_biometria, cfg.tol,
         (t.horas_dom_fest_090 + t.horas_dom_fest_190) as rep_dom_fest
  from t join bio b using (id) left join dias d using (id) join cobertura c using (id) cross join cfg
),
-- Bolsa de extras nocturnas: las que no se reportaron como extras nocturnas respaldan primero las
-- nocturnas (0,35) reportadas que falten y después las extras diurnas (1,25). Una hora se usa una
-- sola vez y siempre respalda un concepto de menor valor que su 1,75.
bolsa as (
  select f.*, greatest(0, f.extra_nocturnas - least(f.horas_extra_nocturnas, f.extra_nocturnas)) as pool0
  from fila0 f
),
bolsa2 as (
  select b.*, round(least(greatest(0, b.horas_nocturnas - b.nocturnas), b.pool0), 2) as usa_noct
  from bolsa b
),
fila as (
  select b.*, round(least(greatest(0, b.horas_extra_diurnas - b.extra_diurnas), b.pool0 - b.usa_noct), 2) as usa_ed
  from bolsa2 b
)
select coalesce(jsonb_agg(jsonb_build_object(
  'id', f.id, 'document', f.document, 'full_name', f.full_name, 'position', f.position,
  'campaign_label', f.campaign_label, 'campana_empleado', f.campana_empleado, 'period_start', f.period_start, 'period_end', f.period_end,
  'encontrado', f.emp_id is not null, 'hay_biometria', f.hay_biometria,
  'dias_asiste', f.dias_asiste, 'dias_marcados', f.dias_marcados, 'trabajadas', f.trabajadas,
  'asiste_sin_marca', f.asiste_sin_marca, 'asiste_incompleta', f.asiste_incompleta, 'marca_en_novedad', f.marca_en_novedad,
  'conceptos', jsonb_build_array(
     jsonb_build_object('clave','nocturnas','etiqueta','Nocturnas (0,35)','reportado',f.horas_nocturnas,'biometrico',f.nocturnas + f.usa_noct,'de_extra_nocturna',f.usa_noct),
     jsonb_build_object('clave','dom_fest','etiqueta','Dom. y festivos (0,90 + 1,90)','reportado',f.rep_dom_fest,'biometrico',f.dom_fest),
     jsonb_build_object('clave','extra_diurnas','etiqueta','Extras diurnas (1,25)','reportado',f.horas_extra_diurnas,'biometrico',f.extra_diurnas + f.usa_ed,'de_extra_nocturna',f.usa_ed),
     jsonb_build_object('clave','extra_nocturnas','etiqueta','Extras nocturnas (1,75)','reportado',f.horas_extra_nocturnas,'biometrico',f.extra_nocturnas,'usado_en_otros',f.usa_noct + f.usa_ed)),
  'ajustes', f.ajuste_horas_nocturnas + f.ajuste_dom_fest_090 + f.ajuste_dom_fest_190 + f.ajuste_extra_diurnas + f.ajuste_extra_nocturnas,
  'bonificacion', f.bonificacion, 'comisiones', f.comisiones, 'observaciones', f.observaciones,
  'estado', case
     when f.emp_id is null then 'no_encontrado'
     when not f.hay_biometria then 'sin_biometria'
     when f.horas_nocturnas - (f.nocturnas + f.usa_noct) > f.tol or f.rep_dom_fest - f.dom_fest > f.tol
       or f.horas_extra_diurnas - (f.extra_diurnas + f.usa_ed) > f.tol or f.horas_extra_nocturnas - f.extra_nocturnas > f.tol
       then 'inconsistente'
     -- Revisar: reporta un poco más de lo que respalda el biométrico (dentro de la tolerancia).
     -- Si el biométrico respalda igual o más, cuadra (los días sin marcación son informativos).
     when f.horas_nocturnas - (f.nocturnas + f.usa_noct) > 0.01 or f.rep_dom_fest - f.dom_fest > 0.01
       or f.horas_extra_diurnas - (f.extra_diurnas + f.usa_ed) > 0.01 or f.horas_extra_nocturnas - f.extra_nocturnas > 0.01
       then 'advertencia'
     else 'coherente' end,
  'review_status', f.review_status, 'review_comment', f.review_comment, 'reviewed_at', f.reviewed_at,
  'reviewed_by', (select p.full_name from profiles p where p.id = f.reviewed_by)
) order by f.full_name), '[]'::jsonb)
from fila f;
$function$;

notify pgrst, 'reload schema';
