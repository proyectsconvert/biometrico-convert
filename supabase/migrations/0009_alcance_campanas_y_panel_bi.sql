create or replace function public.ve_toda_empresa()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super_admin() or public.my_scope() in ('plataforma','mi_empresa');
$$;
create or replace function public.my_employee_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(e.id), '{}') from public.employees e
  where e.tenant_id = public.current_tenant_id()
    and (e.campaign_id = any(public.my_campaign_ids()) or e.user_id = auth.uid());
$$;
create or replace function public.my_documents()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(e.document), '{}') from public.employees e
  where e.tenant_id = public.current_tenant_id()
    and (e.campaign_id = any(public.my_campaign_ids()) or e.user_id = auth.uid());
$$;
grant execute on function public.ve_toda_empresa(), public.my_employee_ids(), public.my_documents() to authenticated;

drop policy if exists "empleados lectura" on public.employees;
create policy "empleados lectura" on public.employees for select to authenticated using (
  ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  and ((select public.ve_toda_empresa()) or array[id] <@ (select public.my_employee_ids()))
);
drop policy if exists "asistencia lectura" on public.attendance_daily;
create policy "asistencia lectura" on public.attendance_daily for select to authenticated using (
  ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  and ((select public.ve_toda_empresa()) or array[employee_id] <@ (select public.my_employee_ids()))
);
drop policy if exists "eventos lectura" on public.biometric_events;
create policy "eventos lectura" on public.biometric_events for select to authenticated using (
  ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  and ((select public.ve_toda_empresa()) or array[document] <@ (select public.my_documents()))
);
drop policy if exists "novedades lectura" on public.novelty_entries;
create policy "novedades lectura" on public.novelty_entries for select to authenticated using (
  ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  and (select public.has_permission('novedades','ver'))
  and ((select public.ve_toda_empresa()) or array[document] <@ (select public.my_documents()))
);
drop policy if exists "novedades lectura" on public.novelty_totals;
create policy "novedades lectura" on public.novelty_totals for select to authenticated using (
  ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  and (select public.has_permission('novedades','ver'))
  and ((select public.ve_toda_empresa()) or array[document] <@ (select public.my_documents()))
);
drop policy if exists "novedades lectura" on public.novelty_reports;
create policy "novedades lectura" on public.novelty_reports for select to authenticated using (
  ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  and (select public.has_permission('novedades','ver'))
  and ((select public.ve_toda_empresa()) or uploaded_by = auth.uid())
);
drop policy if exists "novedades insertar" on public.novelty_entries;
create policy "novedades insertar" on public.novelty_entries for insert to authenticated with check (
  ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  and ((select public.has_permission('novedades','crear')) or (select public.has_permission('novedades','importar')))
  and ((select public.ve_toda_empresa()) or array[document] <@ (select public.my_documents()))
);

create index if not exists attendance_tenant_date_idx on public.attendance_daily (tenant_id, work_date);
create index if not exists employees_tenant_status_idx on public.employees (tenant_id, status);
create index if not exists employees_user_idx on public.employees (user_id);
create index if not exists novelty_entries_doc_idx on public.novelty_entries (tenant_id, document);
create index if not exists novelty_totals_doc_idx on public.novelty_totals (tenant_id, document);

create or replace function public.panel_bi(_desde date, _hasta date, _campaign uuid default null)
returns jsonb language sql stable security invoker set search_path = public as $$
with emp as (
  select e.id, e.document, e.full_name, e.status, e.campaign_id, coalesce(c.name, 'Sin campaña') as campana
  from employees e left join campaigns c on c.id = e.campaign_id
  where _campaign is null or e.campaign_id = _campaign
),
ad as (
  select a.*, emp.full_name, emp.campana, emp.document
  from attendance_daily a join emp on emp.id = a.employee_id
  where a.work_date between _desde and _hasta
),
nov as (
  select n.novelty_type from novelty_entries n
  where n.work_date between _desde and _hasta and n.status <> 'rechazada'
    and (_campaign is null or n.document in (select document from emp))
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
      'ajustes_manuales', count(*) filter (where is_manual)
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