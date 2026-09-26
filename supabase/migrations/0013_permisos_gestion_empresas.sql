-- Migración 0013: Políticas completas de gestión para empresas (tenants)

drop policy if exists "tenants admin" on public.tenants;

create policy "tenants gestion" on public.tenants for all to authenticated
  using (
    public.is_super_admin()
    or (select public.has_permission('empresas', 'editar'))
    or (select public.has_permission('empresas', 'crear'))
    or (select public.has_permission('empresas', 'eliminar'))
  )
  with check (
    public.is_super_admin()
    or (select public.has_permission('empresas', 'editar'))
    or (select public.has_permission('empresas', 'crear'))
  );

grant select, insert, update, delete on public.tenants to authenticated, service_role;
