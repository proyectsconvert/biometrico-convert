-- Migración 0048: Trazabilidad completa, auditoría protegida, evidencias y permisos de edición masiva
-- 1. Permisos: Nómina puede crear/editar empleados (edición masiva) y programar turnos;
--    Administración puede consultar y exportar la auditoría.
-- 2. Auditoría protegida: solo la lee quien tiene «auditoria.ver»; nadie puede insertar a nombre
--    de otro, ni editar o borrar registros.
-- 3. Trazabilidad automática: todo alta, cambio (antes/después) o borrado en empleados, novedades,
--    plantillas, turnos, malla, campañas, centros de costo, empleadores, festivos, reglas y
--    dispositivos queda en la auditoría. Las cargas masivas se resumen en un registro.
-- 4. Comentarios con evidencias (documentos, fotos) por empleado y, opcionalmente, por día;
--    bucket privado «evidencias». Los comentarios no se editan ni se borran.
-- 5. Las solicitudes de ajuste de empleados admiten adjuntos al crearlas, comentarlas y resolverlas.

/* ============================== 1. Permisos ============================== */
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on
     (r.code = 'nomina' and ((p.module = 'empleados' and p.action in ('crear','editar'))
                          or (p.module = 'turnos' and p.action in ('asignar','crear','editar'))))
  or (r.code = 'admin' and p.module = 'auditoria' and p.action in ('ver','exportar'))
where not exists (select 1 from public.role_permissions x where x.role_id = r.id and x.permission_id = p.id);

/* ============================== 2. Auditoría protegida ============================== */
drop policy if exists "auditoria lectura" on public.audit_logs;
drop policy if exists "auditoria insertar" on public.audit_logs;
create policy "auditoria lectura" on public.audit_logs for select
  using ((public.tenant_visible(tenant_id) or (tenant_id is null and public.is_super_admin()))
         and public.has_permission('auditoria','ver'));
create policy "auditoria insertar" on public.audit_logs for insert
  with check ((public.tenant_visible(tenant_id) or tenant_id is null) and user_id = auth.uid());
revoke update, delete, truncate on public.audit_logs from authenticated, anon;

/* ============================== 3. Trazabilidad automática ============================== */
-- TG_ARGV[0] = módulo, TG_ARGV[1] = entidad (p. ej. 'novedades', 'novedad_dia')
create or replace function public.auditar_ins()
returns trigger language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select count(*) into n from nuevos;
  if n = 0 then return null; end if;
  if n <= 20 then
    insert into public.audit_logs (tenant_id, user_id, module, action, record_id, new_value)
    select (to_jsonb(x)->>'tenant_id')::uuid, auth.uid(), tg_argv[0], 'crear_' || tg_argv[1], to_jsonb(x)->>'id',
           to_jsonb(x) - 'created_at' - 'updated_at'
    from nuevos x;
  else
    insert into public.audit_logs (tenant_id, user_id, module, action, new_value)
    select (to_jsonb(x)->>'tenant_id')::uuid, auth.uid(), tg_argv[0], 'crear_' || tg_argv[1] || '_masivo',
           jsonb_build_object('registros', count(*), 'ids', to_jsonb((array_agg(to_jsonb(x)->>'id'))[1:50]))
    from nuevos x group by 1;
  end if;
  return null;
end $$;

create or replace function public.auditar_upd()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  create temp table if not exists _aud_cambios (tenant_id uuid, id text, antes jsonb, despues jsonb) on commit drop;
  truncate _aud_cambios;
  insert into _aud_cambios
  select t, id, antes, despues from (
    select (nj->>'tenant_id')::uuid as t, nj->>'id' as id,
           (select jsonb_object_agg(k, oj->k) from jsonb_object_keys(nj) k where k <> 'updated_at' and nj->k is distinct from oj->k) as antes,
           (select jsonb_object_agg(k, nj->k) from jsonb_object_keys(nj) k where k <> 'updated_at' and nj->k is distinct from oj->k) as despues
    from (select to_jsonb(n) as nj, to_jsonb(o) as oj from nuevos n join viejos o on to_jsonb(o)->>'id' = to_jsonb(n)->>'id') p
  ) d where antes is not null;

  insert into public.audit_logs (tenant_id, user_id, module, action, record_id, old_value, new_value)
  select tenant_id, auth.uid(), tg_argv[0], 'editar_' || tg_argv[1], id, antes, despues
  from (select * from _aud_cambios order by id limit 500) c;
  -- Cambios masivos: lo que pase de 500 se resume
  insert into public.audit_logs (tenant_id, user_id, module, action, new_value)
  select tenant_id, auth.uid(), tg_argv[0], 'editar_' || tg_argv[1] || '_masivo',
         jsonb_build_object('registros_adicionales', count(*), 'campos', (select jsonb_agg(distinct k) from _aud_cambios c2, jsonb_object_keys(c2.despues) k))
  from (select * from _aud_cambios order by id offset 500) c group by tenant_id;
  return null;
end $$;

create or replace function public.auditar_del()
returns trigger language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select count(*) into n from viejos;
  if n = 0 then return null; end if;
  if n <= 50 then
    insert into public.audit_logs (tenant_id, user_id, module, action, record_id, old_value)
    select (to_jsonb(x)->>'tenant_id')::uuid, auth.uid(), tg_argv[0], 'eliminar_' || tg_argv[1], to_jsonb(x)->>'id', to_jsonb(x)
    from viejos x;
  else
    insert into public.audit_logs (tenant_id, user_id, module, action, old_value)
    select (to_jsonb(x)->>'tenant_id')::uuid, auth.uid(), tg_argv[0], 'eliminar_' || tg_argv[1] || '_masivo',
           jsonb_build_object('registros', count(*), 'muestra', (jsonb_agg(to_jsonb(x)))->0, 'ids', to_jsonb((array_agg(to_jsonb(x)->>'id'))[1:50]))
    from viejos x group by 1;
  end if;
  return null;
end $$;

do $$
declare t record;
begin
  for t in select * from (values
      ('employees','empleados','empleado'), ('novelty_entries','novedades','novedad_dia'), ('novelty_totals','novedades','novedad_horas'),
      ('novelty_reports','novedades','plantilla'), ('shifts','turnos','horario'), ('shift_rotations','turnos','rotacion'),
      ('shift_assignments','turnos','asignacion'), ('shift_schedule','turnos','malla'), ('campaigns','campanas','campana'),
      ('cost_centers','centros_costo','centro_costo'), ('employers','empleadores','empleador'), ('holidays','festivos','festivo'),
      ('rules','reglas','regla'), ('devices','dispositivos','dispositivo')) v(tabla, modulo, entidad)
  loop
    execute format('drop trigger if exists auditar_ins on public.%I', t.tabla);
    execute format('drop trigger if exists auditar_upd on public.%I', t.tabla);
    execute format('drop trigger if exists auditar_del on public.%I', t.tabla);
    execute format('create trigger auditar_ins after insert on public.%I referencing new table as nuevos for each statement execute function public.auditar_ins(%L, %L)', t.tabla, t.modulo, t.entidad);
    execute format('create trigger auditar_upd after update on public.%I referencing old table as viejos new table as nuevos for each statement execute function public.auditar_upd(%L, %L)', t.tabla, t.modulo, t.entidad);
    execute format('create trigger auditar_del after delete on public.%I referencing old table as viejos for each statement execute function public.auditar_del(%L, %L)', t.tabla, t.modulo, t.entidad);
  end loop;
end $$;

/* ============================== 4. Comentarios y evidencias ============================== */
-- Quién ve la evidencia de una entidad (hoy: empleado → quien ve a la persona)
create or replace function public.evidencia_visible(_entidad text, _id text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_id uuid;
begin
  begin v_id := _id::uuid; exception when others then return false; end;
  if _entidad = 'empleado' then
    return exists (select 1 from public.employees e where e.id = v_id
                   and (public.is_super_admin() or e.tenant_id = public.current_tenant_id())
                   and (public.ve_toda_empresa() or e.id = any(public.my_employee_ids())));
  end if;
  return false;
end $$;
grant execute on function public.evidencia_visible(text, text) to authenticated;

create table if not exists public.employee_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  fecha date,
  contexto text not null default 'general' check (contexto in ('general','malla','novedad','asistencia','solicitud')),
  comentario text not null,
  archivos jsonb not null default '[]',
  user_id uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists employee_comments_emp on public.employee_comments (employee_id, fecha, created_at desc);
grant select on public.employee_comments to authenticated;
grant all on public.employee_comments to service_role;
alter table public.employee_comments enable row level security;
create policy "comentarios lectura" on public.employee_comments for select
  using (public.evidencia_visible('empleado', employee_id::text));

create or replace function public.comentar_empleado(_employee_id uuid, _comentario text, _archivos jsonb default '[]', _fecha date default null, _contexto text default 'general')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  e public.employees; v_id uuid; v_aprueba boolean; v_linea text; v_archivos jsonb := coalesce(_archivos, '[]');
begin
  select * into e from public.employees where id = _employee_id;
  if e.id is null or not public.evidencia_visible('empleado', _employee_id::text) then raise exception 'No tienes acceso a esta persona'; end if;
  if not (public.has_permission('empleados','ver') or public.has_permission('novedades','ver')
          or public.has_permission('turnos','ver') or public.has_permission('asistencia','ver')) then
    raise exception 'No tienes permiso para comentar';
  end if;
  if length(trim(coalesce(_comentario, ''))) < 2 and jsonb_array_length(v_archivos) = 0 then raise exception 'Escribe un comentario o adjunta un archivo'; end if;
  if jsonb_typeof(v_archivos) <> 'array' or jsonb_array_length(v_archivos) > 10 then raise exception 'Máximo 10 archivos por comentario'; end if;
  -- Los archivos deben estar en la carpeta de la persona dentro del bucket de evidencias
  if exists (select 1 from jsonb_array_elements(v_archivos) a
             where coalesce(a->>'path', '') not like e.tenant_id::text || '/empleado/' || e.id::text || '/%') then
    raise exception 'Archivo adjunto no válido';
  end if;

  insert into public.employee_comments (tenant_id, employee_id, fecha, contexto, comentario, archivos)
  values (e.tenant_id, e.id, _fecha, coalesce(_contexto, 'general'), coalesce(nullif(trim(_comentario), ''), '(evidencia adjunta)'), v_archivos)
  returning id into v_id;

  -- Nómina/Admin comentan → supervisores de la campaña; el supervisor comenta → quienes aprueban novedades
  v_aprueba := public.has_permission('empleados','aprobar') or public.has_permission('novedades','aprobar');
  v_linea := e.full_name || coalesce(' · ' || to_char(_fecha, 'DD/MM'), '') || ' — ' || left(coalesce(nullif(trim(_comentario), ''), 'evidencia adjunta'), 120)
             || case when jsonb_array_length(v_archivos) > 0 then ' (' || jsonb_array_length(v_archivos) || ' adjunto' || case when jsonb_array_length(v_archivos) > 1 then 's' else '' end || ')' else '' end;
  if v_aprueba then
    perform public._notificar_campana(e.tenant_id, e.campaign_id, 'evidencias', 'Comentarios y evidencias', array[v_linea], '/empleados');
  else
    perform public._notificar(e.tenant_id, public._usuarios_con_permiso(e.tenant_id, 'novedades', 'aprobar'),
      'evidencias', 'evidencias:supervisores', 'Comentarios y evidencias de supervisores', array[v_linea], '/empleados', e.campaign_id, null);
  end if;
  return v_id;
end $$;
grant execute on function public.comentar_empleado(uuid, text, jsonb, date, text) to authenticated;

-- Bucket privado de evidencias: <empresa>/empleado/<id del empleado>/<archivo>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidencias', 'evidencias', false, 15728640, array[
  'application/pdf','image/png','image/jpeg','image/webp','image/gif','image/heic','image/heif',
  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/plain','text/csv'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "evidencias lectura" on storage.objects;
drop policy if exists "evidencias subir" on storage.objects;
create policy "evidencias lectura" on storage.objects for select to authenticated
  using (bucket_id = 'evidencias' and (storage.foldername(name))[1] = public.current_tenant_id()::text
         and public.evidencia_visible((storage.foldername(name))[2], (storage.foldername(name))[3]));
-- Solo subir (sin editar ni borrar): la evidencia queda como se cargó
create policy "evidencias subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'evidencias' and (storage.foldername(name))[1] = public.current_tenant_id()::text
              and public.evidencia_visible((storage.foldername(name))[2], (storage.foldername(name))[3]));

/* ============================== 5. Adjuntos en solicitudes ============================== */
alter table public.employee_request_events add column if not exists archivos jsonb not null default '[]';

-- Nuevas firmas con adjuntos (se retiran las anteriores)
drop function if exists public.solicitar_ajuste_empleado(uuid[], text, text, jsonb);
drop function if exists public.resolver_solicitud_empleado(uuid[], text, text, jsonb);

create or replace function public.solicitar_ajuste_empleado(_empleados uuid[], _tipo text, _detalle text, _cambios jsonb default '{}', _archivos jsonb default '[]')
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_malos text; v_n int; v_lineas text[];
  v_etq text := case _tipo when 'activar' then 'Activar' when 'inactivar' then 'Inactivar'
                when 'cambio_campana' then 'Cambio de campaña' when 'actualizar_datos' then 'Actualizar datos' else 'Otro ajuste' end;
  v_cambios jsonb := coalesce(_cambios, '{}');
begin
  if not public.has_permission('empleados','ver') then raise exception 'No tienes acceso a empleados'; end if;
  if _tipo not in ('activar','inactivar','cambio_campana','actualizar_datos','otro') then raise exception 'Tipo de solicitud no válido'; end if;
  if length(trim(coalesce(_detalle,''))) < 5 then raise exception 'Explica el motivo de la solicitud'; end if;
  if cardinality(coalesce(_empleados,'{}')) = 0 then raise exception 'Selecciona al menos un empleado'; end if;
  if cardinality(_empleados) > 500 then raise exception 'Máximo 500 empleados por solicitud'; end if;

  -- Solo los cambios que se pueden aplicar al aprobar
  v_cambios := (select coalesce(jsonb_object_agg(k, v), '{}') from jsonb_each(v_cambios) x(k, v)
                where k in ('status','campaign_id','termination_date','hire_date','position','cost_center_id','email'));
  if _tipo = 'activar' then v_cambios := v_cambios || jsonb_build_object('status','activo','termination_date', null); end if;
  if _tipo = 'inactivar' then v_cambios := v_cambios || jsonb_build_object('status','inactivo'); end if;
  if _tipo = 'cambio_campana' and coalesce(v_cambios->>'campaign_id','') = '' then raise exception 'Indica la campaña destino'; end if;

  select string_agg(coalesce(e.full_name, x.id::text) || case
           when e.id is null or e.tenant_id <> v_tenant then ' (no existe)'
           when not (public.ve_toda_empresa() or e.id = any(public.my_employee_ids())) then ' (fuera de tu alcance)'
           when _tipo = 'activar' and e.status = 'activo' then ' (ya está activo)'
           when _tipo = 'inactivar' and e.status <> 'activo' then ' (ya está inactivo)'
           else ' (ya tiene una solicitud igual pendiente)' end, ', ')
    into v_malos
  from unnest(_empleados) x(id)
  left join public.employees e on e.id = x.id
  where e.id is null or e.tenant_id <> v_tenant
     or not (public.ve_toda_empresa() or e.id = any(public.my_employee_ids()))
     or (_tipo = 'activar' and e.status = 'activo')
     or (_tipo = 'inactivar' and e.status <> 'activo')
     or exists (select 1 from public.employee_requests r where r.employee_id = e.id and r.tipo = _tipo and r.estado = 'pendiente');
  if v_malos is not null then raise exception 'No se puede solicitar para: %', left(v_malos, 600); end if;

  with ins as (
    insert into public.employee_requests (tenant_id, employee_id, campaign_id, tipo, detalle, cambios)
    select v_tenant, e.id, e.campaign_id, _tipo, trim(_detalle), v_cambios
    from public.employees e where e.id = any(_empleados)
    returning id, employee_id
  ), ev as (
    insert into public.employee_request_events (tenant_id, request_id, tipo, comentario, archivos)
    select v_tenant, ins.id, 'creada', trim(_detalle),
           -- cada solicitud guarda los adjuntos que están en la carpeta de su empleado
           coalesce((select jsonb_agg(a) from jsonb_array_elements(coalesce(_archivos, '[]')) a
                     where a->>'path' like v_tenant::text || '/empleado/' || ins.employee_id::text || '/%'), '[]')
    from ins
    returning 1
  )
  select count(*), array_agg(v_etq || ': ' || e.full_name || coalesce(' · ' || c.name, '') order by e.full_name)
    into v_n, v_lineas
  from ins join public.employees e on e.id = ins.employee_id left join public.campaigns c on c.id = e.campaign_id;

  perform public._notificar(v_tenant, public._usuarios_con_permiso(v_tenant, 'empleados', 'aprobar'),
    'solicitud', 'solicitudes', 'Solicitudes de ajuste de empleados',
    array(select l || ' — ' || left(trim(_detalle), 120) from unnest(v_lineas) l), '/empleados?solicitudes=1', null, null);
  return v_n;
end $$;
grant execute on function public.solicitar_ajuste_empleado(uuid[], text, text, jsonb, jsonb) to authenticated;

create or replace function public.resolver_solicitud_empleado(_ids uuid[], _accion text, _comentario text default null, _cambios jsonb default null, _archivos jsonb default '[]')
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_aprueba boolean := public.has_permission('empleados','aprobar') or public.has_permission('empleados','editar');
  r public.employee_requests; c jsonb; v_n int := 0; v_nombre text;
  v_etq text; v_lineas_autor jsonb := '{}'; v_admin text[] := '{}'; k text;
begin
  if _accion not in ('aprobar','rechazar','comentar') then raise exception 'Acción no válida'; end if;
  if _accion in ('aprobar','rechazar') and not v_aprueba then raise exception 'Solo Nómina o Administración pueden resolver solicitudes'; end if;
  if _accion = 'rechazar' and length(trim(coalesce(_comentario,''))) < 3 then raise exception 'Escribe el motivo del rechazo'; end if;
  if _accion = 'comentar' and length(trim(coalesce(_comentario,''))) < 3 and jsonb_array_length(coalesce(_archivos, '[]')) = 0 then raise exception 'Escribe el comentario o adjunta un archivo'; end if;

  for r in select * from public.employee_requests where id = any(_ids) for update loop
    if not public.solicitud_visible(r.tenant_id, r.campaign_id, r.requested_by) then raise exception 'Sin acceso a una de las solicitudes'; end if;
    if _accion <> 'comentar' and r.estado <> 'pendiente' then continue; end if;
    select full_name into v_nombre from public.employees where id = r.employee_id;
    v_etq := case r.tipo when 'activar' then 'Activar' when 'inactivar' then 'Inactivar' when 'cambio_campana' then 'Cambio de campaña'
                         when 'actualizar_datos' then 'Actualizar datos' else 'Otro ajuste' end || ': ' || coalesce(v_nombre, '');

    if _accion = 'aprobar' then
      c := case when _cambios is null then r.cambios else r.cambios || _cambios end;
      update public.employees e set
        status = case when c ? 'status' then (c->>'status')::public.generic_status else e.status end,
        termination_date = case when c ? 'termination_date' then nullif(c->>'termination_date','')::date else e.termination_date end,
        hire_date = case when c ? 'hire_date' and coalesce(c->>'hire_date','') <> '' then (c->>'hire_date')::date else e.hire_date end,
        campaign_id = case when c ? 'campaign_id' and coalesce(c->>'campaign_id','') <> '' then (c->>'campaign_id')::uuid else e.campaign_id end,
        position = case when c ? 'position' and coalesce(c->>'position','') <> '' then c->>'position' else e.position end,
        cost_center_id = case when c ? 'cost_center_id' and coalesce(c->>'cost_center_id','') <> '' then (c->>'cost_center_id')::uuid else e.cost_center_id end,
        email = case when c ? 'email' and coalesce(c->>'email','') <> '' then c->>'email' else e.email end
      where e.id = r.employee_id;
      update public.employee_requests set estado = 'aprobada', cambios = c, respuesta = nullif(trim(_comentario),''),
             resolved_by = auth.uid(), resolved_at = now() where id = r.id;
      insert into public.audit_logs (tenant_id, user_id, module, action, record_id, new_value, reason)
      values (r.tenant_id, auth.uid(), 'empleados', 'aprobar_solicitud', r.employee_id::text, c, nullif(trim(_comentario),''));
    elsif _accion = 'rechazar' then
      update public.employee_requests set estado = 'rechazada', respuesta = trim(_comentario),
             resolved_by = auth.uid(), resolved_at = now() where id = r.id;
    end if;

    insert into public.employee_request_events (tenant_id, request_id, tipo, comentario, archivos)
    values (r.tenant_id, r.id, case _accion when 'aprobar' then 'aprobada' when 'rechazar' then 'rechazada' else 'comentario' end,
            nullif(trim(_comentario),''),
            coalesce((select jsonb_agg(a) from jsonb_array_elements(coalesce(_archivos, '[]')) a
                      where a->>'path' like r.tenant_id::text || '/empleado/' || r.employee_id::text || '/%'), '[]'));
    v_n := v_n + 1;

    -- Quien resuelve avisa al autor; si comenta el supervisor, avisa a Nómina/Admin
    if v_aprueba then
      if r.requested_by is not null then
        k := r.requested_by::text;
        v_lineas_autor := jsonb_set(v_lineas_autor, array[k], coalesce(v_lineas_autor->k, '[]') || to_jsonb(
          case _accion when 'aprobar' then 'Aprobada · ' when 'rechazar' then 'Rechazada · ' else 'Comentario · ' end
          || v_etq || coalesce(' — ' || left(trim(_comentario), 120), '')));
      end if;
    else
      v_admin := v_admin || (v_etq || ' — ' || left(trim(_comentario), 120));
    end if;
  end loop;

  for k in select jsonb_object_keys(v_lineas_autor) loop
    perform public._notificar(v_tenant, array[k::uuid], 'solicitud', 'solicitudes:respuestas', 'Respuesta a tus solicitudes de empleados',
      array(select jsonb_array_elements_text(v_lineas_autor->k)), '/empleados?solicitudes=1', null, null);
  end loop;
  if cardinality(v_admin) > 0 then
    perform public._notificar(v_tenant, public._usuarios_con_permiso(v_tenant, 'empleados', 'aprobar'),
      'solicitud', 'solicitudes', 'Solicitudes de ajuste de empleados', v_admin, '/empleados?solicitudes=1', null, null);
  end if;
  return v_n;
end $$;
grant execute on function public.resolver_solicitud_empleado(uuid[], text, text, jsonb, jsonb) to authenticated;
