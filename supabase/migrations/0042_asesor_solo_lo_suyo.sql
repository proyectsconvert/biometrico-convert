-- Asesor = solo su propia información, tenga o no campaña asignada.
-- 1) Con alcance «solo yo» no se usan las campañas para ver personas: solo el empleado vinculado.
-- 2) Todo asesor queda con alcance «solo yo» (la campaña es solo informativa).

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
         and ((public.my_scope() <> 'solo_yo' and e.campaign_id = any(public.my_campaign_ids())) or e.user_id = auth.uid())),
      '{}'::text[])
  end;
$function$;

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
         and ((public.my_scope() <> 'solo_yo' and e.campaign_id = any(public.my_campaign_ids())) or e.user_id = auth.uid())),
      '{}'::uuid[])
  end;
$function$;

create or replace function public.validar_campanas_por_rol()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select code from public.roles where id = new.role_id) = 'asesor' then
    if cardinality(coalesce(new.campaign_ids, '{}')) > 1 then
      raise exception 'Un asesor solo puede tener una campaña asignada';
    end if;
    new.scope := 'solo_yo';
  end if;
  return new;
end $$;

update public.user_roles ur set scope = 'solo_yo'
from public.roles r where r.id = ur.role_id and r.code = 'asesor' and ur.scope <> 'solo_yo';
