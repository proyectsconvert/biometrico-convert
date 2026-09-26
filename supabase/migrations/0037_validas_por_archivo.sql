-- "Marcaciones válidas" de cada archivo = marcaciones que cuentan (asistencia, no repetidas)
-- que el archivo contiene, aunque otro archivo las haya aportado primero al histórico.
-- Antes solo se contaban las que el archivo aportaba como nuevas, y los archivos solapados quedaban en 0.
create or replace function public.estadisticas_importacion(_import uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_validas bigint;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'No autorizado'; end if;

  -- igualdad simple (una marcación válida siempre tiene usuario) para usar el índice único
  select count(*) into v_validas
  from (select distinct tenant_id, event_at, device_code, event_type, raw_user
        from biometric_raw where import_id = _import) r
  join biometric_events e
    on e.tenant_id = r.tenant_id and e.event_at = r.event_at
   and e.device_code = r.device_code and e.event_type = r.event_type and e.raw_user = r.raw_user
  where e.is_attendance and not e.is_duplicate;

  update biometric_imports set rows_valid = v_validas where id = _import;
  return jsonb_build_object('validas', v_validas);
end $$;
revoke all on function public.estadisticas_importacion(uuid) from public, anon, authenticated;
grant execute on function public.estadisticas_importacion(uuid) to service_role;
