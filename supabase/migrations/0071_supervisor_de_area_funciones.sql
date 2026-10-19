-- Migración 0071: Funciones del alcance «cargos_asignados» (supervisor de área). Ver 0070.

alter table public.user_roles add column if not exists cargos text[] not null default '{}';

-- Cargos (normalizados) que el usuario supervisa por sus roles de alcance «cargos_asignados»
create or replace function public._mis_cargos()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct upper(trim(c))) filter (where nullif(trim(c), '') is not null), '{}')
  from public.user_roles ur, unnest(coalesce(ur.cargos, '{}')) c
  where ur.user_id = auth.uid() and ur.scope::text = 'cargos_asignados';
$$;
grant execute on function public._mis_cargos() to authenticated;

CREATE OR REPLACE FUNCTION public.my_scope()
 RETURNS app_scope
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when public.is_admin_or_nomina() then 'plataforma'::public.app_scope
    else coalesce(
      (select ur.scope from public.user_roles ur
        where ur.user_id = auth.uid()
        order by case ur.scope::text
          when 'plataforma' then 1 when 'mi_empresa' then 2
          when 'campanas_asignadas' then 3 when 'cargos_asignados' then 4 when 'mi_campana' then 5 else 6 end
        limit 1), 'solo_yo'::public.app_scope)
  end;
$function$;

-- Personas visibles: por campaña (supervisor/coordinador), por cargo (supervisor de área) y la propia
CREATE OR REPLACE FUNCTION public.my_employee_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when public.is_admin_or_nomina() or public.ve_toda_empresa()
    then (select coalesce(array_agg(id), '{}'::uuid[]) from public.employees where public.tenant_visible(tenant_id))
    else coalesce(
      (select array_agg(e.id) from public.employees e
       where e.tenant_id = public.current_tenant_id()
         and ((public.my_scope() <> 'solo_yo' and e.campaign_id = any(public.my_campaign_ids()))
              or e.user_id = auth.uid()
              or upper(trim(e.position)) = any(public._mis_cargos()))),
      '{}'::uuid[])
  end;
$function$;

CREATE OR REPLACE FUNCTION public.my_documents()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when public.is_admin_or_nomina() or public.ve_toda_empresa()
    then (select coalesce(array_agg(document), '{}'::text[]) from public.employees where public.tenant_visible(tenant_id) and document is not null)
    else coalesce(
      (select array_agg(e.document) from public.employees e
       where e.tenant_id = public.current_tenant_id()
         and ((public.my_scope() <> 'solo_yo' and e.campaign_id = any(public.my_campaign_ids()))
              or e.user_id = auth.uid()
              or upper(trim(e.position)) = any(public._mis_cargos()))),
      '{}'::text[])
  end;
$function$;

-- Reglas al guardar un rol: el asesor solo lo suyo; el supervisor de área sin campañas y con al menos un cargo
CREATE OR REPLACE FUNCTION public.validar_campanas_por_rol()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if (select code from public.roles where id = new.role_id) = 'asesor' then
    if cardinality(coalesce(new.campaign_ids, '{}')) > 1 then
      raise exception 'Un asesor solo puede tener una campaña asignada';
    end if;
    new.scope := 'solo_yo';
  end if;
  if new.scope::text = 'cargos_asignados' then
    new.campaign_ids := '{}';
    new.cargos := coalesce((select array_agg(distinct upper(trim(c))) from unnest(coalesce(new.cargos, '{}')) c
                            where nullif(trim(c), '') is not null), '{}');
    if cardinality(new.cargos) = 0 then raise exception 'Selecciona al menos un cargo para el supervisor de área'; end if;
  else
    new.cargos := '{}';
  end if;
  return new;
end $function$;

-- Rol del sistema «Supervisor de área» con los permisos de «Supervisor»
insert into public.roles (tenant_id, code, name, description, is_system)
select null, 'supervisor_area', 'Supervisor de área',
       'Supervisor de calidad, formación, BO…: ve a las personas de los cargos que tiene a cargo, sin acceso a campañas', true
where not exists (select 1 from public.roles where code = 'supervisor_area');
insert into public.role_permissions (role_id, permission_id)
select (select id from public.roles where code = 'supervisor_area'), rp.permission_id
from public.role_permissions rp join public.roles r on r.id = rp.role_id and r.code = 'supervisor'
on conflict do nothing;

notify pgrst, 'reload schema';
