-- Migración 0046: Turnos rotativos por campaña, solicitudes de ajuste de empleados y notificaciones
-- 1. Turnos (horarios) separados por campaña: admin/nómina/superadmin ven todo; supervisor y
--    coordinador ven y gestionan solo los de sus campañas asignadas. Sin campaña = turno general.
-- 2. Rotaciones: secuencia semanal de horarios (semana 1 → A, semana 2 → B, ...).
-- 3. Asignaciones por persona (horario fijo o rotación, con vigencia), solo a personal activo.
--    El motor de asistencia usa el turno programado del día (tardanzas, turnos nocturnos).
-- 4. Solicitudes de ajuste de empleado (activar, inactivar, cambio de campaña, datos):
--    el supervisor solicita y Nómina/Admin aprueban, rechazan o comentan.
-- 5. Notificaciones por rol: solicitudes → quienes aprueban empleados; cambios de personal y
--    revisión de novedades → supervisores/coordinadores de la campaña afectada.

/* ============================== Permisos ============================== */
insert into public.permissions (module, action, label)
values ('turnos', 'asignar', 'Asignar turnos al personal')
on conflict (module, action) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.module = 'turnos'
 and (p.action = 'asignar' and r.code in ('super_admin','admin','supervisor','coordinador')
      or p.action in ('crear','editar') and r.code in ('supervisor','coordinador'))
where not exists (select 1 from public.role_permissions x where x.role_id = r.id and x.permission_id = p.id);

/* ============================== Alcance por campaña ============================== */
create or replace function public.turno_campana_visible(_campaign uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.ve_toda_empresa() or _campaign is null or _campaign = any(public.my_campaign_ids());
$$;

-- Gestionar: administradores todo; supervisor/coordinador solo sus campañas (los generales no)
create or replace function public.turno_campana_gestionable(_campaign uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.ve_toda_empresa()
      or (_campaign is not null and public.my_scope() <> 'solo_yo' and _campaign = any(public.my_campaign_ids()));
$$;
grant execute on function public.turno_campana_visible(uuid), public.turno_campana_gestionable(uuid) to authenticated;

/* ============================== Turnos (horarios) ============================== */
alter table public.shifts
  add column if not exists campaign_id uuid references public.campaigns(id) on delete restrict,
  add column if not exists color text,
  add column if not exists created_by uuid references public.profiles(id) on delete set null default auth.uid();

-- El mismo código puede existir en campañas distintas (T1 de Tigo ≠ T1 de Claro)
alter table public.shifts drop constraint if exists shifts_tenant_id_code_key;
create unique index if not exists shifts_tenant_campana_codigo on public.shifts (tenant_id, campaign_id, code) nulls not distinct;
create index if not exists shifts_campaign_idx on public.shifts (campaign_id);

drop policy if exists "turnos lectura" on public.shifts;
drop policy if exists "turnos gestion (crear)" on public.shifts;
drop policy if exists "turnos gestion (editar)" on public.shifts;
drop policy if exists "turnos gestion (eliminar)" on public.shifts;
create policy "turnos lectura" on public.shifts for select
  using (public.tenant_visible(tenant_id) and public.turno_campana_visible(campaign_id));
create policy "turnos gestion (crear)" on public.shifts for insert
  with check (public.tenant_visible(tenant_id) and public.has_permission('turnos','crear') and public.turno_campana_gestionable(campaign_id));
create policy "turnos gestion (editar)" on public.shifts for update
  using (public.tenant_visible(tenant_id) and public.has_permission('turnos','editar') and public.turno_campana_gestionable(campaign_id))
  with check (public.tenant_visible(tenant_id) and public.turno_campana_gestionable(campaign_id));
create policy "turnos gestion (eliminar)" on public.shifts for delete
  using (public.tenant_visible(tenant_id) and public.has_permission('turnos','editar') and public.turno_campana_gestionable(campaign_id));

/* ============================== Rotaciones ============================== */
create table if not exists public.shift_rotations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete restrict,
  code text not null,
  name text not null,
  -- horario de cada semana del ciclo, en orden (semana 1, semana 2, ...)
  semanas uuid[] not null check (cardinality(semanas) between 1 and 12),
  status public.generic_status not null default 'activo',
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists shift_rotations_codigo on public.shift_rotations (tenant_id, campaign_id, code) nulls not distinct;
grant select, insert, update, delete on public.shift_rotations to authenticated;
grant all on public.shift_rotations to service_role;
alter table public.shift_rotations enable row level security;

create policy "rotaciones lectura" on public.shift_rotations for select
  using (public.tenant_visible(tenant_id) and public.turno_campana_visible(campaign_id));
create policy "rotaciones crear" on public.shift_rotations for insert
  with check (public.tenant_visible(tenant_id) and public.has_permission('turnos','crear') and public.turno_campana_gestionable(campaign_id));
create policy "rotaciones editar" on public.shift_rotations for update
  using (public.tenant_visible(tenant_id) and public.has_permission('turnos','editar') and public.turno_campana_gestionable(campaign_id))
  with check (public.tenant_visible(tenant_id) and public.turno_campana_gestionable(campaign_id));
create policy "rotaciones eliminar" on public.shift_rotations for delete
  using (public.tenant_visible(tenant_id) and public.has_permission('turnos','editar') and public.turno_campana_gestionable(campaign_id));

-- Cada semana debe ser un horario de la misma empresa y de la misma campaña (o general)
create or replace function public.validar_rotacion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_malo int;
begin
  select count(*) into v_malo
  from unnest(new.semanas) w(id)
  left join public.shifts s on s.id = w.id
  where s.id is null or s.tenant_id <> new.tenant_id
     or (s.campaign_id is not null and s.campaign_id is distinct from new.campaign_id);
  if v_malo > 0 then
    raise exception 'Cada semana de la rotación debe usar un horario de la misma campaña (o un horario general)';
  end if;
  return new;
end $$;
drop trigger if exists validar_rotacion on public.shift_rotations;
create trigger validar_rotacion before insert or update on public.shift_rotations
  for each row execute function public.validar_rotacion();

-- No borrar ni mover de campaña un horario que usa una rotación
create or replace function public.proteger_turno()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' or new.campaign_id is distinct from old.campaign_id then
    if exists (select 1 from public.shift_rotations r where old.id = any(r.semanas)
               and (tg_op = 'DELETE' or new.campaign_id is not null and r.campaign_id is distinct from new.campaign_id)) then
      raise exception 'El horario «%» está en una rotación; quítalo de la rotación primero', old.name;
    end if;
    if exists (select 1 from public.shift_assignments a where a.shift_id = old.id) and tg_op = 'UPDATE' then
      raise exception 'El horario «%» ya está asignado a personas; no se puede cambiar de campaña', old.name;
    end if;
  end if;
  return coalesce(new, old);
end $$;

/* ============================== Asignaciones ============================== */
create table if not exists public.shift_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  shift_id uuid references public.shifts(id) on delete restrict,
  rotation_id uuid references public.shift_rotations(id) on delete restrict,
  -- semana del ciclo con la que arranca la persona (para escalonar equipos en la misma rotación)
  semana_inicial integer not null default 1 check (semana_inicial between 1 and 12),
  start_date date not null,
  end_date date,
  nota text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check ((shift_id is null) <> (rotation_id is null)),
  check (end_date is null or end_date >= start_date)
);
create index if not exists shift_assignments_emp on public.shift_assignments (tenant_id, employee_id, start_date desc);
grant select on public.shift_assignments to authenticated;
grant all on public.shift_assignments to service_role;
alter table public.shift_assignments enable row level security;
create policy "asignaciones lectura" on public.shift_assignments for select
  using (((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
     and ((select public.ve_toda_empresa()) or array[employee_id] <@ (select public.my_employee_ids())));

drop trigger if exists proteger_turno on public.shifts;
create trigger proteger_turno before update or delete on public.shifts
  for each row execute function public.proteger_turno();

-- Turno programado por persona y fecha: gana la asignación vigente con inicio más reciente.
-- En una rotación, la semana se cuenta desde el lunes de la fecha de inicio.
create or replace function public._turnos_programados(_tenant uuid, _fechas date[], _empleados uuid[] default null)
returns table(employee_id uuid, fecha date, shift_id uuid, laborable boolean, assignment_id uuid, rotation_id uuid, semana integer)
language sql stable security definer set search_path = public as $$
  select distinct on (x.employee_id, x.fecha)
         x.employee_id, x.fecha, sh.id, extract(dow from x.fecha)::int = any(sh.workdays), x.id, x.rotation_id, x.semana
  from (
    select a.employee_id, f.fecha, a.id, a.start_date, a.created_at, a.rotation_id,
           case when r.id is null then null
                else ((((f.fecha - date_trunc('week', a.start_date)::date) / 7) + a.semana_inicial - 1) % cardinality(r.semanas)) + 1 end as semana,
           coalesce(a.shift_id, r.semanas[((((f.fecha - date_trunc('week', a.start_date)::date) / 7) + a.semana_inicial - 1) % cardinality(r.semanas)) + 1]) as turno
    from unnest(_fechas) f(fecha)
    join public.shift_assignments a
      on a.tenant_id = _tenant and a.start_date <= f.fecha and (a.end_date is null or a.end_date >= f.fecha)
     and (_empleados is null or a.employee_id = any(_empleados))
    left join public.shift_rotations r on r.id = a.rotation_id
  ) x
  join public.shifts sh on sh.id = x.turno
  order by x.employee_id, x.fecha, x.start_date desc, x.created_at desc;
$$;
revoke execute on function public._turnos_programados(uuid, date[], uuid[]) from public, anon, authenticated;
grant execute on function public._turnos_programados(uuid, date[], uuid[]) to service_role;

create or replace function public.turnos_programados(_fechas date[], _empleados uuid[] default null)
returns table(employee_id uuid, fecha date, shift_id uuid, laborable boolean, assignment_id uuid, rotation_id uuid, semana integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if cardinality(_fechas) > 93 then raise exception 'Máximo 93 fechas por consulta'; end if;
  return query
    select t.* from public._turnos_programados(public.current_tenant_id(), _fechas, _empleados) t
    where public.ve_toda_empresa() or t.employee_id = any(public.my_employee_ids());
end $$;
grant execute on function public.turnos_programados(date[], uuid[]) to authenticated;

-- Asignar un horario fijo o una rotación a varias personas activas
create or replace function public.asignar_turnos(
  _empleados uuid[], _shift uuid, _rotation uuid, _desde date, _hasta date default null,
  _semana_inicial integer default 1, _nota text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_campana uuid; v_tenant_obj uuid; v_ciclo int; v_malos text; v_n int;
begin
  if not public.has_permission('turnos','asignar') then raise exception 'No tienes permiso para asignar turnos'; end if;
  if (_shift is null) = (_rotation is null) then raise exception 'Elige un horario o una rotación'; end if;
  if _desde is null then raise exception 'Indica desde cuándo aplica'; end if;
  if _hasta is not null and _hasta < _desde then raise exception 'La fecha final es anterior a la inicial'; end if;
  if cardinality(coalesce(_empleados,'{}')) = 0 then raise exception 'Selecciona al menos una persona'; end if;

  if _shift is not null then
    select tenant_id, campaign_id into v_tenant_obj, v_campana from public.shifts where id = _shift and status = 'activo';
  else
    select tenant_id, campaign_id, cardinality(semanas) into v_tenant_obj, v_campana, v_ciclo
      from public.shift_rotations where id = _rotation and status = 'activo';
    if _semana_inicial < 1 or _semana_inicial > v_ciclo then raise exception 'La semana inicial debe estar entre 1 y %', v_ciclo; end if;
  end if;
  if v_tenant_obj is null or v_tenant_obj <> v_tenant then raise exception 'El horario o la rotación no existe o está inactivo'; end if;
  if not public.turno_campana_visible(v_campana) then raise exception 'Ese horario no es de tus campañas'; end if;

  -- Solo personal activo, visible para quien asigna y de la campaña del horario
  select string_agg(coalesce(e.full_name, x.id::text) || case
           when e.id is null or e.tenant_id <> v_tenant then ' (no existe)'
           when e.status <> 'activo' then ' (inactivo)'
           when not (public.ve_toda_empresa() or e.id = any(public.my_employee_ids())) then ' (fuera de tu alcance)'
           else ' (es de otra campaña)' end, ', ')
    into v_malos
  from unnest(_empleados) x(id)
  left join public.employees e on e.id = x.id
  where e.id is null or e.tenant_id <> v_tenant or e.status <> 'activo'
     or not (public.ve_toda_empresa() or e.id = any(public.my_employee_ids()))
     or (v_campana is not null and e.campaign_id is distinct from v_campana);
  if v_malos is not null then raise exception 'No se puede asignar a: %', left(v_malos, 600); end if;

  -- Una asignación sin fecha final reemplaza a las abiertas: se cierran el día anterior
  if _hasta is null then
    delete from public.shift_assignments
      where employee_id = any(_empleados) and end_date is null and start_date >= _desde;
    update public.shift_assignments set end_date = _desde - 1
      where employee_id = any(_empleados) and end_date is null and start_date < _desde;
  end if;

  insert into public.shift_assignments (tenant_id, employee_id, shift_id, rotation_id, semana_inicial, start_date, end_date, nota)
  select v_tenant, x.id, _shift, _rotation, coalesce(_semana_inicial, 1), _desde, _hasta, nullif(trim(_nota), '')
  from (select distinct unnest(_empleados) as id) x;
  get diagnostics v_n = row_count;

  insert into public.audit_logs (tenant_id, user_id, module, action, record_id, new_value)
  values (v_tenant, auth.uid(), 'turnos', 'asignar', coalesce(_shift, _rotation)::text,
          jsonb_build_object('empleados', v_n, 'shift_id', _shift, 'rotation_id', _rotation, 'desde', _desde, 'hasta', _hasta, 'semana_inicial', _semana_inicial));
  return v_n;
end $$;
grant execute on function public.asignar_turnos(uuid[], uuid, uuid, date, date, integer, text) to authenticated;

create or replace function public.quitar_asignacion_turno(_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a public.shift_assignments;
begin
  select * into a from public.shift_assignments where id = _id;
  if a.id is null then raise exception 'La asignación no existe'; end if;
  if not public.has_permission('turnos','asignar')
     or a.tenant_id <> public.current_tenant_id()
     or not (public.ve_toda_empresa() or a.employee_id = any(public.my_employee_ids())) then
    raise exception 'No puedes quitar esta asignación';
  end if;
  delete from public.shift_assignments where id = _id;
  insert into public.audit_logs (tenant_id, user_id, module, action, record_id, old_value)
  values (a.tenant_id, auth.uid(), 'turnos', 'quitar_asignacion', _id::text, to_jsonb(a));
end $$;
grant execute on function public.quitar_asignacion_turno(uuid) to authenticated;

/* ============================== Motor: turno programado del día ============================== */
-- Se parchea la definición vigente: el turno sale de la programación (si existe) y, si no,
-- del turno fijo del empleado o de la campaña. Una marca de madrugada se asigna al día anterior
-- cuando el turno de ese día cruza medianoche.
do $$
declare d text; viejo text; nuevo text;
begin
  d := pg_get_functiondef('public.recalcular_asistencia(uuid,date,date)'::regprocedure);
  viejo := $v$  with base as (
    select e.employee_id, emp.tenant_id, coalesce(emp.shift_id, c.shift_id) as shift_id,
           s.start_time, s.break_minutes, s.tolerance_in_minutes, e.event_at, e.is_duplicate,
           case when s.crosses_midnight and e.event_at::time < (s.end_time + make_interval(hours => v_ventana))
             then (e.event_at::date - 1) else e.event_at::date end as work_date
    from public.biometric_events e
    join public.employees emp on emp.id = e.employee_id
    left join public.campaigns c on c.id = emp.campaign_id
    left join public.shifts s on s.id = coalesce(emp.shift_id, c.shift_id)
    where e.tenant_id = _tenant and e.is_attendance
      and e.event_at::date between _desde - 1 and _hasta + 1
  ), agrupado as ($v$;
  nuevo := $v$  with prog as (
    select t.employee_id, t.fecha, t.shift_id, t.laborable
    from public._turnos_programados(_tenant, array(select generate_series(_desde - 2, _hasta + 1, interval '1 day')::date)) t
  ), ev as (
    select e.employee_id, emp.tenant_id, e.event_at, e.is_duplicate,
           -- con programación: el turno del día (ninguno si es su día de descanso); sin ella, el fijo
           case when pp.employee_id is not null then case when pp.laborable then pp.shift_id end
                else coalesce(emp.shift_id, c.shift_id) end as shift_prev,
           case when pc.employee_id is not null then case when pc.laborable then pc.shift_id end
                else coalesce(emp.shift_id, c.shift_id) end as shift_cur
    from public.biometric_events e
    join public.employees emp on emp.id = e.employee_id
    left join public.campaigns c on c.id = emp.campaign_id
    left join prog pp on pp.employee_id = e.employee_id and pp.fecha = e.event_at::date - 1
    left join prog pc on pc.employee_id = e.employee_id and pc.fecha = e.event_at::date
    where e.tenant_id = _tenant and e.is_attendance
      and e.event_at::date between _desde - 1 and _hasta + 1
  ), ev2 as (
    select ev.*, coalesce(sp.crosses_midnight and ev.event_at::time < (sp.end_time + make_interval(hours => v_ventana)), false) as noc
    from ev left join public.shifts sp on sp.id = ev.shift_prev
  ), base as (
    select ev2.employee_id, ev2.tenant_id, case when ev2.noc then ev2.shift_prev else ev2.shift_cur end as shift_id,
           s.start_time, s.break_minutes, s.tolerance_in_minutes, ev2.event_at, ev2.is_duplicate,
           case when ev2.noc then ev2.event_at::date - 1 else ev2.event_at::date end as work_date
    from ev2
    left join public.shifts s on s.id = case when ev2.noc then ev2.shift_prev else ev2.shift_cur end
  ), agrupado as ($v$;
  if position(viejo in d) = 0 then raise exception 'No se encontró el bloque base de recalcular_asistencia'; end if;
  execute replace(d, viejo, nuevo);
end $$;

/* ============================== Notificaciones ============================== */
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  tipo text not null,
  grupo text,
  titulo text not null,
  items text[] not null default '{}',
  contador integer not null default 1,
  enlace text,
  campaign_id uuid references public.campaigns(id) on delete set null,
  ref text,
  actor_id uuid references public.profiles(id) on delete set null,
  leida_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_usuario on public.notifications (user_id, created_at desc);
create index if not exists notifications_sin_leer on public.notifications (user_id) where leida_at is null;
grant select, delete on public.notifications to authenticated;
grant update (leida_at) on public.notifications to authenticated;
grant all on public.notifications to service_role;
alter table public.notifications enable row level security;
create policy "notificaciones propias" on public.notifications for select using (user_id = auth.uid());
create policy "notificaciones marcar" on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "notificaciones borrar" on public.notifications for delete using (user_id = auth.uid());

-- Quienes tienen un permiso en la empresa (p. ej. empleados.aprobar → Admin y Nómina)
create or replace function public._usuarios_con_permiso(_tenant uuid, _module text, _action text)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct p.id), '{}')
  from public.profiles p
  join public.user_roles ur on ur.user_id = p.id
  join public.roles r on r.id = ur.role_id
  where p.is_active
    and (r.code = 'super_admin' or (coalesce(ur.tenant_id, p.tenant_id) = _tenant and exists (
      select 1 from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
      where rp.role_id = ur.role_id and pm.module = _module and pm.action = _action)));
$$;

-- Supervisores y coordinadores asociados a alguna de las campañas
create or replace function public._responsables_campana(_tenant uuid, _campanas uuid[])
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct p.id), '{}')
  from public.profiles p
  join public.user_roles ur on ur.user_id = p.id
  join public.roles r on r.id = ur.role_id
  where p.is_active and r.code in ('supervisor','coordinador')
    and coalesce(ur.tenant_id, p.tenant_id) = _tenant
    and (coalesce(ur.campaign_ids,'{}') && _campanas
         or exists (select 1 from public.campaign_responsibles cr where cr.user_id = p.id and cr.campaign_id = any(_campanas)));
$$;

-- Crea (o agrupa) la notificación para cada destinatario, sin notificar a quien hizo el cambio.
-- Cambios seguidos del mismo grupo en 30 min se suman a la misma notificación sin leer.
create or replace function public._notificar(
  _tenant uuid, _usuarios uuid[], _tipo text, _grupo text, _titulo text, _items text[],
  _enlace text default null, _campaign uuid default null, _ref text default null)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid; v_id uuid; v_items text[] := coalesce(_items, '{}');
begin
  if cardinality(v_items) = 0 then return; end if;
  foreach u in array coalesce(_usuarios, '{}') loop
    continue when u is null or u = auth.uid();
    v_id := null;
    if _grupo is not null then
      select id into v_id from public.notifications
       where user_id = u and grupo = _grupo and leida_at is null and created_at > now() - interval '30 minutes'
       order by created_at desc limit 1;
    end if;
    if v_id is not null then
      update public.notifications
         set items = (v_items || items)[1:50], contador = contador + cardinality(v_items), titulo = _titulo,
             actor_id = auth.uid(), created_at = now()
       where id = v_id;
    else
      insert into public.notifications (tenant_id, user_id, tipo, grupo, titulo, items, contador, enlace, campaign_id, ref, actor_id)
      values (_tenant, u, _tipo, _grupo, _titulo, v_items[1:50], cardinality(v_items), _enlace, _campaign, _ref, auth.uid());
    end if;
  end loop;
end $$;
revoke execute on function public._usuarios_con_permiso(uuid,text,text), public._responsables_campana(uuid,uuid[]),
  public._notificar(uuid,uuid[],text,text,text,text[],text,uuid,text) from public, anon, authenticated;

create or replace function public.marcar_notificaciones_leidas(_ids uuid[] default null)
returns integer language sql security definer set search_path = public as $$
  with u as (
    update public.notifications set leida_at = now()
     where user_id = auth.uid() and leida_at is null and (_ids is null or id = any(_ids))
    returning 1)
  select count(*)::int from u;
$$;
grant execute on function public.marcar_notificaciones_leidas(uuid[]) to authenticated;

-- Notifica a los supervisores/coordinadores de una campaña (agrupado por tipo y campaña)
create or replace function public._notificar_campana(_tenant uuid, _campana uuid, _tipo text, _titulo text, _items text[], _enlace text)
returns void language plpgsql security definer set search_path = public as $$
declare v_nombre text;
begin
  if _campana is null then return; end if;
  select name into v_nombre from public.campaigns where id = _campana;
  perform public._notificar(_tenant, public._responsables_campana(_tenant, array[_campana]), _tipo,
    _tipo || ':' || _campana, _titulo || ' · ' || coalesce(v_nombre, 'campaña'), _items, _enlace, _campana, null);
end $$;
revoke execute on function public._notificar_campana(uuid,uuid,text,text,text[],text) from public, anon, authenticated;

/* ---------- Cambios de personal → supervisores/coordinadores de la campaña ---------- */
create or replace function public.notificar_empleados_ins()
returns trigger language plpgsql security definer set search_path = public as $$
declare g record;
begin
  for g in
    select n.tenant_id, n.campaign_id, array_agg('Nuevo empleado: ' || n.full_name || ' (' || n.document || ')' order by n.full_name) as lineas
    from nuevos n where n.campaign_id is not null
    group by n.tenant_id, n.campaign_id
  loop
    perform public._notificar_campana(g.tenant_id, g.campaign_id, 'personal', 'Cambios de personal', g.lineas, '/empleados');
  end loop;
  return null;
end $$;

create or replace function public.notificar_empleados_upd()
returns trigger language plpgsql security definer set search_path = public as $$
declare g record;
begin
  for g in
    with cambios as (
      select n.tenant_id, n.campaign_id as campana,
             case when n.status = 'activo' then 'Activado: ' else 'Inactivado: ' end || n.full_name as linea
      from nuevos n join viejos o on o.id = n.id
      where n.status is distinct from o.status and n.campaign_id is not null
      union all
      -- cambio de campaña: avisa a la campaña que recibe y a la que entrega
      select n.tenant_id, n.campaign_id,
             'Ingresó a la campaña: ' || n.full_name || coalesce(' (venía de ' || co.name || ')', '')
      from nuevos n join viejos o on o.id = n.id left join public.campaigns co on co.id = o.campaign_id
      where n.campaign_id is distinct from o.campaign_id and n.campaign_id is not null
      union all
      select o.tenant_id, o.campaign_id,
             'Salió de la campaña: ' || n.full_name || coalesce(' (pasa a ' || cn.name || ')', '')
      from nuevos n join viejos o on o.id = n.id left join public.campaigns cn on cn.id = n.campaign_id
      where n.campaign_id is distinct from o.campaign_id and o.campaign_id is not null
      union all
      select n.tenant_id, n.campaign_id, 'Datos actualizados: ' || n.full_name || ' (' || array_to_string(array_remove(array[
               case when n.full_name is distinct from o.full_name then 'nombre' end,
               case when n.position is distinct from o.position then 'cargo' end,
               case when n.hire_date is distinct from o.hire_date then 'fecha de ingreso' end,
               case when n.termination_date is distinct from o.termination_date then 'fecha de retiro' end,
               case when n.cost_center_id is distinct from o.cost_center_id then 'centro de costo' end,
               case when n.employer_id is distinct from o.employer_id then 'empleador' end,
               case when n.shift_id is distinct from o.shift_id then 'turno fijo' end], null), ', ') || ')'
      from nuevos n join viejos o on o.id = n.id
      where n.campaign_id is not null and n.campaign_id is not distinct from o.campaign_id
        and n.status is not distinct from o.status
        and (n.full_name, n.position, n.hire_date, n.termination_date, n.cost_center_id, n.employer_id, n.shift_id)
            is distinct from (o.full_name, o.position, o.hire_date, o.termination_date, o.cost_center_id, o.employer_id, o.shift_id)
    )
    select tenant_id, campana, array_agg(linea order by linea) as lineas from cambios group by tenant_id, campana
  loop
    perform public._notificar_campana(g.tenant_id, g.campana, 'personal', 'Cambios de personal', g.lineas, '/empleados');
  end loop;
  return null;
end $$;

-- Un trigger por evento (las tablas de transición no admiten varios eventos)
drop trigger if exists notificar_empleados_ins on public.employees;
drop trigger if exists notificar_empleados_upd on public.employees;
create trigger notificar_empleados_ins after insert on public.employees
  referencing new table as nuevos for each statement execute function public.notificar_empleados_ins();
create trigger notificar_empleados_upd after update on public.employees
  referencing old table as viejos new table as nuevos for each statement execute function public.notificar_empleados_upd();

/* ---------- Revisión de novedades ---------- */
-- Nómina/Admin revisan → supervisores de la campaña; el supervisor responde o reporta → quienes aprueban
create or replace function public.notificar_revision_novedades()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  g record;
  v_aprueba boolean := public.has_permission('novedades','aprobar');
begin
  if v_aprueba then
    for g in
      select n.tenant_id, e.campaign_id, array_agg(
               case n.tipo when 'aprobado' then 'Aprobada: ' when 'observado' then 'Observada: '
                           when 'rechazado' then 'Rechazada: ' when 'pendiente' then 'Reabierta: '
                           when 'horas' then 'Horas ajustadas: ' else 'Comentario: ' end
               || coalesce(e.full_name, n.document)
               || coalesce(' (' || to_char(t.period_start, 'DD/MM') || '–' || to_char(t.period_end, 'DD/MM') || ')', '')
               || coalesce(' — ' || left(n.comentario, 120), '') order by e.full_name) as lineas
      from nuevos n
      left join public.novelty_totals t on t.id = n.total_id
      left join public.employees e on e.tenant_id = n.tenant_id and e.document = n.document
      where e.campaign_id is not null and n.tipo <> 'respondido'
      group by n.tenant_id, e.campaign_id
    loop
      perform public._notificar_campana(g.tenant_id, g.campaign_id, 'novedades', 'Novedades revisadas', g.lineas, '/novedades');
    end loop;
  else
    for g in
      select n.tenant_id, array_agg(
               case n.tipo when 'respondido' then 'Respondió (2ª revisión): ' when 'horas' then 'Horas reportadas: '
                           else 'Comentario: ' end
               || coalesce(e.full_name, n.document) || coalesce(' · ' || c.name, '')
               || coalesce(' — ' || left(n.comentario, 120), '') order by e.full_name) as lineas
      from nuevos n
      left join public.employees e on e.tenant_id = n.tenant_id and e.document = n.document
      left join public.campaigns c on c.id = e.campaign_id
      group by n.tenant_id
    loop
      perform public._notificar(g.tenant_id, public._usuarios_con_permiso(g.tenant_id, 'novedades', 'aprobar'),
        'novedades', 'novedades:supervisores', 'Novedades de supervisores por revisar', g.lineas, '/novedades', null, null);
    end loop;
  end if;
  return null;
end $$;
drop trigger if exists notificar_revision_novedades on public.novelty_review_events;
create trigger notificar_revision_novedades after insert on public.novelty_review_events
  referencing new table as nuevos for each statement execute function public.notificar_revision_novedades();

-- Novedades por día: aprobación/rechazo de manuales → supervisores; registros de supervisores → Nómina
create or replace function public.notificar_novedades_dia_upd()
returns trigger language plpgsql security definer set search_path = public as $$
declare g record;
begin
  for g in
    select n.tenant_id, e.campaign_id, array_agg(
             case when n.status = 'aprobada' then 'Aprobada: ' else 'Rechazada: ' end
             || coalesce(e.full_name, n.document) || ' · ' || n.novelty_type || ' ' || to_char(n.work_date, 'DD/MM')
             order by e.full_name, n.work_date) as lineas
    from nuevos n join viejos o on o.id = n.id
    left join public.employees e on e.tenant_id = n.tenant_id and e.document = n.document
    where n.status is distinct from o.status and n.status in ('aprobada','rechazada') and e.campaign_id is not null
    group by n.tenant_id, e.campaign_id
  loop
    perform public._notificar_campana(g.tenant_id, g.campaign_id, 'novedades', 'Novedades revisadas', g.lineas, '/novedades');
  end loop;
  return null;
end $$;

create or replace function public.notificar_novedades_dia_ins()
returns trigger language plpgsql security definer set search_path = public as $$
declare g record;
begin
  if public.has_permission('novedades','aprobar') then return null; end if;
  for g in
    select n.tenant_id, count(*) as total, count(distinct n.document) as personas,
           string_agg(distinct c.name, ', ') as campanas
    from nuevos n
    left join public.employees e on e.tenant_id = n.tenant_id and e.document = n.document
    left join public.campaigns c on c.id = e.campaign_id
    group by n.tenant_id
  loop
    perform public._notificar(g.tenant_id, public._usuarios_con_permiso(g.tenant_id, 'novedades', 'aprobar'),
      'novedades', 'novedades:supervisores', 'Novedades de supervisores por revisar',
      array[g.total || case when g.total = 1 then ' novedad de ' else ' novedades de ' end
            || g.personas || case when g.personas = 1 then ' persona' else ' personas' end || coalesce(' · ' || g.campanas, '')],
      '/novedades', null, null);
  end loop;
  return null;
end $$;

drop trigger if exists notificar_novedades_dia_upd on public.novelty_entries;
drop trigger if exists notificar_novedades_dia_ins on public.novelty_entries;
create trigger notificar_novedades_dia_upd after update on public.novelty_entries
  referencing old table as viejos new table as nuevos for each statement execute function public.notificar_novedades_dia_upd();
create trigger notificar_novedades_dia_ins after insert on public.novelty_entries
  referencing new table as nuevos for each statement execute function public.notificar_novedades_dia_ins();

/* ============================== Solicitudes de ajuste de empleados ============================== */
create table if not exists public.employee_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  tipo text not null check (tipo in ('activar','inactivar','cambio_campana','actualizar_datos','otro')),
  detalle text not null,
  cambios jsonb not null default '{}',
  estado text not null default 'pendiente' check (estado in ('pendiente','aprobada','rechazada')),
  respuesta text,
  requested_by uuid references public.profiles(id) on delete set null default auth.uid(),
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists employee_requests_estado on public.employee_requests (tenant_id, estado, created_at desc);
create index if not exists employee_requests_emp on public.employee_requests (employee_id);

create table if not exists public.employee_request_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  request_id uuid not null references public.employee_requests(id) on delete cascade,
  tipo text not null check (tipo in ('creada','comentario','aprobada','rechazada')),
  comentario text,
  user_id uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists employee_request_events_req on public.employee_request_events (request_id, created_at);

grant select on public.employee_requests, public.employee_request_events to authenticated;
grant all on public.employee_requests, public.employee_request_events to service_role;
alter table public.employee_requests enable row level security;
alter table public.employee_request_events enable row level security;

-- Ve una solicitud: quien aprueba empleados, quien la creó o los responsables de su campaña
create or replace function public.solicitud_visible(_tenant uuid, _campaign uuid, _autor uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select (public.is_super_admin() or _tenant = public.current_tenant_id())
     and (public.has_permission('empleados','aprobar') or public.has_permission('empleados','editar')
          or _autor = auth.uid()
          or (public.my_scope() <> 'solo_yo' and _campaign = any(public.my_campaign_ids())));
$$;
grant execute on function public.solicitud_visible(uuid,uuid,uuid) to authenticated;

create policy "solicitudes lectura" on public.employee_requests for select
  using (public.solicitud_visible(tenant_id, campaign_id, requested_by));
create policy "solicitudes historial" on public.employee_request_events for select
  using (exists (select 1 from public.employee_requests r where r.id = request_id
                 and public.solicitud_visible(r.tenant_id, r.campaign_id, r.requested_by)));

create or replace function public.solicitar_ajuste_empleado(_empleados uuid[], _tipo text, _detalle text, _cambios jsonb default '{}')
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
    insert into public.employee_request_events (tenant_id, request_id, tipo, comentario)
    select v_tenant, id, 'creada', trim(_detalle) from ins
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
grant execute on function public.solicitar_ajuste_empleado(uuid[], text, text, jsonb) to authenticated;

-- Aprobar (aplica el cambio), rechazar o comentar solicitudes
create or replace function public.resolver_solicitud_empleado(_ids uuid[], _accion text, _comentario text default null, _cambios jsonb default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_aprueba boolean := public.has_permission('empleados','aprobar') or public.has_permission('empleados','editar');
  r public.employee_requests; c jsonb; v_n int := 0; v_nombre text;
  v_etq text; v_lineas_autor jsonb := '{}'; v_admin text[] := '{}'; k text;
begin
  if _accion not in ('aprobar','rechazar','comentar') then raise exception 'Acción no válida'; end if;
  if _accion in ('aprobar','rechazar') and not v_aprueba then raise exception 'Solo Nómina o Administración pueden resolver solicitudes'; end if;
  if _accion in ('rechazar','comentar') and length(trim(coalesce(_comentario,''))) < 3 then raise exception 'Escribe el comentario'; end if;

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

    insert into public.employee_request_events (tenant_id, request_id, tipo, comentario)
    values (r.tenant_id, r.id, case _accion when 'aprobar' then 'aprobada' when 'rechazar' then 'rechazada' else 'comentario' end,
            nullif(trim(_comentario),''));
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
grant execute on function public.resolver_solicitud_empleado(uuid[], text, text, jsonb) to authenticated;

/* ============================== Endurecer inserciones ============================== */
-- Crear empleados exigía solo pertenecer a la empresa: ahora pide permiso de crear, editar o importar
drop policy if exists "empleados gestion (crear)" on public.employees;
create policy "empleados gestion (crear)" on public.employees for insert
  with check (public.tenant_visible(tenant_id)
              and (public.has_permission('empleados','crear') or public.has_permission('empleados','editar') or public.has_permission('empleados','importar')));
