-- Migración 0065: Sin alarmas duplicadas cuando el vigilante del servidor y el tablero revisan a la vez
-- (bloqueo por turno) y limpieza de los duplicados que alcanzaron a crearse.

CREATE OR REPLACE FUNCTION public._alarma_turno(_tenant uuid, _sesion uuid, _usuario uuid, _emp uuid, _tipo text, _severidad text, _detalle text, _datos jsonb, _roles text[], _estado text DEFAULT 'abierta'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_camp uuid; v_nombre text;
begin
  -- Una sola alarma abierta por turno y tipo aunque dos procesos revisen a la vez
  if _sesion is not null then perform pg_advisory_xact_lock(hashtext('alarma_turno:' || _sesion::text)); end if;
  if _sesion is not null and _estado = 'abierta' then
    select id into v_id from shift_alerts where session_id = _sesion and tipo = _tipo and estado = 'abierta' limit 1;
  end if;
  if v_id is not null then
    update shift_alerts set repeticiones = repeticiones + 1, ultima_at = now(), detalle = _detalle, datos = _datos where id = v_id;
  else
    insert into shift_alerts (tenant_id, session_id, user_id, employee_id, tipo, severidad, detalle, datos, estado)
    values (_tenant, _sesion, _usuario, _emp, _tipo, _severidad, _detalle, coalesce(_datos, '{}'), _estado)
    returning id into v_id;
  end if;
  if cardinality(coalesce(_roles, '{}')) > 0 then
    select e.campaign_id, e.full_name into v_camp, v_nombre from employees e where e.id = _emp;
    if v_nombre is null then select coalesce(full_name, email) into v_nombre from profiles where id = _usuario; end if;
    perform public._notificar(_tenant, public._usuarios_roles_turno(_tenant, _roles, v_camp), 'turnos',
      'alarma_turno:' || coalesce(_sesion::text, _usuario::text), 'Alarma de turno · ' || coalesce(v_nombre, 'persona'),
      array[_detalle], '/inicio-turno', v_camp, v_id::text);
  end if;
  return v_id;
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
    from work_sessions w left join shift_policies p on p.id = w.policy_id
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

-- Limpieza: deja la alarma más antigua de cada turno y tipo entre las abiertas
delete from public.shift_alerts x using public.shift_alerts y
where x.session_id = y.session_id and x.tipo = y.tipo and x.estado = 'abierta' and y.estado = 'abierta'
  and (x.created_at, x.id) > (y.created_at, y.id);
