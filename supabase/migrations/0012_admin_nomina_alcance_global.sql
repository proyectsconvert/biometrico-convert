-- Migración 0012: Permitir a roles 'admin' y 'nomina' ver todas las campañas y toda la plataforma

-- 1. Funciones para identificar super_admin, admin o nómina (sin y con argumento)
create or replace function public.is_admin_or_nomina()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid() and r.code in ('super_admin', 'admin', 'nomina')
  );
$$;

create or replace function public.is_admin_or_nomina(_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = _user_id and r.code in ('super_admin', 'admin', 'nomina')
  );
$$;

grant execute on function public.is_admin_or_nomina() to authenticated, service_role;
grant execute on function public.is_admin_or_nomina(uuid) to authenticated, service_role;

-- 2. El alcance (my_scope) para admin y nomina es automáticamente 'plataforma'
create or replace function public.my_scope()
returns public.app_scope language sql stable security definer set search_path = public as $$
  select case
    when public.is_admin_or_nomina() then 'plataforma'::public.app_scope
    else coalesce(
      (select ur.scope from public.user_roles ur
        where ur.user_id = auth.uid()
        order by case ur.scope
          when 'plataforma' then 1 when 'mi_empresa' then 2
          when 'campanas_asignadas' then 3 when 'mi_campana' then 4 else 5 end
        limit 1), 'solo_yo'::public.app_scope)
  end;
$$;

-- 3. ve_toda_empresa incluye super_admin, admin y nomina
create or replace function public.ve_toda_empresa()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin_or_nomina() or public.my_scope() in ('plataforma','mi_empresa');
$$;

-- 4. tenant_visible permite a super_admin, admin y nomina acceder a cualquier tenant
create or replace function public.tenant_visible(_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin_or_nomina()
     or public.my_scope() = 'plataforma'
     or (_tenant_id is not null and _tenant_id = public.current_tenant_id());
$$;

-- 5. my_campaign_ids retorna todas las campañas para super_admin, admin y nomina
create or replace function public.my_campaign_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select case
    when public.is_admin_or_nomina() or public.my_scope() in ('plataforma','mi_empresa')
    then (select coalesce(array_agg(id), '{}'::uuid[]) from public.campaigns where public.tenant_visible(tenant_id))
    else coalesce(
      (select array_agg(distinct c) from (
        select unnest(ur.campaign_ids) as c from public.user_roles ur where ur.user_id = auth.uid()
        union
        select cr.campaign_id from public.campaign_responsibles cr where cr.user_id = auth.uid()
      ) s), '{}'::uuid[])
  end;
$$;

-- 6. my_employee_ids retorna todos los empleados para super_admin, admin y nomina
create or replace function public.my_employee_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select case
    when public.is_admin_or_nomina() or public.ve_toda_empresa()
    then (select coalesce(array_agg(id), '{}'::uuid[]) from public.employees where public.tenant_visible(tenant_id))
    else coalesce(
      (select array_agg(e.id) from public.employees e
       where e.tenant_id = public.current_tenant_id()
         and (e.campaign_id = any(public.my_campaign_ids()) or e.user_id = auth.uid())),
      '{}'::uuid[])
  end;
$$;

-- 7. my_documents retorna todos los documentos para super_admin, admin y nomina
create or replace function public.my_documents()
returns text[] language sql stable security definer set search_path = public as $$
  select case
    when public.is_admin_or_nomina() or public.ve_toda_empresa()
    then (select coalesce(array_agg(document), '{}'::text[]) from public.employees where public.tenant_visible(tenant_id) and document is not null)
    else coalesce(
      (select array_agg(e.document) from public.employees e
       where e.tenant_id = public.current_tenant_id()
         and (e.campaign_id = any(public.my_campaign_ids()) or e.user_id = auth.uid())),
      '{}'::text[])
  end;
$$;

grant execute on function public.ve_toda_empresa(), public.my_employee_ids(), public.my_documents(), public.my_campaign_ids(), public.tenant_visible(uuid) to authenticated, service_role;

-- 8. Actualizar política de lectura de campañas para garantizar acceso total a admin y nomina
drop policy if exists "campanas lectura" on public.campaigns;
create policy "campanas lectura" on public.campaigns for select to authenticated using (
  public.tenant_visible(tenant_id) and (
    public.is_admin_or_nomina()
    or public.my_scope() in ('plataforma','mi_empresa')
    or id = any(public.my_campaign_ids())
  )
);

-- 9. Asegurar permisos completos de consulta de campañas, empleados, empresas y reportes para nomina
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'nomina' and (
  (p.module in ('campanas', 'empleados', 'asistencia', 'marcaciones', 'novedades', 'dashboard', 'reportes', 'empresas', 'centros_costo', 'turnos') and p.action in ('ver', 'exportar'))
  or (p.module in ('novedades', 'asistencia') and p.action in ('aprobar', 'rechazar', 'ajustar', 'crear', 'editar', 'importar'))
)
on conflict do nothing;

-- 10. Actualizar las asignaciones existentes de admin y nómina a alcance 'plataforma'
update public.user_roles ur
set scope = 'plataforma'
from public.roles r
where ur.role_id = r.id and r.code in ('admin', 'nomina') and ur.scope <> 'plataforma';
