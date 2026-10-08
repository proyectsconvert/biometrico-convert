-- Migración 0056: Supervisores por campaña
-- El supervisor de una persona es el usuario con rol Supervisor o Coordinador que tiene asignada su
-- campaña (Usuarios → Roles). Esta función entrega solo nombre, rol y campañas de esos usuarios para
-- los filtros «Supervisor», también a quien no puede ver la administración de usuarios (p. ej. Nómina).
-- «todas» = el rol ve toda la empresa (alcance mi_empresa o plataforma): cubre todas las campañas.

create or replace function public.supervisores_campanas()
returns table (user_id uuid, nombre text, rol text, campaign_ids uuid[], todas boolean)
language sql
stable
security definer
set search_path = public
as $$
  select ur.user_id,
         coalesce(nullif(trim(p.full_name), ''), p.email) as nombre,
         string_agg(distinct r.name, ' / ') as rol,
         coalesce(array_agg(distinct c) filter (where c is not null), '{}') as campaign_ids,
         bool_or(ur.scope in ('mi_empresa', 'plataforma')) as todas
  from user_roles ur
  join roles r on r.id = ur.role_id and r.code in ('supervisor', 'coordinador')
  join profiles p on p.id = ur.user_id and coalesce(p.is_active, true)
  left join lateral unnest(coalesce(ur.campaign_ids, '{}')) c on true
  where auth.uid() is not null
    and (public.is_super_admin() or ur.tenant_id = public.current_tenant_id())
  group by ur.user_id, p.full_name, p.email;
$$;

revoke all on function public.supervisores_campanas() from public, anon;
grant execute on function public.supervisores_campanas() to authenticated;

notify pgrst, 'reload schema';
