-- Migración 0018: Solo las autenticaciones exitosas son marcaciones y crean empleados
-- Corrige dos fallos del motor:
--  1. El criterio ilike '%exitosa%' también aceptaba eventos administrativos como
--     «Actualización parcial del usuario exitosa (BioStar)» como marcación laboral.
--  2. Se creaban empleados con cualquier evento con documento (enrolamiento, borrado,
--     actualización masiva de usuarios en BioStar), llenando el maestro de registros sin marcaciones.

create or replace function public.es_marcacion_valida(_event_type text)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(_event_type ilike '%autenticaci_n exitosa%' and _event_type not ilike '%fallida%', false);
$$;
grant execute on function public.es_marcacion_valida(text) to authenticated, service_role;

create or replace function public.procesar_importacion(_import_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_tenant uuid; v_dedupe integer; v_valid integer; v_ignored integer; v_total integer; v_dup integer;
  v_desde timestamp; v_hasta timestamp;
begin
  select tenant_id into v_tenant from public.biometric_imports where id = _import_id;
  if v_tenant is null then raise exception 'Importación no encontrada'; end if;
  if coalesce(auth.role(),'') <> 'service_role' and not public.tenant_visible(v_tenant) then
    raise exception 'Sin acceso a esta empresa';
  end if;
  select coalesce((value#>>'{}')::integer, 60) into v_dedupe from public.rules where tenant_id = v_tenant and key = 'dedupe_seconds';
  v_dedupe := coalesce(v_dedupe, 60);

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
      is_attendance = (e.document is not null and public.es_marcacion_valida(e.event_type))
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
  from ordenados o where o.id = e.id and o.import_id = _import_id;

  select count(*), count(*) filter (where is_attendance and not is_duplicate),
         count(*) filter (where not is_attendance), count(*) filter (where is_duplicate)
    into v_total, v_valid, v_ignored, v_dup
  from public.biometric_events where import_id = _import_id;

  update public.biometric_imports
  set rows_processed = v_total, rows_valid = v_valid, rows_ignored = v_ignored, rows_duplicated = v_dup
  where id = _import_id;

  return jsonb_build_object('total', v_total, 'validas', v_valid, 'ignoradas', v_ignored, 'duplicadas', v_dup,
    'desde', v_desde::date + 1, 'hasta', v_hasta::date - 1);
end $$;
grant execute on function public.procesar_importacion(uuid) to authenticated, service_role;

-- Corregir eventos ya importados y recalcular los días afectados
do $$
declare r record;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  create temp table afectados on commit drop as
    select distinct e.tenant_id, e.employee_id, e.event_at::date as dia
    from public.biometric_events e
    where e.is_attendance and not public.es_marcacion_valida(e.event_type);

  update public.biometric_events e set is_attendance = false, is_duplicate = false
  where e.is_attendance and not public.es_marcacion_valida(e.event_type);

  -- jornadas calculadas (no manuales) de esos días se regeneran desde cero
  delete from public.attendance_daily a using afectados x
  where a.employee_id = x.employee_id and a.work_date between x.dia - 1 and x.dia and not a.is_manual;

  for r in select tenant_id, min(dia) - 1 as d1, max(dia) as d2 from afectados group by tenant_id loop
    perform public.recalcular_asistencia(r.tenant_id, r.d1, r.d2);
  end loop;

  -- conteos de las importaciones
  update public.biometric_imports i set
    rows_valid = x.v, rows_ignored = x.ig, rows_duplicated = x.du
  from (select import_id, count(*) filter (where is_attendance and not is_duplicate) v,
               count(*) filter (where not is_attendance) ig, count(*) filter (where is_duplicate) du
        from public.biometric_events group by import_id) x
  where x.import_id = i.id;
end $$;
