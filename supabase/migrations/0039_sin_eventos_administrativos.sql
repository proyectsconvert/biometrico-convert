-- Regla «sin_administrativos»: cuentan todos los registros con usuario (huella, tarjeta, acceso
-- denegado, autenticación fallida) EXCEPTO los eventos administrativos de BioStar (actualizar, enrolar
-- o borrar usuario), que aparecen en todos los lectores a la vez al sincronizar y falsean la salida.
create or replace function public.es_evento_administrativo(_event_type text)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(_event_type ilike '%(BioStar)%' or _event_type ilike 'User %succeeded%', false);
$$;

insert into public.rules (tenant_id, key, value)
select id, 'eventos_asistencia', to_jsonb('sin_administrativos'::text) from public.tenants
on conflict (tenant_id, key) do update set value = excluded.value;

-- procesar_importacion: solo cambia la condición de is_attendance (6 reemplazos)
CREATE OR REPLACE FUNCTION public.procesar_importacion(_import_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid; v_dedupe integer; v_valid integer; v_ignored integer; v_total integer; v_dup integer;
  v_desde timestamp; v_hasta timestamp; v_todos boolean; v_sin_adm boolean;
begin
  select tenant_id into v_tenant from public.biometric_imports where id = _import_id;
  if v_tenant is null then raise exception 'Importación no encontrada'; end if;
  if coalesce(auth.role(),'') <> 'service_role' and not public.tenant_visible(v_tenant) then
    raise exception 'Sin acceso a esta empresa';
  end if;
  select coalesce((value#>>'{}')::integer, 60) into v_dedupe from public.rules where tenant_id = v_tenant and key = 'dedupe_seconds';
  v_dedupe := coalesce(v_dedupe, 60);
  v_todos := coalesce((select value#>>'{}' from public.rules where tenant_id = v_tenant and key = 'eventos_asistencia'), 'exitosas') = 'todos_con_usuario';
  v_sin_adm := coalesce((select value#>>'{}' from public.rules where tenant_id = v_tenant and key = 'eventos_asistencia'), 'exitosas') = 'sin_administrativos';
  perform pg_advisory_xact_lock(hashtext('procesar_importacion:' || v_tenant::text));

  insert into public.devices (tenant_id, device_code, name, door_name, classification)
  select v_tenant, e.device_code, min(coalesce(e.device_name, e.device_code)), min(e.door),
         public.sugerir_clasificacion(min(coalesce(e.device_name,'')) || ' ' || coalesce(min(e.door),''))
  from public.biometric_events e where e.import_id = _import_id
  group by e.device_code
  on conflict (tenant_id, device_code) do nothing;

  -- crear empleados solo para personas con al menos una autenticación exitosa
  insert into public.employees (tenant_id, document, full_name)
  select v_tenant, e.document, coalesce(max(e.biometric_name), 'SIN NOMBRE ' || e.document)
  from public.biometric_events e
  where e.import_id = _import_id and e.document is not null and public.es_marcacion_valida(e.event_type)
  group by e.document
  on conflict (tenant_id, document) do nothing;

  update public.employees emp set full_name = x.n
  from (select document, max(biometric_name) n from public.biometric_events
        where import_id=_import_id and biometric_name is not null group by document) x
  where emp.tenant_id=v_tenant and emp.document=x.document and emp.full_name like 'SIN NOMBRE %';

  -- grupo biométrico más reciente del archivo y empleador sugerido por ese grupo
  update public.employees emp set biometric_group = x.g
  from (select distinct on (document) document, user_group g from public.biometric_events
        where import_id=_import_id and document is not null and nullif(trim(user_group),'') is not null
        order by document, event_at desc) x
  where emp.tenant_id=v_tenant and emp.document=x.document and emp.biometric_group is distinct from x.g;
  perform public.asignar_empleador_por_grupo(v_tenant);

  -- Todas las autenticaciones exitosas con documento cuentan, sin importar la puerta
  update public.biometric_events e
  set device_id = d.id,
      employee_id = (select emp.id from public.employees emp where emp.tenant_id = v_tenant and emp.document = e.document limit 1),
      is_attendance = (e.document is not null and (v_todos or (v_sin_adm and not public.es_evento_administrativo(e.event_type)) or public.es_marcacion_valida(e.event_type)))
  from public.devices d
  where e.import_id = _import_id and d.tenant_id = v_tenant and d.device_code = e.device_code;

  select min(event_at) - interval '1 day', max(event_at) + interval '1 day' into v_desde, v_hasta
  from public.biometric_events where import_id = _import_id;

  with ordenados as (
    select e.id, e.import_id,
           lag(e.event_at) over (partition by e.document, e.device_code order by e.event_at) as prev_at
    from public.biometric_events e
    where e.tenant_id = v_tenant and e.is_attendance and e.event_at between v_desde and v_hasta
      and e.document in (select distinct document from public.biometric_events where import_id=_import_id)
  )
  update public.biometric_events e
  set is_duplicate = (o.prev_at is not null and e.event_at - o.prev_at < make_interval(secs => v_dedupe))
  from ordenados o where o.id = e.id
    and e.is_duplicate is distinct from (o.prev_at is not null and e.event_at - o.prev_at < make_interval(secs => v_dedupe));

  select count(*), count(*) filter (where is_attendance and not is_duplicate),
         count(*) filter (where not is_attendance), count(*) filter (where is_duplicate)
    into v_total, v_valid, v_ignored, v_dup
  from public.biometric_events where import_id = _import_id;

  update public.biometric_imports
  set rows_processed = v_total, rows_valid = v_valid, rows_ignored = v_ignored, rows_duplicated = v_dup
  where id = _import_id;

  return jsonb_build_object('total', v_total, 'validas', v_valid, 'ignoradas', v_ignored, 'duplicadas', v_dup,
    'desde', v_desde::date + 1, 'hasta', v_hasta::date - 1);
end $function$;

-- reconstruir_tramo: solo cambia la condición de is_attendance (6 reemplazos)
CREATE OR REPLACE FUNCTION public.reconstruir_tramo(_tenant uuid, _ini timestamp without time zone, _fin timestamp without time zone, _recalcular boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_todos boolean; v_sin_adm boolean; v_dedupe integer; v_limpias integer; v_crudas integer; v_jornadas integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'No autorizado'; end if;
  perform pg_advisory_xact_lock(hashtext('procesar_importacion:' || _tenant::text));
  select coalesce((value#>>'{}')::integer, 60) into v_dedupe from rules where tenant_id = _tenant and key = 'dedupe_seconds';
  v_dedupe := coalesce(v_dedupe, 60);
  v_todos := coalesce((select value#>>'{}' from rules where tenant_id = _tenant and key = 'eventos_asistencia'), 'exitosas') = 'todos_con_usuario';
  v_sin_adm := coalesce((select value#>>'{}' from rules where tenant_id = _tenant and key = 'eventos_asistencia'), 'exitosas') = 'sin_administrativos';

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
  update biometric_events set is_attendance = (document is not null and (v_todos or (v_sin_adm and not public.es_evento_administrativo(event_type)) or es_marcacion_valida(event_type)))
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
