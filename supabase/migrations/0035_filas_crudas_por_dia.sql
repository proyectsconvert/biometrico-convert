-- Migración 0035: Filas crudas por día (para dividir el reproceso en tramos cortos, < 100 s)
create or replace function public.filas_crudas_por_dia(_tenant uuid)
returns table (dia date, filas integer) language sql stable security definer set search_path = public as $$
  select event_at::date, count(*)::int from public.biometric_raw where tenant_id = _tenant group by 1 order by 1;
$$;
revoke all on function public.filas_crudas_por_dia(uuid) from public, anon, authenticated;
grant execute on function public.filas_crudas_por_dia(uuid) to service_role;
