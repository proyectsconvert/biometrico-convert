-- Migración 0036: Reconstrucción por tramos de HORAS (algunos días traen cientos de miles de filas,
-- p. ej. 17/02/2025 con 411.586 «User update succeeded» de una sincronización masiva de BioStar)
CREATE OR REPLACE FUNCTION public.reconstruir_tramo(_tenant uuid, _ini timestamp without time zone, _fin timestamp without time zone, _recalcular boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_todos boolean; v_dedupe integer; v_limpias integer; v_crudas integer; v_jornadas integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'No autorizado'; end if;
  perform pg_advisory_xact_lock(hashtext('procesar_importacion:' || _tenant::text));
  select coalesce((value#>>'{}')::integer, 60) into v_dedupe from rules where tenant_id = _tenant and key = 'dedupe_seconds';
  v_dedupe := coalesce(v_dedupe, 60);
  v_todos := coalesce((select value#>>'{}' from rules where tenant_id = _tenant and key = 'eventos_asistencia'), 'exitosas') = 'todos_con_usuario';

  -- capa limpia del mes desde cero: un evento distinto por (segundo, lector, evento, usuario)
  delete from biometric_events where tenant_id = _tenant and event_at >= _ini and event_at < _fin;
  insert into biometric_events
    (tenant_id, import_id, event_at, door, device_code, device_name, user_group, raw_user, document, biometric_name, event_type)
  select tenant_id, import_id, event_at, door, device_code, device_name, user_group, raw_user, document, biometric_name, event_type
  from (
    select distinct on (r.event_at, r.device_code, r.event_type, coalesce(r.raw_user, ''))
           r.tenant_id, r.import_id, r.event_at, r.door, r.device_code, r.device_name, r.user_group, r.raw_user,
           r.document, r.biometric_name, r.event_type
    from biometric_raw r join biometric_imports i on i.id = r.import_id
    where r.tenant_id = _tenant and r.event_at >= _ini and r.event_at < _fin
    order by r.event_at, r.device_code, r.event_type, coalesce(r.raw_user, ''), i.started_at, r.line_no
  ) u
  order by u.document nulls last, u.event_at;
  get diagnostics v_limpias = row_count;
  select count(*) into v_crudas from biometric_raw where tenant_id = _tenant and event_at >= _ini and event_at < _fin;

  -- lectores nuevos y enlace
  insert into devices (tenant_id, device_code, name, door_name, classification)
  select _tenant, device_code, min(coalesce(device_name, device_code)), min(door), sugerir_clasificacion('')
  from biometric_events where tenant_id = _tenant and event_at >= _ini and event_at < _fin
  group by device_code
  on conflict (tenant_id, device_code) do nothing;

  -- qué cuenta como marcación
  update biometric_events set is_attendance = (document is not null and (v_todos or es_marcacion_valida(event_type)))
  where tenant_id = _tenant and event_at >= _ini and event_at < _fin;

  -- empleados para quien tenga autenticaciones exitosas; grupo y empleador sugerido
  insert into employees (tenant_id, document, full_name)
  select _tenant, document, coalesce(max(biometric_name), 'SIN NOMBRE ' || document)
  from biometric_events where tenant_id = _tenant and event_at >= _ini and event_at < _fin
    and document is not null and es_marcacion_valida(event_type)
  group by document
  on conflict (tenant_id, document) do nothing;
  update employees emp set biometric_group = x.g
  from (select distinct on (document) document, user_group g from biometric_events
        where tenant_id = _tenant and event_at >= _ini and event_at < _fin
          and document is not null and nullif(trim(user_group), '') is not null
        order by document, event_at desc) x
  where emp.tenant_id = _tenant and emp.document = x.document and emp.biometric_group is null;
  perform asignar_empleador_por_grupo(_tenant);

  update biometric_events e set employee_id = emp.id, device_id = d.id
  from employees emp, devices d
  where e.tenant_id = _tenant and e.event_at >= _ini and e.event_at < _fin
    and emp.tenant_id = _tenant and emp.document = e.document
    and d.tenant_id = _tenant and d.device_code = e.device_code;
  update biometric_events e set device_id = d.id
  from devices d
  where e.tenant_id = _tenant and e.event_at >= _ini and e.event_at < _fin and e.document is null
    and d.tenant_id = _tenant and d.device_code = e.device_code;

  -- repetidas (misma persona y lector dentro de la tolerancia), mirando también el día anterior
  with o as (
    select id, event_at,
           coalesce(event_at - lag(event_at) over (partition by document, device_code order by event_at) < make_interval(secs => v_dedupe), false) as dup
    from biometric_events
    where tenant_id = _tenant and is_attendance and event_at >= _ini - interval '1 day' and event_at < _fin
  )
  update biometric_events e set is_duplicate = o.dup
  from o where o.id = e.id and o.event_at >= _ini and e.is_duplicate is distinct from o.dup;

  -- jornadas del mes desde cero (se conservan las ajustadas a mano)
  -- jornadas: solo al cerrar el último tramo del día (se conservan las ajustadas a mano)
  v_jornadas := 0;
  if _recalcular then
    delete from attendance_daily a where a.tenant_id = _tenant
      and a.work_date between _ini::date and (_fin - interval '1 second')::date and not a.is_manual
      and not exists (select 1 from attendance_adjustments x where x.attendance_id = a.id);
    v_jornadas := recalcular_asistencia(_tenant, _ini::date, (_fin - interval '1 second')::date);
  end if;

  return jsonb_build_object('desde', _ini, 'hasta', _fin, 'filas_crudas', v_crudas, 'eventos_limpios', v_limpias, 'jornadas', v_jornadas);
end $function$;
revoke all on function public.reconstruir_tramo(uuid, timestamp, timestamp, boolean) from public, anon, authenticated;
grant execute on function public.reconstruir_tramo(uuid, timestamp, timestamp, boolean) to service_role;

-- reconstruir_mes queda como atajo de un tramo de días completos
create or replace function public.reconstruir_mes(_tenant uuid, _desde date, _hasta date)
returns jsonb language sql security definer set search_path = public as $$
  select public.reconstruir_tramo(_tenant, _desde::timestamp, (_hasta + 1)::timestamp, true);
$$;
revoke all on function public.reconstruir_mes(uuid, date, date) from public, anon, authenticated;
grant execute on function public.reconstruir_mes(uuid, date, date) to service_role;

-- filas crudas por hora (para partir los días pesados)
create or replace function public.filas_crudas_por_hora(_tenant uuid, _dia date)
returns table (hora timestamp, filas integer) language sql stable security definer set search_path = public as $$
  select date_trunc('hour', event_at), count(*)::int from public.biometric_raw
  where tenant_id = _tenant and event_at >= _dia and event_at < _dia + 1 group by 1 order by 1;
$$;
revoke all on function public.filas_crudas_por_hora(uuid, date) from public, anon, authenticated;
grant execute on function public.filas_crudas_por_hora(uuid, date) to service_role;
