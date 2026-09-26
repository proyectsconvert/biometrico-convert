drop policy if exists "eventos lectura" on public.biometric_events;
create policy "eventos lectura" on public.biometric_events for select to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));
drop policy if exists "eventos gestion" on public.biometric_events;
create policy "eventos gestion" on public.biometric_events for all to authenticated
  using (((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
         and (select public.has_permission('importaciones','importar')))
  with check ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));