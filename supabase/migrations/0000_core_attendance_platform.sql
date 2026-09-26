-- ============ ENUMS ============
create type public.app_scope as enum ('solo_yo','mi_campana','campanas_asignadas','mi_empresa','plataforma');
create type public.device_class as enum ('entrada','salida','entrada_salida','interno','ignorar');
create type public.attendance_status as enum ('completa','incompleta','sin_marcacion');
create type public.import_status as enum ('pendiente','procesando','completado','completado_advertencias','error');
create type public.generic_status as enum ('activo','inactivo');

-- ============ TENANTS ============
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nit text,
  country text not null default 'CO',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.tenants to authenticated;
grant all on public.tenants to service_role;
alter table public.tenants enable row level security;

-- ============ PROFILES ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid references public.tenants(id) on delete set null,
  full_name text,
  email text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;

-- ============ ROLES & PERMISSIONS ============
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);
create unique index roles_global_code_idx on public.roles (code) where tenant_id is null;
grant select, insert, update, delete on public.roles to authenticated;
grant all on public.roles to service_role;
alter table public.roles enable row level security;

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  action text not null,
  label text not null,
  unique (module, action)
);
grant select on public.permissions to authenticated;
grant all on public.permissions to service_role;
alter table public.permissions enable row level security;

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);
grant select, insert, update, delete on public.role_permissions to authenticated;
grant all on public.role_permissions to service_role;
alter table public.role_permissions enable row level security;

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  tenant_id uuid references public.tenants(id) on delete cascade,
  scope public.app_scope not null default 'mi_empresa',
  campaign_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, role_id, tenant_id)
);
grant select, insert, update, delete on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

-- ============ HELPERS ============
create or replace function public.is_super_admin(_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = _user_id and r.code = 'super_admin'
  );
$$;

create or replace function public.current_tenant_id()
returns uuid language sql stable security definer set search_path = public as $$
  select tenant_id from public.profiles where id = auth.uid();
$$;

create or replace function public.has_permission(_module text, _action text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super_admin() or exists (
    select 1 from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions p on p.id = rp.permission_id
    where ur.user_id = auth.uid() and p.module = _module and p.action = _action
  );
$$;

create or replace function public.my_scope()
returns public.app_scope language sql stable security definer set search_path = public as $$
  select coalesce(
    (select ur.scope from public.user_roles ur
      where ur.user_id = auth.uid()
      order by case ur.scope
        when 'plataforma' then 1 when 'mi_empresa' then 2
        when 'campanas_asignadas' then 3 when 'mi_campana' then 4 else 5 end
      limit 1), 'solo_yo');
$$;

create or replace function public.tenant_visible(_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super_admin() or (_tenant_id is not null and _tenant_id = public.current_tenant_id());
$$;

-- profiles/tenants/roles policies
create policy "tenants visibles" on public.tenants for select to authenticated using (public.tenant_visible(id));
create policy "tenants admin" on public.tenants for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "perfil propio" on public.profiles for select to authenticated using (id = auth.uid() or public.tenant_visible(tenant_id));
create policy "actualizar perfil propio" on public.profiles for update to authenticated using (id = auth.uid() or public.is_super_admin()) with check (true);
create policy "admin gestiona perfiles" on public.profiles for all to authenticated using (public.is_super_admin() or (public.tenant_visible(tenant_id) and public.has_permission('usuarios','editar'))) with check (public.is_super_admin() or public.tenant_visible(tenant_id));

create policy "roles visibles" on public.roles for select to authenticated using (tenant_id is null or public.tenant_visible(tenant_id));
create policy "roles gestion" on public.roles for all to authenticated using (public.is_super_admin() or public.has_permission('roles','editar')) with check (public.is_super_admin() or public.has_permission('roles','editar'));

create policy "permisos visibles" on public.permissions for select to authenticated using (true);

create policy "role_permissions visibles" on public.role_permissions for select to authenticated using (true);
create policy "role_permissions gestion" on public.role_permissions for all to authenticated using (public.is_super_admin() or public.has_permission('roles','editar')) with check (public.is_super_admin() or public.has_permission('roles','editar'));

create policy "user_roles visibles" on public.user_roles for select to authenticated using (user_id = auth.uid() or public.is_super_admin() or public.tenant_visible(tenant_id));
create policy "user_roles gestion" on public.user_roles for all to authenticated using (public.is_super_admin() or public.has_permission('usuarios','editar')) with check (public.is_super_admin() or public.has_permission('usuarios','editar'));

-- ============ ESTRUCTURA ============
create table public.cost_centers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  status public.generic_status not null default 'activo',
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);
grant select, insert, update, delete on public.cost_centers to authenticated;
grant all on public.cost_centers to service_role;
alter table public.cost_centers enable row level security;

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  start_time time not null,
  end_time time not null,
  crosses_midnight boolean not null default false,
  break_minutes integer not null default 0,
  tolerance_in_minutes integer not null default 10,
  tolerance_out_minutes integer not null default 10,
  workdays integer[] not null default '{1,2,3,4,5}',
  status public.generic_status not null default 'activo',
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);
grant select, insert, update, delete on public.shifts to authenticated;
grant all on public.shifts to service_role;
alter table public.shifts enable row level security;

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  cost_center_id uuid references public.cost_centers(id) on delete set null,
  shift_id uuid references public.shifts(id) on delete set null,
  status public.generic_status not null default 'activo',
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);
grant select, insert, update, delete on public.campaigns to authenticated;
grant all on public.campaigns to service_role;
alter table public.campaigns enable row level security;

create table public.campaign_responsibles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  responsibility text not null default 'supervisor',
  unique (campaign_id, user_id, responsibility)
);
grant select, insert, update, delete on public.campaign_responsibles to authenticated;
grant all on public.campaign_responsibles to service_role;
alter table public.campaign_responsibles enable row level security;

create or replace function public.my_campaign_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(
    (select array_agg(distinct c) from (
      select unnest(ur.campaign_ids) as c from public.user_roles ur where ur.user_id = auth.uid()
      union
      select cr.campaign_id from public.campaign_responsibles cr where cr.user_id = auth.uid()
    ) s), '{}'::uuid[]);
$$;

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  document text not null,
  full_name text not null,
  position text,
  cost_center_id uuid references public.cost_centers(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  supervisor_id uuid references public.profiles(id) on delete set null,
  shift_id uuid references public.shifts(id) on delete set null,
  user_id uuid references public.profiles(id) on delete set null,
  email text,
  hire_date date,
  termination_date date,
  status public.generic_status not null default 'activo',
  created_at timestamptz not null default now(),
  unique (tenant_id, document)
);
create index employees_campaign_idx on public.employees(campaign_id);
create index employees_document_idx on public.employees(tenant_id, document);
grant select, insert, update, delete on public.employees to authenticated;
grant all on public.employees to service_role;
alter table public.employees enable row level security;

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_code text not null,
  name text not null,
  door_name text,
  classification public.device_class not null default 'ignorar',
  site text,
  building text,
  floor text,
  is_active boolean not null default true,
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, device_code)
);
grant select, insert, update, delete on public.devices to authenticated;
grant all on public.devices to service_role;
alter table public.devices enable row level security;

create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  country text not null default 'CO',
  holiday_date date not null,
  description text not null,
  is_active boolean not null default true,
  unique (tenant_id, holiday_date)
);
grant select, insert, update, delete on public.holidays to authenticated;
grant all on public.holidays to service_role;
alter table public.holidays enable row level security;

create table public.rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);
grant select, insert, update, delete on public.rules to authenticated;
grant all on public.rules to service_role;
alter table public.rules enable row level security;

-- ============ BIOMETRIA ============
create table public.biometric_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  filename text not null,
  file_hash text,
  storage_path text,
  status public.import_status not null default 'pendiente',
  rows_found integer not null default 0,
  rows_processed integer not null default 0,
  rows_valid integer not null default 0,
  rows_ignored integer not null default 0,
  rows_error integer not null default 0,
  error_detail jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, file_hash)
);
grant select, insert, update, delete on public.biometric_imports to authenticated;
grant all on public.biometric_imports to service_role;
alter table public.biometric_imports enable row level security;

create table public.biometric_events (
  id bigserial primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_id uuid references public.biometric_imports(id) on delete set null,
  event_at timestamp not null,
  door text,
  device_code text not null,
  device_name text,
  user_group text,
  raw_user text,
  document text,
  biometric_name text,
  event_type text not null,
  is_attendance boolean not null default false,
  is_duplicate boolean not null default false,
  employee_id uuid references public.employees(id) on delete set null,
  device_id uuid references public.devices(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, event_at, device_code, event_type, raw_user)
);
create index bio_events_doc_idx on public.biometric_events(tenant_id, document, event_at);
create index bio_events_emp_idx on public.biometric_events(employee_id, event_at);
create index bio_events_import_idx on public.biometric_events(import_id);
grant select, insert, update, delete on public.biometric_events to authenticated;
grant all on public.biometric_events to service_role;
alter table public.biometric_events enable row level security;

create table public.attendance_daily (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  work_date date not null,
  shift_id uuid references public.shifts(id) on delete set null,
  first_in timestamp,
  last_out timestamp,
  worked_minutes integer not null default 0,
  expected_minutes integer not null default 0,
  late_minutes integer not null default 0,
  status public.attendance_status not null default 'sin_marcacion',
  is_manual boolean not null default false,
  notes text,
  updated_at timestamptz not null default now(),
  unique (employee_id, work_date)
);
create index attendance_date_idx on public.attendance_daily(tenant_id, work_date);
grant select, insert, update, delete on public.attendance_daily to authenticated;
grant all on public.attendance_daily to service_role;
alter table public.attendance_daily enable row level security;

create table public.attendance_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  attendance_id uuid not null references public.attendance_daily(id) on delete cascade,
  field text not null,
  old_value text,
  new_value text,
  reason text not null,
  comment text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
grant select, insert on public.attendance_adjustments to authenticated;
grant all on public.attendance_adjustments to service_role;
alter table public.attendance_adjustments enable row level security;

create table public.audit_logs (
  id bigserial primary key,
  tenant_id uuid references public.tenants(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  module text not null,
  action text not null,
  record_id text,
  old_value jsonb,
  new_value jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index audit_logs_idx on public.audit_logs(tenant_id, created_at desc);
grant select, insert on public.audit_logs to authenticated;
grant all on public.audit_logs to service_role;
alter table public.audit_logs enable row level security;

-- ============ POLICIES TENANT TABLES ============
create policy "cc lectura" on public.cost_centers for select to authenticated using (public.tenant_visible(tenant_id));
create policy "cc gestion" on public.cost_centers for all to authenticated using (public.tenant_visible(tenant_id) and public.has_permission('centros_costo','editar')) with check (public.tenant_visible(tenant_id));

create policy "turnos lectura" on public.shifts for select to authenticated using (public.tenant_visible(tenant_id));
create policy "turnos gestion" on public.shifts for all to authenticated using (public.tenant_visible(tenant_id) and public.has_permission('turnos','editar')) with check (public.tenant_visible(tenant_id));

create policy "campanas lectura" on public.campaigns for select to authenticated using (
  public.tenant_visible(tenant_id) and (
    public.is_super_admin() or public.my_scope() in ('plataforma','mi_empresa') or id = any(public.my_campaign_ids())
  ));
create policy "campanas gestion" on public.campaigns for all to authenticated using (public.tenant_visible(tenant_id) and public.has_permission('campanas','editar')) with check (public.tenant_visible(tenant_id));

create policy "responsables lectura" on public.campaign_responsibles for select to authenticated using (public.tenant_visible(tenant_id));
create policy "responsables gestion" on public.campaign_responsibles for all to authenticated using (public.tenant_visible(tenant_id) and public.has_permission('campanas','editar')) with check (public.tenant_visible(tenant_id));

create policy "empleados lectura" on public.employees for select to authenticated using (
  public.tenant_visible(tenant_id) and (
    public.is_super_admin()
    or public.my_scope() in ('plataforma','mi_empresa')
    or (public.my_scope() in ('mi_campana','campanas_asignadas') and campaign_id = any(public.my_campaign_ids()))
    or user_id = auth.uid()
  ));
create policy "empleados gestion" on public.employees for all to authenticated using (public.tenant_visible(tenant_id) and public.has_permission('empleados','editar')) with check (public.tenant_visible(tenant_id));

create policy "dispositivos lectura" on public.devices for select to authenticated using (public.tenant_visible(tenant_id));
create policy "dispositivos gestion" on public.devices for all to authenticated using (public.tenant_visible(tenant_id) and public.has_permission('dispositivos','editar')) with check (public.tenant_visible(tenant_id));

create policy "festivos lectura" on public.holidays for select to authenticated using (public.tenant_visible(tenant_id));
create policy "festivos gestion" on public.holidays for all to authenticated using (public.tenant_visible(tenant_id) and public.has_permission('festivos','editar')) with check (public.tenant_visible(tenant_id));

create policy "reglas lectura" on public.rules for select to authenticated using (public.tenant_visible(tenant_id));
create policy "reglas gestion" on public.rules for all to authenticated using (public.tenant_visible(tenant_id) and public.has_permission('reglas','editar')) with check (public.tenant_visible(tenant_id));

create policy "importaciones lectura" on public.biometric_imports for select to authenticated using (public.tenant_visible(tenant_id));
create policy "importaciones gestion" on public.biometric_imports for all to authenticated using (public.tenant_visible(tenant_id) and public.has_permission('importaciones','importar')) with check (public.tenant_visible(tenant_id));

create policy "eventos lectura" on public.biometric_events for select to authenticated using (public.tenant_visible(tenant_id));
create policy "eventos gestion" on public.biometric_events for all to authenticated using (public.tenant_visible(tenant_id) and public.has_permission('importaciones','importar')) with check (public.tenant_visible(tenant_id));

create policy "asistencia lectura" on public.attendance_daily for select to authenticated using (
  public.tenant_visible(tenant_id) and (
    public.is_super_admin()
    or public.my_scope() in ('plataforma','mi_empresa')
    or exists (select 1 from public.employees e where e.id = employee_id and (e.campaign_id = any(public.my_campaign_ids()) or e.user_id = auth.uid()))
  ));
create policy "asistencia gestion" on public.attendance_daily for all to authenticated using (public.tenant_visible(tenant_id) and public.has_permission('asistencia','editar')) with check (public.tenant_visible(tenant_id));

create policy "ajustes lectura" on public.attendance_adjustments for select to authenticated using (public.tenant_visible(tenant_id));
create policy "ajustes insertar" on public.attendance_adjustments for insert to authenticated with check (public.tenant_visible(tenant_id));

create policy "auditoria lectura" on public.audit_logs for select to authenticated using (public.tenant_visible(tenant_id));
create policy "auditoria insertar" on public.audit_logs for insert to authenticated with check (public.tenant_visible(tenant_id) or tenant_id is null);

-- ============ SEED ============
insert into public.permissions (module, action, label)
select m.module, a.action, a.action || ' ' || m.module
from (values ('dashboard'),('empleados'),('usuarios'),('campanas'),('centros_costo'),('asistencia'),('marcaciones'),('dispositivos'),('importaciones'),('turnos'),('reglas'),('festivos'),('roles'),('empresas'),('auditoria'),('reportes')) as m(module)
cross join (values ('ver'),('crear'),('editar'),('eliminar'),('importar'),('exportar'),('aprobar'),('rechazar'),('ajustar'),('configurar')) as a(action);

insert into public.roles (tenant_id, code, name, description, is_system) values
 (null,'super_admin','Super Administrador','Acceso total a la plataforma', true),
 (null,'admin','Administrador','Administra toda la empresa', true),
 (null,'coordinador','Coordinador','Campañas asignadas', true),
 (null,'nomina','Nómina','Consolidado y conciliación', true),
 (null,'supervisor','Supervisor','Sus campañas', true),
 (null,'asesor','Asesor','Solo su información', true),
 (null,'bo','Back Office','Apoyo operativo', true);

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p where r.code in ('super_admin','admin');
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.action in ('ver','exportar','aprobar','rechazar','ajustar','importar') where r.code = 'nomina';
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.action in ('ver','exportar') where r.code in ('supervisor','coordinador','bo');
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.action = 'ver' and p.module in ('dashboard','asistencia','marcaciones') where r.code = 'asesor';

insert into public.tenants (id, name, nit, country) values
 ('11111111-1111-1111-1111-111111111111','INTELLIGENT CUSTOMER ACQUISITION S.A.S.','901.264.539-9','CO');

insert into public.shifts (tenant_id, code, name, start_time, end_time, crosses_midnight, break_minutes)
values ('11111111-1111-1111-1111-111111111111','ADM','Administrativo 08:00 - 17:00','08:00','17:00', false, 60),
       ('11111111-1111-1111-1111-111111111111','NOC','Nocturno 21:00 - 06:00','21:00','06:00', true, 60);

insert into public.cost_centers (tenant_id, code, name) values
 ('11111111-1111-1111-1111-111111111111','MUNDO','MUNDO');

insert into public.campaigns (tenant_id, code, name, cost_center_id, shift_id)
select '11111111-1111-1111-1111-111111111111','MUNDO','MUNDO',
 (select id from public.cost_centers where code='MUNDO'),
 (select id from public.shifts where code='ADM');

insert into public.rules (tenant_id, key, value, description) values
 ('11111111-1111-1111-1111-111111111111','dedupe_seconds','60','Segundos para considerar una marcación repetida'),
 ('11111111-1111-1111-1111-111111111111','jornada_minutos','480','Jornada esperada en minutos'),
 ('11111111-1111-1111-1111-111111111111','ventana_nocturna_horas','4','Horas después del fin de turno nocturno que siguen perteneciendo a la jornada'),
 ('11111111-1111-1111-1111-111111111111','max_horas_jornada','16','Máximo de horas permitidas por jornada');

-- ============ NUEVO USUARIO -> PERFIL ============
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := '11111111-1111-1111-1111-111111111111';
  v_role uuid;
begin
  insert into public.profiles (id, tenant_id, full_name, email)
  values (new.id, v_tenant, coalesce(new.raw_user_meta_data->>'full_name', new.email), new.email)
  on conflict (id) do nothing;

  if lower(new.email) = 'nuevpro2020@gmail.com' then
    select id into v_role from public.roles where code = 'super_admin' and tenant_id is null;
    insert into public.user_roles (user_id, role_id, tenant_id, scope)
    values (new.id, v_role, v_tenant, 'plataforma') on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();