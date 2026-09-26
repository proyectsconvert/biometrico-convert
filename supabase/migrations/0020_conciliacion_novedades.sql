-- Migración 0020: Descanso por defecto, extras diurnas/nocturnas y conciliación de novedades
-- 1. Sin turno asignado no se descontaba el almuerzo: 8:00-17:00 daba 9 h y 1 h extra.
--    Nueva regla de descanso por defecto (configurable) para quien no tiene turno.
-- 2. La hora extra se separa en diurna y nocturna, como en la plantilla de nómina.
-- 3. Conciliación automática plantilla de novedades vs. biométrico, con revisión de nómina.

insert into public.rules (tenant_id, key, value, description)
select t.id, r.key, r.value::jsonb, r.descr from public.tenants t,
(values
 ('descanso_minutos', '60', 'Minutos de descanso/almuerzo que se descuentan cuando el empleado no tiene turno'),
 ('descanso_desde_horas', '5', 'Permanencia mínima (horas) para descontar el descanso por defecto'),
 ('tolerancia_conciliacion_horas', '0.5', 'Diferencia máxima (horas) entre lo reportado y el biométrico para considerarlo coherente')
) as r(key, value, descr)
on conflict (tenant_id, key) do nothing;

alter table public.attendance_daily add column if not exists overtime_night_minutes integer not null default 0;

create or replace function public.recalcular_asistencia(_tenant uuid, _desde date, _hasta date)
returns integer language plpgsql security definer set search_path = public as $function$
declare
  v_rows integer; v_ventana integer; v_jornada integer; v_extra integer;
  v_ni time; v_nf time; v_dias int[]; v_dom boolean; v_desc integer; v_desc_desde integer;
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
         coalesce(max(case when key='descanso_desde_horas' then round((value#>>'{}')::numeric*60)::int end),300)
    into v_ventana, v_jornada, v_extra, v_ni, v_nf, v_dom, v_desc, v_desc_desde
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
           -- Regla universal: primera marcación = entrada, última = salida (si hay más de una)
           min(event_at) as first_in,
           case when max(event_at) > min(event_at) then max(event_at) else null end as last_out
    from base where work_date between _desde and _hasta
    group by employee_id, tenant_id, work_date
  ), permanencia as (
    select a.*,
      case when first_in is not null and last_out is not null and last_out > first_in
        then (extract(epoch from (last_out - first_in))/60)::int else 0 end as stay
    from agrupado a
  ), calculado as (
    select p.*,
      -- con turno: su descanso; sin turno: el descanso por defecto si la permanencia lo amerita
      greatest(0, stay - case when shift_id is not null then coalesce(break_minutes,0)
                              when stay >= v_desc_desde then v_desc else 0 end) as worked,
      case when first_in is not null and last_out is not null and last_out > first_in then 'completa'::attendance_status
           when first_in is not null or last_out is not null then 'incompleta'::attendance_status
           else 'sin_marcacion'::attendance_status end as status,
      case when first_in is not null and start_time is not null
             and first_in::time > (start_time + make_interval(mins => coalesce(tolerance_in_minutes,0)))
        then (extract(epoch from (first_in::time - start_time))/60)::int else 0 end as late_minutes,
      public.minutos_en_ventana(first_in, last_out, v_ni, v_nf) as night,
      (extract(dow from work_date)::int = 0
        or exists (select 1 from public.holidays h where h.tenant_id=_tenant and h.is_active and h.holiday_date=p.work_date)) as dom_fest,
      not (extract(dow from work_date)::int = any(v_dias)) as rest
    from permanencia p
  ), final as (
    select c.*, greatest(0, worked - v_extra) as overtime
    from calculado c
  )
  insert into public.attendance_daily as ad
    (tenant_id, employee_id, work_date, shift_id, first_in, last_out, worked_minutes, expected_minutes, late_minutes, status,
     ordinary_minutes, overtime_minutes, overtime_night_minutes, night_minutes, sunday_holiday_minutes, is_rest_day, updated_at)
  select tenant_id, employee_id, work_date, shift_id, first_in, last_out, worked,
         case when rest then 0 else v_jornada end, late_minutes, status,
         least(worked, v_extra), overtime,
         -- la extra son los últimos minutos de la jornada: su parte nocturna
         case when overtime > 0 then least(overtime, public.minutos_en_ventana(last_out - make_interval(mins => overtime), last_out, v_ni, v_nf)) else 0 end,
         least(night, worked),
         case when v_dom and dom_fest then worked else 0 end, rest, now()
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
        is_rest_day = excluded.is_rest_day,
        late_minutes = excluded.late_minutes, shift_id = excluded.shift_id,
        expected_minutes = excluded.expected_minutes, updated_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;
grant execute on function public.recalcular_asistencia(uuid,date,date) to authenticated, service_role;

-- Revisión de nómina por empleado y periodo
alter table public.novelty_totals
  add column if not exists review_status text not null default 'pendiente',
  add column if not exists review_comment text,
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz;
alter table public.novelty_totals drop constraint if exists novelty_totals_review_status_chk;
alter table public.novelty_totals add constraint novelty_totals_review_status_chk
  check (review_status in ('pendiente','aprobado','observado'));

-- Los días de la plantilla quedan «reportados»; la aprobación la da nómina al revisar el periodo
update public.novelty_entries set status = 'reportada' where source = 'plantilla' and status = 'aprobada';

-- Conciliación: lo reportado en la plantilla contra lo que respalda el biométrico
create or replace function public.conciliacion_novedades(_desde date, _hasta date)
returns jsonb language sql stable security invoker set search_path = public as $$
with cfg as (
  select coalesce((select (value#>>'{}')::numeric from rules
    where tenant_id = public.current_tenant_id() and key = 'tolerancia_conciliacion_horas'), 0.5) as tol
),
t as (
  select nt.*, e.id as emp_id, e.employer_id
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
    count(*) filter (where n.novelty_type = 'Asiste' and a.id is null) as asiste_sin_marca,
    count(*) filter (where n.novelty_type = 'Asiste' and a.status = 'incompleta') as asiste_incompleta,
    count(*) filter (where n.novelty_type <> 'Asiste' and a.status = 'completa') as marca_en_novedad,
    count(*) filter (where n.novelty_type = 'Asiste') as dias_asiste
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
  'campaign_label', f.campaign_label, 'period_start', f.period_start, 'period_end', f.period_end,
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
     when f.asiste_sin_marca > 0 or f.marca_en_novedad > 0 or f.asiste_incompleta > 0 then 'advertencia'
     else 'coherente' end,
  'review_status', f.review_status, 'review_comment', f.review_comment, 'reviewed_at', f.reviewed_at,
  'reviewed_by', (select p.full_name from profiles p where p.id = f.reviewed_by)
) order by f.full_name), '[]'::jsonb)
from fila f;
$$;
grant execute on function public.conciliacion_novedades(date, date) to authenticated;

-- Aprobar u observar (con comentario obligatorio) — solo quien tiene novedades·aprobar
create or replace function public.revisar_novedades(_ids uuid[], _estado text, _comentario text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.has_permission('novedades','aprobar') then
    raise exception 'No tienes permiso para aprobar novedades';
  end if;
  if _estado not in ('aprobado','observado','pendiente') then raise exception 'Estado inválido'; end if;
  if _estado = 'observado' and coalesce(trim(_comentario),'') = '' then
    raise exception 'La observación requiere un comentario';
  end if;
  update public.novelty_totals set review_status = _estado, review_comment = nullif(trim(_comentario),''),
         reviewed_by = auth.uid(), reviewed_at = now()
  where id = any(_ids) and public.tenant_visible(tenant_id);
  get diagnostics n = row_count;
  insert into public.audit_logs (tenant_id, user_id, module, action, new_value, reason)
  values (public.current_tenant_id(), auth.uid(), 'novedades', _estado,
          jsonb_build_object('registros', n, 'ids', _ids), nullif(trim(_comentario),''));
  return n;
end $$;
revoke all on function public.revisar_novedades(uuid[], text, text) from public, anon;
grant execute on function public.revisar_novedades(uuid[], text, text) to authenticated;

-- Recalcular todo lo existente con el descanso por defecto y la separación de extras
do $$
declare r record;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  for r in select tenant_id, min(work_date) d1, max(work_date) d2 from public.attendance_daily group by tenant_id loop
    perform public.recalcular_asistencia(r.tenant_id, r.d1, r.d2);
  end loop;
end $$;
