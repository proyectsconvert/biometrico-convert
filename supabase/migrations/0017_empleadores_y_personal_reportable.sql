-- Migración 0017: Empresa empleadora del personal
-- En el biométrico acceden personas de varias empresas (ICA, seguridad, aseo, contratistas).
-- Cada empleado puede asociarse a un empleador; solo el personal de empleadores marcados
-- "incluir en reportes" cuenta en el panel, el control diario y las novedades generadas.

-- 1. Empleadores
create table if not exists public.employers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  nit text,
  include_in_reports boolean not null default true,
  biometric_groups text[] not null default '{}',
  status public.generic_status not null default 'activo',
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);
grant select, insert, update, delete on public.employers to authenticated;
grant all on public.employers to service_role;
alter table public.employers enable row level security;

drop policy if exists "empleadores lectura" on public.employers;
create policy "empleadores lectura" on public.employers for select to authenticated
  using (public.tenant_visible(tenant_id));
drop policy if exists "empleadores gestion" on public.employers;
create policy "empleadores gestion" on public.employers for all to authenticated
  using (public.tenant_visible(tenant_id) and public.has_permission('empleadores','editar'))
  with check (public.tenant_visible(tenant_id));

-- 2. Empleado: empleador y grupo del biométrico
alter table public.employees
  add column if not exists employer_id uuid references public.employers(id) on delete set null,
  add column if not exists biometric_group text;
create index if not exists employees_employer_idx on public.employees (employer_id);

-- 3. Permisos del módulo (mismos roles que ya gestionan empleados)
insert into public.permissions (module, action, label)
select 'empleadores', a, 'Empleadores · ' || a
from unnest(array['ver','crear','editar','eliminar','exportar']) a
on conflict (module, action) do nothing;

insert into public.role_permissions (role_id, permission_id)
select rp.role_id, pn.id
from public.role_permissions rp
join public.permissions po on po.id = rp.permission_id and po.module = 'empleados'
join public.permissions pn on pn.module = 'empleadores' and pn.action = po.action
on conflict do nothing;

-- 4. Regla: ¿el personal sin empleador asignado cuenta en reportes?
insert into public.rules (tenant_id, key, value, description)
select t.id, 'reportes_incluir_sin_empresa', 'true'::jsonb,
       'Incluir en panel y reportes al personal que aún no tiene empleador asignado'
from public.tenants t
on conflict (tenant_id, key) do nothing;

-- 5. ¿Un empleado cuenta en reportes?
create or replace function public.incluye_en_reportes(_employer uuid, _tenant uuid default null)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when _employer is null then coalesce(
      (select (r.value#>>'{}')::boolean from public.rules r
        where r.tenant_id = coalesce(_tenant, public.current_tenant_id()) and r.key = 'reportes_incluir_sin_empresa'),
      true)
    else coalesce((select em.include_in_reports from public.employers em where em.id = _employer), true)
  end;
$$;
grant execute on function public.incluye_en_reportes(uuid, uuid) to authenticated, service_role;

-- 6. Asignar empleador por grupo biométrico (solo a quien no tiene empleador)
create or replace function public.asignar_empleador_por_grupo(_tenant uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.employees emp
  set employer_id = em.id
  from public.employers em
  where emp.tenant_id = _tenant and em.tenant_id = _tenant
    and emp.employer_id is null and emp.biometric_group is not null
    and exists (select 1 from unnest(em.biometric_groups) g where upper(trim(g)) = upper(trim(emp.biometric_group)));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.asignar_empleador_por_grupo(uuid) from public, anon;
grant execute on function public.asignar_empleador_por_grupo(uuid) to service_role;

create or replace function public.trg_empleador_grupos()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.asignar_empleador_por_grupo(new.tenant_id);
  return new;
end $$;
drop trigger if exists empleador_grupos on public.employers;
create trigger empleador_grupos after insert or update of biometric_groups on public.employers
for each row execute function public.trg_empleador_grupos();

-- 7. Grupo biométrico actual de cada empleado (último grupo no vacío registrado)
update public.employees emp
set biometric_group = x.g
from (
  select distinct on (tenant_id, document) tenant_id, document, user_group as g
  from public.biometric_events
  where document is not null and nullif(trim(user_group), '') is not null
  order by tenant_id, document, event_at desc
) x
where emp.tenant_id = x.tenant_id and emp.document = x.document
  and emp.biometric_group is distinct from x.g;

-- 8. Empleadores iniciales detectados en los grupos del biométrico
insert into public.employers (tenant_id, name, nit, include_in_reports, biometric_groups)
select t.id, v.name, v.nit, v.inc, v.grupos
from public.tenants t
cross join (values
  ('INTELLIGENT CUSTOMER ACQUISITION S.A.S.', '901.264.539-9', true, array['CONVERTIA','CASA CONVERTIA']),
  ('SEGURIDAD', null, false, array['SEGURIDAD']),
  ('SERVICIOS GENERALES', null, false, array['SERVICIOS GENERALES']),
  ('ANDIRENT S.A.S.', null, false, array['ANDIRENT. SAS'])
) as v(name, nit, inc, grupos)
where t.id = '11111111-1111-1111-1111-111111111111'
on conflict (tenant_id, name) do nothing;

-- 9. Procesar importación: además registra grupo biométrico y empleador sugerido
create or replace function public.procesar_importacion(_import_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_tenant uuid; v_dedupe integer; v_valid integer; v_ignored integer; v_total integer; v_dup integer;
  v_desde timestamp; v_hasta timestamp;
begin
  select tenant_id into v_tenant from public.biometric_imports where id = _import_id;
  if v_tenant is null then raise exception 'Importación no encontrada'; end if;
  if coalesce(auth.role(),'') <> 'service_role' and not public.tenant_visible(v_tenant) then
    raise exception 'Sin acceso a esta empresa';
  end if;
  select coalesce((value#>>'{}')::integer, 60) into v_dedupe from public.rules where tenant_id = v_tenant and key = 'dedupe_seconds';
  v_dedupe := coalesce(v_dedupe, 60);

  insert into public.devices (tenant_id, device_code, name, door_name, classification)
  select v_tenant, e.device_code, min(coalesce(e.device_name, e.device_code)), min(e.door),
         public.sugerir_clasificacion(min(coalesce(e.device_name,'')) || ' ' || coalesce(min(e.door),''))
  from public.biometric_events e where e.import_id = _import_id
  group by e.device_code
  on conflict (tenant_id, device_code) do nothing;

  -- crear empleados automáticamente desde el biométrico si no existen
  insert into public.employees (tenant_id, document, full_name)
  select v_tenant, e.document, coalesce(max(e.biometric_name), 'SIN NOMBRE ' || e.document)
  from public.biometric_events e
  where e.import_id = _import_id and e.document is not null
  group by e.document
  on conflict (tenant_id, document) do nothing;

  update public.employees emp set full_name = x.n
  from (select document, max(biometric_name) n from public.biometric_events
        where import_id=_import_id and biometric_name is not null group by document) x
  where emp.tenant_id=v_tenant and emp.document=x.document and emp.full_name like 'SIN NOMBRE %';

  -- grupo biométrico más reciente del archivo y empleador sugerido por ese grupo
  update public.employees emp set biometric_group = x.g
  from (select distinct on (document) document, user_group g from public.biometric_events
        where import_id=_import_id and document is not null and nullif(trim(user_group),'') is not null
        order by document, event_at desc) x
  where emp.tenant_id=v_tenant and emp.document=x.document and emp.biometric_group is distinct from x.g;
  perform public.asignar_empleador_por_grupo(v_tenant);

  -- Todas las marcaciones exitosas con documento son consideradas asistencia
  update public.biometric_events e
  set device_id = d.id,
      employee_id = (select emp.id from public.employees emp where emp.tenant_id = v_tenant and emp.document = e.document limit 1),
      is_attendance = (e.document is not null and e.event_type ilike '%exitosa%' and e.event_type not ilike '%fallida%')
  from public.devices d
  where e.import_id = _import_id and d.tenant_id = v_tenant and d.device_code = e.device_code;

  select min(event_at) - interval '1 day', max(event_at) + interval '1 day' into v_desde, v_hasta
  from public.biometric_events where import_id = _import_id;

  with ordenados as (
    select e.id, e.import_id,
           lag(e.event_at) over (partition by e.document, e.device_code order by e.event_at) as prev_at
    from public.biometric_events e
    where e.tenant_id = v_tenant and e.is_attendance and e.event_at between v_desde and v_hasta
      and e.document in (select distinct document from public.biometric_events where import_id=_import_id)
  )
  update public.biometric_events e
  set is_duplicate = (o.prev_at is not null and e.event_at - o.prev_at < make_interval(secs => v_dedupe))
  from ordenados o where o.id = e.id and o.import_id = _import_id;

  select count(*), count(*) filter (where is_attendance and not is_duplicate),
         count(*) filter (where not is_attendance), count(*) filter (where is_duplicate)
    into v_total, v_valid, v_ignored, v_dup
  from public.biometric_events where import_id = _import_id;

  update public.biometric_imports
  set rows_processed = v_total, rows_valid = v_valid, rows_ignored = v_ignored, rows_duplicated = v_dup
  where id = _import_id;

  return jsonb_build_object('total', v_total, 'validas', v_valid, 'ignoradas', v_ignored, 'duplicadas', v_dup,
    'desde', v_desde::date + 1, 'hasta', v_hasta::date - 1);
end $$;
grant execute on function public.procesar_importacion(uuid) to authenticated, service_role;

-- 10. Vista de asistencia para el control diario (respeta RLS del usuario)
create or replace view public.asistencia_reporte with (security_invoker = true) as
select a.id, a.tenant_id, a.employee_id, a.work_date, a.shift_id, a.first_in, a.last_out,
       a.worked_minutes, a.expected_minutes, a.late_minutes, a.status, a.overtime_minutes,
       a.night_minutes, a.sunday_holiday_minutes, a.is_rest_day, a.is_manual, a.notes,
       e.document, e.full_name, e.position, e.employer_id, e.biometric_group,
       em.name as employer_name, c.name as campaign_name, s.name as shift_name,
       case when e.employer_id is null then coalesce(cfg.sin_empresa, true)
            else coalesce(em.include_in_reports, true) end as en_reportes
from public.attendance_daily a
join public.employees e on e.id = a.employee_id
left join public.employers em on em.id = e.employer_id
left join public.campaigns c on c.id = e.campaign_id
left join public.shifts s on s.id = a.shift_id
left join lateral (
  select (r.value#>>'{}')::boolean as sin_empresa from public.rules r
  where r.tenant_id = a.tenant_id and r.key = 'reportes_incluir_sin_empresa'
) cfg on true;
grant select on public.asistencia_reporte to authenticated, service_role;

-- 11. Panel: solo personal que cuenta en reportes
create or replace function public.panel_bi(_desde date, _hasta date, _campaign uuid default null)
returns jsonb language sql stable security invoker set search_path = public as $$
with cfg as (
  select coalesce((select (value#>>'{}')::boolean from rules
    where tenant_id = public.current_tenant_id() and key = 'reportes_incluir_sin_empresa'), true) as sin_empresa
),
emp as (
  select e.id, e.document, e.full_name, e.status, e.campaign_id, coalesce(c.name, 'Sin campaña') as campana
  from employees e
  left join campaigns c on c.id = e.campaign_id
  left join employers em on em.id = e.employer_id
  cross join cfg
  where (_campaign is null or e.campaign_id = _campaign)
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
grant execute on function public.panel_bi(date, date, uuid) to authenticated;

-- 12. Novedades generadas desde la asistencia: solo personal que cuenta en reportes
create or replace function public.generar_novedades_desde_asistencia(_desde date, _hasta date)
returns int language plpgsql security definer set search_path = public as $$
declare _t uuid := public.current_tenant_id(); _n int;
begin
  if not public.has_permission('novedades','crear') then raise exception 'Sin permiso'; end if;
  insert into public.novelty_entries(tenant_id, employee_id, document, full_name, position, campaign_label, work_date, novelty_type, source, status)
  select a.tenant_id, e.id, e.document, e.full_name, e.position, c.name, a.work_date,
    case when a.is_rest_day and a.status = 'sin_marcacion' then 'Descanso'
         when a.status = 'sin_marcacion' then 'Ausente'
         when a.status = 'incompleta' then 'Marcación incompleta'
         else 'Asiste' end,
    'asistencia', 'pendiente'
  from public.attendance_daily a
  join public.employees e on e.id = a.employee_id
  left join public.campaigns c on c.id = e.campaign_id
  where a.tenant_id = _t and a.work_date between _desde and _hasta
    and public.incluye_en_reportes(e.employer_id, _t)
  on conflict (tenant_id, document, work_date) do nothing;
  get diagnostics _n = row_count;

  insert into public.novelty_totals(tenant_id, employee_id, document, full_name, position, campaign_label, period_start, period_end,
    horas_nocturnas, horas_dom_fest_190, horas_extra_diurnas, source)
  select a.tenant_id, e.id, e.document, e.full_name, e.position, max(c.name), _desde, _hasta,
    round(sum(coalesce(a.night_minutes,0))/60.0, 2),
    round(sum(coalesce(a.sunday_holiday_minutes,0))/60.0, 2),
    round(sum(coalesce(a.overtime_minutes,0))/60.0, 2), 'asistencia'
  from public.attendance_daily a
  join public.employees e on e.id = a.employee_id
  left join public.campaigns c on c.id = e.campaign_id
  where a.tenant_id = _t and a.work_date between _desde and _hasta
    and public.incluye_en_reportes(e.employer_id, _t)
  group by a.tenant_id, e.id, e.document, e.full_name, e.position
  on conflict (tenant_id, document, period_start, period_end) do nothing;
  return _n;
end $$;
grant execute on function public.generar_novedades_desde_asistencia(date, date) to authenticated;
