-- Migración 0067: Avisos emergentes de turno para la persona
-- 1. Cuando pasa el tiempo máximo del turno (o las horas extra autorizadas), a los X minutos (5 por defecto)
--    el sistema le envía a la persona una ventana emergente («Finaliza tu turno») y la repite cada Y minutos
--    (10 por defecto) hasta que finalice. Lo hace el vigilante del servidor cada minuto.
-- 2. El aviso «Finalizar turno» que envía Nómina o el supervisor también le llega como ventana emergente,
--    con su mensaje.
-- 3. Aviso masivo: avisar_turnos(_sesiones, _mensaje) envía el aviso a varios turnos a la vez.
-- Al finalizar o cerrarse el turno, sus avisos emergentes pendientes se dan por leídos.

alter table public.notifications
  add column if not exists emergente boolean not null default false,
  add column if not exists session_id uuid references public.work_sessions(id) on delete cascade,
  add column if not exists confirmada_at timestamptz;
create index if not exists notifications_emergentes on public.notifications (user_id) where emergente and leida_at is null;

alter table public.shift_policies
  add column if not exists aviso_empleado_activo boolean not null default true,
  add column if not exists aviso_empleado_min integer not null default 5,
  add column if not exists aviso_empleado_repetir_min integer not null default 10;
alter table public.shift_policies drop constraint if exists shift_policies_aviso_empleado_chk;
alter table public.shift_policies add constraint shift_policies_aviso_empleado_chk
  check (aviso_empleado_min between 0 and 600 and aviso_empleado_repetir_min between 1 and 600);

alter table public.work_sessions
  add column if not exists ultimo_aviso_empleado_at timestamptz,
  add column if not exists avisos_empleado integer not null default 0;

-- Crea o reactiva el aviso emergente de un turno: uno por turno y tipo; si ya existe, vuelve a quedar
-- sin leer (así reaparece) con el mensaje nuevo y suma una repetición.
create or replace function public._aviso_emergente(
  _tenant uuid, _usuario uuid, _sesion uuid, _tipo text, _titulo text, _mensaje text, _actor uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if _usuario is null then return null; end if;
  select id into v_id from notifications
   where user_id = _usuario and session_id = _sesion and emergente and grupo = 'emergente:' || _tipo
   order by created_at desc limit 1;
  if v_id is not null then
    update notifications set titulo = _titulo, items = array[_mensaje], contador = contador + 1, actor_id = _actor,
           leida_at = null, confirmada_at = null, created_at = now()
    where id = v_id;
  else
    insert into notifications (tenant_id, user_id, tipo, grupo, titulo, items, contador, enlace, ref, actor_id, emergente, session_id)
    values (_tenant, _usuario, 'turnos', 'emergente:' || _tipo, _titulo, array[_mensaje], 1, null, _tipo, _actor, true, _sesion)
    returning id into v_id;
  end if;
  return v_id;
end $$;
revoke execute on function public._aviso_emergente(uuid, uuid, uuid, text, text, text, uuid) from public, anon, authenticated;

-- La persona confirma («Entendido») sus avisos emergentes
create or replace function public.confirmar_avisos_emergentes(_ids uuid[])
returns integer language sql security definer set search_path = public as $$
  with u as (
    update public.notifications set leida_at = coalesce(leida_at, now()), confirmada_at = now()
     where user_id = auth.uid() and emergente and id = any(_ids)
    returning 1)
  select count(*)::int from u;
$$;
grant execute on function public.confirmar_avisos_emergentes(uuid[]) to authenticated;

-- Al terminar el turno (por la persona, el supervisor o el cierre automático) se apagan sus avisos
create or replace function public._apagar_avisos_turno() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update notifications set leida_at = coalesce(leida_at, now())
  where session_id = new.id and emergente and leida_at is null;
  return new;
end $$;
drop trigger if exists work_sessions_apagar_avisos on public.work_sessions;
create trigger work_sessions_apagar_avisos after update of ended_at on public.work_sessions
  for each row when (old.ended_at is null and new.ended_at is not null) execute function public._apagar_avisos_turno();

CREATE OR REPLACE FUNCTION public.revisar_alarmas_turno()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; n integer := 0; v_limite timestamptz; v_limite_emp timestamptz; v_tipo text; v_horas numeric; v_ult timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not (public.has_permission('inicio_turno', 'ver') or public.has_permission('registro_turnos', 'ver')) then
    raise exception 'Sin permiso';
  end if;
  for r in
    select w.*, coalesce(p.max_horas, 8) as max_horas, coalesce(p.tolerancia_min, 0) as tolerancia_min,
           coalesce(p.recordatorio_min, 30) as recordatorio_min, coalesce(p.alarmas_activas, true) as alarmas_activas,
           coalesce(p.alertar_roles, '{supervisor,coordinador}') as roles,
           coalesce(p.aviso_empleado_activo, true) as aviso_emp, coalesce(p.aviso_empleado_min, 5) as aviso_emp_min,
           coalesce(p.aviso_empleado_repetir_min, 10) as aviso_emp_rep
    from work_sessions w left join shift_policies p on p.id = (select coalesce(w.policy_id, (public._politica_turno(w.tenant_id, w.employee_id)).id))
    where w.ended_at is null
      and (auth.role() = 'service_role' or w.tenant_id = public.current_tenant_id())
  loop
    -- Un solo proceso a la vez por turno (vigilante del servidor y tableros abiertos)
    perform pg_advisory_xact_lock(hashtext('aviso_turno:' || r.id::text));
    v_horas := round(extract(epoch from now() - r.started_at)::numeric / 3600, 1);

    -- 1. Ventana emergente para la persona: X min después del tiempo máximo (o de la extra autorizada)
    v_limite_emp := coalesce(r.extra_autorizada_hasta, r.started_at + make_interval(mins => (r.max_horas * 60)::int))
                    + make_interval(mins => r.aviso_emp_min);
    select ultimo_aviso_empleado_at into v_ult from work_sessions where id = r.id and ended_at is null;
    if found and r.aviso_emp and r.user_id is not null and now() > v_limite_emp
       and (v_ult is null or v_ult <= now() - make_interval(mins => r.aviso_emp_rep)) then
      perform public._aviso_emergente(r.tenant_id, r.user_id, r.id, 'tiempo_excedido',
        case when r.extra_autorizada_hasta is not null then 'Terminó tu tiempo extra autorizado' else 'Tu turno ya terminó' end,
        case when r.extra_autorizada_hasta is not null
             then format('Tus horas extra autorizadas terminaron a las %s y llevas %s h en turno. Finaliza tu turno ahora desde el botón «Finalizar».',
                         to_char(r.extra_autorizada_hasta at time zone 'America/Bogota', 'HH24:MI'), v_horas)
             else format('Llevas %s h en turno y el máximo es %s h. Finaliza tu turno ahora desde el botón «Finalizar». Si debes seguir, pide a tu supervisor que autorice horas extra.',
                         v_horas, r.max_horas) end,
        null);
      update work_sessions set ultimo_aviso_empleado_at = now(), avisos_empleado = avisos_empleado + 1 where id = r.id;
      n := n + 1;
    end if;

    -- 2. Alarma a los roles de la regla (supervisor, coordinador…): después de la tolerancia
    continue when not r.alarmas_activas;
    v_limite := coalesce(r.extra_autorizada_hasta,
                         r.started_at + make_interval(mins => (r.max_horas * 60)::int + r.tolerancia_min));
    continue when now() <= v_limite;
    select ultimo_aviso_at into v_ult from work_sessions where id = r.id;
    continue when v_ult is not null and v_ult > now() - make_interval(mins => r.recordatorio_min);
    v_tipo := case when r.extra_autorizada_hasta is not null then 'extra_excedida' else 'turno_excedido' end;
    perform public._alarma_turno(r.tenant_id, r.id, r.user_id, r.employee_id, v_tipo, 'alta',
      case when v_tipo = 'extra_excedida'
           then format('Pasó las horas extra autorizadas (hasta %s) y no ha finalizado: lleva %s h', to_char(r.extra_autorizada_hasta at time zone 'America/Bogota', 'HH24:MI'), v_horas)
           else format('No ha finalizado el turno: lleva %s h (máximo %s h)', v_horas, r.max_horas) end,
      jsonb_build_object('horas', v_horas, 'limite', v_limite), r.roles, 'abierta');
    update work_sessions set ultimo_aviso_at = now(), avisos = avisos + 1 where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $function$;

CREATE OR REPLACE FUNCTION public.gestionar_turno(_sesion uuid, _accion text, _horas numeric DEFAULT NULL::numeric, _motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.work_sessions; v_pol public.shift_policies; v_desde timestamptz; v_nombre text; v_msg text;
begin
  if not public.has_permission('inicio_turno', 'gestionar') then raise exception 'No tienes permiso para gestionar turnos'; end if;
  select * into v from work_sessions where id = _sesion for update;
  if v.id is null or not public.tenant_visible(v.tenant_id)
     or not (public.ve_toda_empresa() or v.employee_id = any(public.my_employee_ids())) then
    raise exception 'Turno no encontrado';
  end if;
  if v.ended_at is not null then raise exception 'El turno ya fue finalizado'; end if;
  select * into v_pol from shift_policies where id = coalesce(v.policy_id, (public._politica_turno(v.tenant_id, v.employee_id)).id);
  select coalesce(full_name, email) into v_nombre from profiles where id = auth.uid();

  if _accion = 'avisar' then
    v_msg := coalesce(nullif(trim(_motivo), ''), 'Finaliza tu turno ahora desde el botón «Finalizar».');
    -- Ventana emergente a la persona con el mensaje (y queda en su campana de notificaciones)
    perform public._aviso_emergente(v.tenant_id, v.user_id, v.id, 'aviso_finalizar',
      'Te piden finalizar el turno', v_msg || ' — ' || coalesce(v_nombre, 'Supervisión'), auth.uid());
    perform public._alarma_turno(v.tenant_id, v.id, v.user_id, v.employee_id, 'aviso_finalizar', 'info',
      'Se pidió finalizar el turno' || coalesce(': ' || nullif(trim(_motivo), ''), ''), jsonb_build_object('por', v_nombre), '{}', 'informativa');
    update work_sessions set avisos_empleado = avisos_empleado + 1 where id = v.id;

  elsif _accion = 'autorizar_extra' then
    if _horas is null or _horas < 0.25 or _horas > 8 then raise exception 'Indica entre 0,25 y 8 horas extra'; end if;
    v_desde := greatest(now(), coalesce(v.extra_autorizada_hasta,
                 v.started_at + make_interval(mins => (coalesce(v_pol.max_horas, 8) * 60)::int + coalesce(v_pol.tolerancia_min, 0))));
    update work_sessions set extra_autorizada_hasta = v_desde + make_interval(mins => (_horas * 60)::int),
           extra_autorizada_horas = coalesce(extra_autorizada_horas, 0) + _horas, ultimo_aviso_at = null,
           ultimo_aviso_empleado_at = null
    where id = v.id returning * into v;
    update shift_alerts set estado = 'atendida', atendida_at = now(), atendida_por = auth.uid()
    where session_id = v.id and estado = 'abierta' and tipo in ('turno_excedido', 'extra_excedida');
    -- Los avisos emergentes pendientes de «tiempo excedido» ya no aplican
    update notifications set leida_at = coalesce(leida_at, now())
    where session_id = v.id and emergente and leida_at is null;
    perform public._alarma_turno(v.tenant_id, v.id, v.user_id, v.employee_id, 'extra_autorizada', 'info',
      format('Se autorizaron %s h extra hasta las %s', _horas, to_char(v.extra_autorizada_hasta at time zone 'America/Bogota', 'HH24:MI'))
        || coalesce('. Motivo: ' || nullif(trim(_motivo), ''), ''),
      jsonb_build_object('horas', _horas, 'hasta', v.extra_autorizada_hasta, 'por', v_nombre), '{}', 'informativa');
    perform public._notificar(v.tenant_id, array[v.user_id], 'turnos', null, 'Horas extra autorizadas',
      array[format('Puedes seguir hasta las %s (%s h extra).', to_char(v.extra_autorizada_hasta at time zone 'America/Bogota', 'HH24:MI'), _horas)], null, null, null);

  elsif _accion = 'cerrar' then
    if coalesce(length(trim(_motivo)), 0) < 5 then raise exception 'Escribe el motivo del cierre autorizado'; end if;
    update work_sessions set ended_at = now(), cierre = 'autorizado', cerrado_por = auth.uid(), motivo_cierre = trim(_motivo)
    where id = v.id returning * into v;
    update shift_alerts set estado = 'atendida', atendida_at = now(), atendida_por = auth.uid()
    where session_id = v.id and estado = 'abierta';
    perform public._alarma_turno(v.tenant_id, v.id, v.user_id, v.employee_id, 'cierre_autorizado', 'info',
      'Turno cerrado por ' || coalesce(v_nombre, 'el supervisor') || ': ' || trim(_motivo), jsonb_build_object('por', v_nombre), '{}', 'informativa');
    perform public._notificar(v.tenant_id, array[v.user_id], 'turnos', null, 'Tu turno fue cerrado por tu supervisor',
      array[trim(_motivo)], null, null, null);
  else
    raise exception 'Acción no válida';
  end if;

  insert into audit_logs (tenant_id, user_id, module, action, record_id, new_value, reason)
  values (v.tenant_id, auth.uid(), 'inicio_turno', _accion, v.id::text, jsonb_build_object('horas', _horas), nullif(trim(_motivo), ''));
  return jsonb_build_object('ok', true);
end $function$;

-- Aviso masivo «Finalizar turno»: envía el aviso emergente a cada turno abierto que el usuario puede
-- gestionar. Devuelve cuántos se enviaron y cuáles se omitieron (finalizados o fuera de su alcance).
create or replace function public.avisar_turnos(_sesiones uuid[], _mensaje text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s uuid; n integer := 0; omitidos integer := 0;
begin
  if not public.has_permission('inicio_turno', 'gestionar') then raise exception 'No tienes permiso para gestionar turnos'; end if;
  if cardinality(coalesce(_sesiones, '{}')) = 0 then raise exception 'Selecciona al menos un turno'; end if;
  if cardinality(_sesiones) > 500 then raise exception 'Máximo 500 turnos por envío'; end if;
  foreach s in array _sesiones loop
    begin
      perform public.gestionar_turno(s, 'avisar', null, _mensaje);
      n := n + 1;
    exception when others then
      omitidos := omitidos + 1;
    end;
  end loop;
  return jsonb_build_object('ok', true, 'enviados', n, 'omitidos', omitidos);
end $$;
grant execute on function public.avisar_turnos(uuid[], text) to authenticated;

notify pgrst, 'reload schema';
