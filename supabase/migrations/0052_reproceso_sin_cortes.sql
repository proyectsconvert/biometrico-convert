-- Migración 0052: Reproceso del histórico sin cortes por tiempo de espera
-- 1. reproceso_ocupado: indica si la base sigue ejecutando algo con el candado de la empresa. Tras un
--    corte de conexión (p. ej. el 504 de Cloudflare a los 100 s) la consulta sigue corriendo en la
--    base; el reproceso espera a que termine en vez de encimar otro intento detrás del candado.
-- 2. recalcular_jornadas_tramo: las jornadas se recalculan en un paso aparte (y por partes), así
--    ninguna llamada junta eventos y jornadas de muchos días.
-- 3. cerrar_importacion: el cierre se hace archivo por archivo con los índices por import_id, en vez
--    de agregados globales sobre millones de filas en una sola llamada.

/* ---------- 1. ¿Hay algo usando el candado de la empresa? ---------- */
create or replace function public.reproceso_ocupado(_tenant uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare k bigint := hashtext('procesar_importacion:' || _tenant::text);
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'No autorizado'; end if;
  -- pg_advisory_xact_lock(bigint) se ve en pg_locks partido en dos mitades de 32 bits
  return exists (
    select 1 from pg_locks l
    where l.locktype = 'advisory' and l.pid <> pg_backend_pid()
      and l.classid = ((k >> 32) & 4294967295)::oid
      and l.objid = (k & 4294967295)::oid
      and l.objsubid = 1
  );
end $$;

/* ---------- 2. Jornadas de un rango de días (paso aparte de los eventos) ---------- */
create or replace function public.recalcular_jornadas_tramo(_tenant uuid, _desde date, _hasta date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'No autorizado'; end if;
  perform pg_advisory_xact_lock(hashtext('procesar_importacion:' || _tenant::text));
  -- se conservan las jornadas ajustadas a mano
  delete from attendance_daily a where a.tenant_id = _tenant
    and a.work_date between _desde and _hasta and not a.is_manual
    and not exists (select 1 from attendance_adjustments x where x.attendance_id = a.id);
  return recalcular_asistencia(_tenant, _desde, _hasta);
end $$;

/* ---------- 3. Cierre de un archivo ---------- */
create or replace function public.cerrar_importacion(_import uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_crudas bigint; v_unicas bigint; v_aporta bigint; v_no_cuentan bigint; v_repetidas bigint;
  v_validas bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'No autorizado'; end if;

  select count(*), count(distinct (event_at, device_code, event_type, coalesce(raw_user, '')))
    into v_crudas, v_unicas
  from biometric_raw where import_id = _import;

  select count(*),
         count(*) filter (where not is_attendance),
         count(*) filter (where is_duplicate)
    into v_aporta, v_no_cuentan, v_repetidas
  from biometric_events where import_id = _import;

  -- válidas: marcaciones del archivo que quedaron en la capa limpia (aunque las aporte otro archivo)
  select count(*) into v_validas
  from (select distinct tenant_id, event_at, device_code, event_type, raw_user
        from biometric_raw where import_id = _import) r
  join biometric_events e
    on e.tenant_id = r.tenant_id and e.event_at = r.event_at
   and e.device_code = r.device_code and e.event_type = r.event_type and e.raw_user = r.raw_user
  where e.is_attendance and not e.is_duplicate;

  update biometric_imports set
    rows_raw = v_crudas,
    rows_repeated_in_file = v_crudas - v_unicas,
    rows_new = v_aporta,
    rows_existing = greatest(0, v_unicas - v_aporta),
    rows_valid = v_validas,
    rows_ignored = v_no_cuentan,
    rows_duplicated = v_repetidas,
    status = case when v_crudas > 0 then 'completado' else status end,
    error_message = case when v_crudas > 0 then null else error_message end,
    finished_at = coalesce(finished_at, now())
  where id = _import;

  return jsonb_build_object('filas_crudas', v_crudas, 'eventos_limpios', v_aporta, 'validas', v_validas);
end $$;

revoke all on function public.reproceso_ocupado(uuid) from public, anon, authenticated;
revoke all on function public.recalcular_jornadas_tramo(uuid, date, date) from public, anon, authenticated;
revoke all on function public.cerrar_importacion(uuid) from public, anon, authenticated;
grant execute on function public.reproceso_ocupado(uuid) to service_role;
grant execute on function public.recalcular_jornadas_tramo(uuid, date, date) to service_role;
grant execute on function public.cerrar_importacion(uuid) to service_role;

notify pgrst, 'reload schema';
