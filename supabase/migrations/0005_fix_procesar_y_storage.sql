do $$
declare d text;
begin
  d := pg_get_functiondef('public.procesar_importacion(uuid)'::regprocedure);
  d := replace(d, '      employee_id = emp.id,', '      employee_id = (select x.id from public.employees x where x.tenant_id = v_tenant and x.document = e.document),');
  d := replace(d, '  left join lateral (select id from public.employees where tenant_id=v_tenant and document = e.document) emp on true
', '');
  execute d;
end $$;

drop policy if exists "biometrico actualizar" on storage.objects;
create policy "biometrico actualizar" on storage.objects for update to authenticated
  using (bucket_id = 'biometrico') with check (bucket_id = 'biometrico');

delete from public.biometric_events where import_id in (select id from public.biometric_imports where status='error');
delete from public.biometric_imports where status='error';