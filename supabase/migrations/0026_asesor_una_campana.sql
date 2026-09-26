-- Migración 0026: Un asesor puede tener como máximo una campaña asignada
-- (BO, supervisor y coordinador pueden tener una o varias).
create or replace function public.validar_campanas_por_rol()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select code from public.roles where id = new.role_id) = 'asesor'
     and cardinality(coalesce(new.campaign_ids, '{}')) > 1 then
    raise exception 'Un asesor solo puede tener una campaña asignada';
  end if;
  return new;
end $$;

drop trigger if exists validar_campanas_por_rol on public.user_roles;
create trigger validar_campanas_por_rol before insert or update on public.user_roles
for each row execute function public.validar_campanas_por_rol();
