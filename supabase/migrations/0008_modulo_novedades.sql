insert into public.permissions(module, action, label)
select 'novedades', a, 'Novedades · ' || a
from unnest(array['ver','crear','editar','eliminar','importar','exportar','aprobar','rechazar']) a
on conflict (module, action) do nothing;

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where p.module = 'novedades' and (
  r.code in ('super_admin','admin','nomina')
  or (r.code in ('coordinador','supervisor','bo') and p.action in ('ver','crear','editar','importar','exportar'))
)
on conflict do nothing;

create table public.novelty_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  filename text not null,
  sheet_name text,
  company_name text,
  campaign_label text,
  period_start date,
  period_end date,
  employees_count int not null default 0,
  days_count int not null default 0,
  status text not null default 'cargado',
  error_message text,
  uploaded_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index novelty_reports_filename_uq on public.novelty_reports (tenant_id, lower(filename));

create table public.novelty_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  report_id uuid references public.novelty_reports(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null,
  document text not null,
  full_name text,
  position text,
  campaign_label text,
  work_date date not null,
  novelty_type text not null,
  source text not null default 'manual',
  status text not null default 'pendiente',
  notes text,
  created_by uuid default auth.uid(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, document, work_date)
);
create index novelty_entries_tenant_date_idx on public.novelty_entries (tenant_id, work_date);
create index novelty_entries_report_idx on public.novelty_entries (report_id);

create table public.novelty_totals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  report_id uuid references public.novelty_reports(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null,
  document text not null,
  full_name text,
  position text,
  campaign_label text,
  period_start date not null,
  period_end date not null,
  horas_nocturnas numeric not null default 0,
  ajuste_horas_nocturnas numeric not null default 0,
  horas_dom_fest_090 numeric not null default 0,
  ajuste_dom_fest_090 numeric not null default 0,
  horas_dom_fest_190 numeric not null default 0,
  ajuste_dom_fest_190 numeric not null default 0,
  horas_extra_diurnas numeric not null default 0,
  ajuste_extra_diurnas numeric not null default 0,
  horas_extra_nocturnas numeric not null default 0,
  ajuste_extra_nocturnas numeric not null default 0,
  bonificacion numeric not null default 0,
  comisiones numeric not null default 0,
  observaciones text,
  source text not null default 'plantilla',
  created_at timestamptz not null default now(),
  unique (tenant_id, document, period_start, period_end)
);
create index novelty_totals_tenant_period_idx on public.novelty_totals (tenant_id, period_start);

grant select, insert, update, delete on public.novelty_reports, public.novelty_entries, public.novelty_totals to authenticated;
grant all on public.novelty_reports, public.novelty_entries, public.novelty_totals to service_role;

alter table public.novelty_reports enable row level security;
alter table public.novelty_entries enable row level security;
alter table public.novelty_totals enable row level security;

do $$
declare t text;
begin
  foreach t in array array['novelty_reports','novelty_entries','novelty_totals'] loop
    execute format('create policy "novedades lectura" on public.%I for select to authenticated using (((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id())) and public.has_permission(''novedades'',''ver''))', t);
    execute format('create policy "novedades insertar" on public.%I for insert to authenticated with check (((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id())) and (public.has_permission(''novedades'',''crear'') or public.has_permission(''novedades'',''importar'')))', t);
    execute format('create policy "novedades editar" on public.%I for update to authenticated using (((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id())) and (public.has_permission(''novedades'',''editar'') or public.has_permission(''novedades'',''aprobar'') or public.has_permission(''novedades'',''importar''))) with check (((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id())))', t);
    execute format('create policy "novedades eliminar" on public.%I for delete to authenticated using (((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id())) and public.has_permission(''novedades'',''eliminar''))', t);
  end loop;
end $$;

-- Genera novedades diarias desde la asistencia calculada (no pisa las existentes)
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
  group by a.tenant_id, e.id, e.document, e.full_name, e.position
  on conflict (tenant_id, document, period_start, period_end) do nothing;
  return _n;
end $$;
grant execute on function public.generar_novedades_desde_asistencia(date, date) to authenticated;