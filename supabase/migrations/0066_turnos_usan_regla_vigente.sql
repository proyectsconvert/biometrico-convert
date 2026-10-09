-- Migración 0066: Los turnos sin regla asociada (iniciados antes de la 0061) usan la regla vigente
-- El tablero, las alarmas, la conciliación y las acciones del supervisor tomaban 8 h por defecto cuando
-- el turno no tenía regla. Ahora toman la regla que aplica hoy a la persona (empleado > campaña >
-- empresa), y los turnos abiertos sin regla quedan asociados a ella. Editar una regla ya se reflejaba
-- en los turnos que sí la tienen.

update public.work_sessions w set policy_id = (public._politica_turno(w.tenant_id, w.employee_id)).id
where w.ended_at is null and w.policy_id is null;

CREATE OR REPLACE FUNCTION public.revisar_alarmas_turno()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; n integer := 0; v_limite timestamptz; v_tipo text; v_horas numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not (public.has_permission('inicio_turno', 'ver') or public.has_permission('registro_turnos', 'ver')) then
    raise exception 'Sin permiso';
  end if;
  for r in
    select w.*, coalesce(p.max_horas, 8) as max_horas, coalesce(p.tolerancia_min, 0) as tolerancia_min,
           coalesce(p.recordatorio_min, 30) as recordatorio_min, coalesce(p.alarmas_activas, true) as alarmas_activas,
           coalesce(p.alertar_roles, '{supervisor,coordinador}') as roles
    from work_sessions w left join shift_policies p on p.id = (select coalesce(w.policy_id, (public._politica_turno(w.tenant_id, w.employee_id)).id))
    where w.ended_at is null
      and (auth.role() = 'service_role' or w.tenant_id = public.current_tenant_id())
  loop
    continue when not r.alarmas_activas;
    v_limite := coalesce(r.extra_autorizada_hasta,
                         r.started_at + make_interval(mins => (r.max_horas * 60)::int + r.tolerancia_min));
    continue when now() <= v_limite;
    continue when r.ultimo_aviso_at is not null and r.ultimo_aviso_at > now() - make_interval(mins => r.recordatorio_min);
    v_horas := round(extract(epoch from now() - r.started_at)::numeric / 3600, 1);
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

CREATE OR REPLACE FUNCTION public.conciliar_turnos_biometrico(_desde date, _hasta date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record; v_tz text; v_tol integer; v_ini timestamp; v_fin timestamp; a record; v_hay boolean;
  deseadas jsonb; k text; v_det text; v_ex public.shift_alerts; n integer := 0; v_roles text[];
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not (public.has_permission('inicio_turno', 'ver') or public.has_permission('registro_turnos', 'ver')) then
    raise exception 'Sin permiso';
  end if;
  for r in
    select w.*, p.alertar_roles, p.alarmas_activas
    from work_sessions w left join shift_policies p on p.id = (select coalesce(w.policy_id, (public._politica_turno(w.tenant_id, w.employee_id)).id))
    where w.employee_id is not null
      and (auth.role() = 'service_role' or w.tenant_id = public.current_tenant_id())
      and w.started_at >= (_desde::timestamp - interval '1 day') and w.started_at < (_hasta::timestamp + interval '2 days')
  loop
    select coalesce((select value#>>'{}' from rules where tenant_id = r.tenant_id and key = 'zona_horaria'), 'America/Bogota'),
           coalesce((select (value#>>'{}')::numeric::int from rules where tenant_id = r.tenant_id and key = 'tolerancia_registro_turno_min'), 0)
      into v_tz, v_tol;
    perform pg_advisory_xact_lock(hashtext('alarma_turno:' || r.id::text));
    v_ini := r.started_at at time zone v_tz;
    continue when v_ini::date < _desde or v_ini::date > _hasta;
    v_fin := r.ended_at at time zone v_tz;
    v_hay := public._hay_biometrico_dia(r.tenant_id, v_ini::date);
    select ad.first_in, ad.last_out, ad.status::text as estado into a
    from attendance_daily ad where ad.employee_id = r.employee_id and ad.work_date = v_ini::date;
    v_roles := case when coalesce(r.alarmas_activas, true) then coalesce(r.alertar_roles, '{supervisor,coordinador}') else '{}' end;

    -- Qué alarmas corresponden hoy a este turno (tipo → detalle)
    deseadas := '{}'::jsonb;
    if not v_hay then
      deseadas := deseadas || jsonb_build_object('bio_pendiente',
        format('Inició turno a las %s; aún no hay huella porque el biométrico del %s no está cargado. Se concilia al cargarlo.',
               to_char(v_ini, 'HH24:MI'), to_char(v_ini, 'DD/MM')));
    elsif a.first_in is null then
      deseadas := deseadas || jsonb_build_object('bio_sin_huella',
        format('Inició turno a las %s y no hay huella de entrada ese día', to_char(v_ini, 'HH24:MI')));
    else
      if v_ini < a.first_in - make_interval(mins => v_tol) then
        deseadas := deseadas || jsonb_build_object('bio_inicio_antes_huella',
          format('Inició turno a las %s, antes de la huella de entrada (%s): primero debe marcar la huella y luego iniciar turno',
                 to_char(v_ini, 'HH24:MI'), to_char(a.first_in, 'HH24:MI')));
      end if;
      if r.ended_at is not null and r.cierre = 'usuario' then
        if a.estado <> 'completa' or a.last_out is null then
          deseadas := deseadas || jsonb_build_object('bio_sin_salida',
            format('Finalizó turno a las %s y no hay huella de salida ese día', to_char(v_fin, 'HH24:MI')));
        elsif v_fin > a.last_out + make_interval(mins => v_tol) then
          deseadas := deseadas || jsonb_build_object('bio_fin_despues_salida',
            format('Finalizó turno a las %s, después de la huella de salida (%s): primero debe finalizar turno y luego marcar la salida',
                   to_char(v_fin, 'HH24:MI'), to_char(a.last_out, 'HH24:MI')));
        end if;
      end if;
    end if;

    -- Cierra (conciliadas) las alarmas del biométrico que ya no aplican
    update shift_alerts set estado = 'atendida', atendida_at = now(),
           datos = datos || jsonb_build_object('nota', 'Conciliado con el biométrico')
    where session_id = r.id and estado = 'abierta' and tipo like 'bio\_%' and not deseadas ? tipo;

    -- Crea o actualiza las que sí aplican (no reabre las que un supervisor ya atendió)
    for k in select jsonb_object_keys(deseadas) loop
      v_det := deseadas->>k;
      select * into v_ex from shift_alerts where session_id = r.id and tipo = k order by created_at desc limit 1;
      if v_ex.id is null then
        perform public._alarma_turno(r.tenant_id, r.id, r.user_id, r.employee_id, k,
          case when k = 'bio_pendiente' then 'info' else 'alta' end, v_det,
          jsonb_build_object('entrada_huella', a.first_in, 'salida_huella', a.last_out, 'inicio', v_ini, 'fin', v_fin),
          case when k = 'bio_pendiente' then '{}'::text[] else v_roles end, 'abierta');
        n := n + 1;
      elsif v_ex.estado = 'abierta' and v_ex.detalle is distinct from v_det then
        update shift_alerts set detalle = v_det, ultima_at = now() where id = v_ex.id;
      end if;
    end loop;
  end loop;
  return n;
end $function$;

CREATE OR REPLACE FUNCTION public.tablero_inicio_turno(_desde date, _hasta date)
 RETURNS TABLE(id uuid, user_id uuid, employee_id uuid, empleado text, documento text, usuario text, campana text, supervisores text, inicio timestamp with time zone, fin timestamp with time zone, cierre text, motivo_cierre text, tipo_dispositivo text, ip_inicio text, ip_fin text, ubicacion jsonb, validacion jsonb, max_horas numeric, limite timestamp with time zone, extra_autorizada_hasta timestamp with time zone, extra_autorizada_horas numeric, estado text, avisos integer, alarmas_abiertas integer, regla text, dentro_de_rango boolean, ultima_ubicacion_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select w.id, w.user_id, w.employee_id, e.full_name, e.document, coalesce(pr.full_name, pr.email), c.name,
         (select string_agg(s.nombre, ', ') from public.supervisores_campanas() s
           where s.todas or e.campaign_id = any(s.campaign_ids)),
         w.started_at, w.ended_at, w.cierre, w.motivo_cierre,
         coalesce(w.tipo_dispositivo, public._tipo_dispositivo(w.inicio#>>'{red,navegador}')),
         coalesce(w.ip_inicio, w.inicio#>>'{red,ip}'), coalesce(w.ip_fin, w.fin#>>'{red,ip}'),
         w.inicio->'ubicacion', w.validacion, coalesce(p.max_horas, 8),
         coalesce(w.extra_autorizada_hasta, w.started_at + make_interval(mins => (coalesce(p.max_horas, 8) * 60)::int + coalesce(p.tolerancia_min, 0))),
         w.extra_autorizada_hasta, w.extra_autorizada_horas,
         case
           when w.ended_at is not null then case w.cierre when 'autorizado' then 'cierre_autorizado' when 'automatico' then 'sin_cierre' else 'finalizado' end
           when w.extra_autorizada_hasta is not null and now() > w.extra_autorizada_hasta then 'extra_vencida'
           when w.extra_autorizada_hasta is not null then 'en_extra'
           when now() > w.started_at + make_interval(mins => (coalesce(p.max_horas, 8) * 60)::int + coalesce(p.tolerancia_min, 0)) then 'vencido'
           else 'activo' end,
         w.avisos,
         (select count(*)::int from shift_alerts a where a.session_id = w.id and a.estado = 'abierta'),
         p.nombre, w.dentro_de_rango, w.ultima_ubicacion_at
  from work_sessions w
  left join employees e on e.id = w.employee_id
  left join campaigns c on c.id = e.campaign_id
  left join profiles pr on pr.id = w.user_id
  left join shift_policies p on p.id = (select coalesce(w.policy_id, (public._politica_turno(w.tenant_id, w.employee_id)).id))
  where (public.has_permission('inicio_turno', 'ver') or public.has_permission('registro_turnos', 'ver'))
    and public.tenant_visible(w.tenant_id)
    and (public.ve_toda_empresa() or w.employee_id = any(public.my_employee_ids()))
    and ((w.started_at at time zone 'America/Bogota')::date between _desde and _hasta or w.ended_at is null)
  order by (w.ended_at is null) desc, w.started_at desc;
$function$;

CREATE OR REPLACE FUNCTION public.gestionar_turno(_sesion uuid, _accion text, _horas numeric DEFAULT NULL::numeric, _motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.work_sessions; v_pol public.shift_policies; v_desde timestamptz; v_nombre text;
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
    perform public._notificar(v.tenant_id, array[v.user_id], 'turnos', null, 'Tu supervisor te pide finalizar el turno',
      array[coalesce(nullif(trim(_motivo), ''), 'Finaliza tu turno desde el botón «Finalizar».') || ' — ' || coalesce(v_nombre, '')], null, null, null);
    perform public._alarma_turno(v.tenant_id, v.id, v.user_id, v.employee_id, 'aviso_finalizar', 'info',
      'Se pidió finalizar el turno' || coalesce(': ' || nullif(trim(_motivo), ''), ''), jsonb_build_object('por', v_nombre), '{}', 'informativa');

  elsif _accion = 'autorizar_extra' then
    if _horas is null or _horas < 0.25 or _horas > 8 then raise exception 'Indica entre 0,25 y 8 horas extra'; end if;
    v_desde := greatest(now(), coalesce(v.extra_autorizada_hasta,
                 v.started_at + make_interval(mins => (coalesce(v_pol.max_horas, 8) * 60)::int + coalesce(v_pol.tolerancia_min, 0))));
    update work_sessions set extra_autorizada_hasta = v_desde + make_interval(mins => (_horas * 60)::int),
           extra_autorizada_horas = coalesce(extra_autorizada_horas, 0) + _horas, ultimo_aviso_at = null
    where id = v.id returning * into v;
    update shift_alerts set estado = 'atendida', atendida_at = now(), atendida_por = auth.uid()
    where session_id = v.id and estado = 'abierta' and tipo in ('turno_excedido', 'extra_excedida');
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

notify pgrst, 'reload schema';
