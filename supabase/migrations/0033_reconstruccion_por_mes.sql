-- Migración 0033: Reconstrucción completa por etapas cortas (cada llamada < 100 s, límite de Cloudflare)
--   1. (servidor) recargar la capa cruda de cada archivo desde el almacenamiento
--   2. reconstruir_mes(): arma la capa limpia de un mes desde la capa cruda, ordenada por persona y
--      hora, clasifica, enlaza empleados/lectores, marca repetidas y recalcula las jornadas del mes
--   3. finalizar_reconstruccion(): regla de unicidad definitiva y estadísticas por archivo

create or replace function public.reconstruir_mes(_tenant uuid, _desde date, _hasta date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_dedupe integer; v_limpias integer; v_crudas integer; v_jornadas integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'No autorizado'; end if;
  perform pg_advisory_xact_lock(hashtext('procesar_importacion:' || _tenant::text));
  select coalesce((value#>>'{}')::integer, 60) into v_dedupe from rules where tenant_id = _tenant and key = 'dedupe_seconds';
  v_dedupe := coalesce(v_dedupe, 60);

  -- capa limpia del mes desde cero: un evento distinto por (segundo, lector, evento, usuario)
  delete from biometric_events where tenant_id = _tenant and event_at >= _desde and event_at < _hasta + 1;
  insert into biometric_events
    (tenant_id, import_id, event_at, door, device_code, device_name, user_group, raw_user, document, biometric_name, event_type)
  select tenant_id, import_id, event_at, door, device_code, device_name, user_group, raw_user, document, biometric_name, event_type
  from (
    select distinct on (r.event_at, r.device_code, r.event_type, coalesce(r.raw_user, ''))
           r.tenant_id, r.import_id, r.event_at, r.door, r.device_code, r.device_name, r.user_group, r.raw_user,
           r.document, r.biometric_name, r.event_type
    from biometric_raw r join biometric_imports i on i.id = r.import_id
    where r.tenant_id = _tenant and r.event_at >= _desde and r.event_at < _hasta + 1
    order by r.event_at, r.device_code, r.event_type, coalesce(r.raw_user, ''), i.started_at, r.line_no
  ) u
  order by u.document nulls last, u.event_at;
  get diagnostics v_limpias = row_count;
  select count(*) into v_crudas from biometric_raw where tenant_id = _tenant and event_at >= _desde and event_at < _hasta + 1;

  -- lectores nuevos y enlace
  insert into devices (tenant_id, device_code, name, door_name, classification)
  select _tenant, device_code, min(coalesce(device_name, device_code)), min(door), sugerir_clasificacion('')
  from biometric_events where tenant_id = _tenant and event_at >= _desde and event_at < _hasta + 1
  group by device_code
  on conflict (tenant_id, device_code) do nothing;

  -- qué cuenta como marcación
  update biometric_events set is_attendance = (document is not null and es_marcacion_valida(event_type))
  where tenant_id = _tenant and event_at >= _desde and event_at < _hasta + 1;

  -- empleados para quien tenga autenticaciones exitosas; grupo y empleador sugerido
  insert into employees (tenant_id, document, full_name)
  select _tenant, document, coalesce(max(biometric_name), 'SIN NOMBRE ' || document)
  from biometric_events where tenant_id = _tenant and event_at >= _desde and event_at < _hasta + 1 and is_attendance
  group by document
  on conflict (tenant_id, document) do nothing;
  update employees emp set biometric_group = x.g
  from (select distinct on (document) document, user_group g from biometric_events
        where tenant_id = _tenant and event_at >= _desde and event_at < _hasta + 1
          and document is not null and nullif(trim(user_group), '') is not null
        order by document, event_at desc) x
  where emp.tenant_id = _tenant and emp.document = x.document and emp.biometric_group is null;
  perform asignar_empleador_por_grupo(_tenant);

  update biometric_events e set employee_id = emp.id, device_id = d.id
  from employees emp, devices d
  where e.tenant_id = _tenant and e.event_at >= _desde and e.event_at < _hasta + 1
    and emp.tenant_id = _tenant and emp.document = e.document
    and d.tenant_id = _tenant and d.device_code = e.device_code;
  update biometric_events e set device_id = d.id
  from devices d
  where e.tenant_id = _tenant and e.event_at >= _desde and e.event_at < _hasta + 1 and e.document is null
    and d.tenant_id = _tenant and d.device_code = e.device_code;

  -- repetidas (misma persona y lector dentro de la tolerancia), mirando también el día anterior
  with o as (
    select id, event_at,
           coalesce(event_at - lag(event_at) over (partition by document, device_code order by event_at) < make_interval(secs => v_dedupe), false) as dup
    from biometric_events
    where tenant_id = _tenant and is_attendance and event_at >= _desde - 1 and event_at < _hasta + 1
  )
  update biometric_events e set is_duplicate = o.dup
  from o where o.id = e.id and o.event_at >= _desde and e.is_duplicate is distinct from o.dup;

  -- jornadas del mes desde cero (se conservan las ajustadas a mano)
  delete from attendance_daily a where a.tenant_id = _tenant and a.work_date between _desde and _hasta and not a.is_manual
    and not exists (select 1 from attendance_adjustments x where x.attendance_id = a.id);
  v_jornadas := recalcular_asistencia(_tenant, _desde, _hasta);

  return jsonb_build_object('desde', _desde, 'hasta', _hasta, 'filas_crudas', v_crudas, 'eventos_limpios', v_limpias, 'jornadas', v_jornadas);
end $$;
revoke all on function public.reconstruir_mes(uuid, date, date) from public, anon, authenticated;
grant execute on function public.reconstruir_mes(uuid, date, date) to service_role;

-- Meses que cubre la capa cruda (para recorrerlos en orden)
create or replace function public.meses_capa_cruda(_tenant uuid)
returns table (mes date) language sql stable security definer set search_path = public as $$
  select generate_series(date_trunc('month', min(event_at)), date_trunc('month', max(event_at)), interval '1 month')::date
  from biometric_raw where tenant_id = _tenant;
$$;
revoke all on function public.meses_capa_cruda(uuid) from public, anon, authenticated;
grant execute on function public.meses_capa_cruda(uuid) to service_role;

create or replace function public.finalizar_reconstruccion(_tenant uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_crudas bigint; v_limpias bigint;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'No autorizado'; end if;
  perform pg_advisory_xact_lock(hashtext('procesar_importacion:' || _tenant::text));

  -- dos eventos de puerta sin usuario idénticos también son el mismo evento
  if not exists (select 1 from pg_constraint where conname = 'biometric_events_evento_unico') then
    alter table biometric_events drop constraint if exists biometric_events_tenant_id_event_at_device_code_event_type__key;
    alter table biometric_events add constraint biometric_events_evento_unico
      unique nulls not distinct (tenant_id, event_at, device_code, event_type, raw_user);
  end if;

  update biometric_imports i set
    rows_raw = x.crudas,
    rows_found = x.crudas,
    rows_repeated_in_file = x.crudas - x.unicas,
    rows_new = coalesce(n.aporta, 0),
    rows_existing = greatest(0, x.unicas - coalesce(n.aporta, 0)),
    rows_valid = coalesce(n.validas, 0),
    rows_ignored = coalesce(n.no_cuentan, 0),
    rows_duplicated = coalesce(n.repetidas, 0),
    status = 'completado', error_message = null, finished_at = coalesce(i.finished_at, now())
  from (select import_id, count(*) crudas,
               count(distinct (event_at, device_code, event_type, coalesce(raw_user, ''))) unicas
        from biometric_raw where tenant_id = _tenant group by import_id) x
  left join (select import_id, count(*) aporta,
                    count(*) filter (where is_attendance and not is_duplicate) validas,
                    count(*) filter (where not is_attendance) no_cuentan,
                    count(*) filter (where is_duplicate) repetidas
             from biometric_events where tenant_id = _tenant group by import_id) n on n.import_id = x.import_id
  where x.import_id = i.id;

  select count(*) into v_crudas from biometric_raw where tenant_id = _tenant;
  select count(*) into v_limpias from biometric_events where tenant_id = _tenant;
  return jsonb_build_object('filas_crudas', v_crudas, 'eventos_limpios', v_limpias);
end $$;
revoke all on function public.finalizar_reconstruccion(uuid) from public, anon, authenticated;
grant execute on function public.finalizar_reconstruccion(uuid) to service_role;
