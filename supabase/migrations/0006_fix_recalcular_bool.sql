do $$
declare d text;
begin
  d := pg_get_functiondef('public.recalcular_asistencia(uuid,date,date)'::regprocedure);
  d := replace(d, 'max(case when key=''aplica_dominical_festivo'' then (value#>>''{}'')::boolean end)', 'bool_or(case when key=''aplica_dominical_festivo'' then (value#>>''{}'')::boolean end)');
  execute d;
end $$;
create index if not exists bio_events_tenant_day_idx on public.biometric_events (tenant_id, ((event_at)::date));
delete from public.biometric_events where import_id in (select id from public.biometric_imports where status='error');
delete from public.biometric_imports where status='error';