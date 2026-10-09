-- Migración 0063: Ubicación obligatoria, dispositivo autorizado, rango vigilado y cruce con el biométrico
-- 1. Iniciar turno exige ubicación activa (siempre, en cualquier regla).
-- 2. Dispositivo no autorizado (p. ej. celular cuando solo se permite PC): bloquea iniciar y finalizar
--    siempre, con alarma y un mensaje claro.
-- 3. Rango estricto: la precisión del GPS da como máximo 20 m de margen (sirve para radios de 20–50 m);
--    una ubicación con precisión peor de 500 m se considera imprecisa.
-- 4. reportar_ubicacion_turno: durante el turno el navegador reporta la ubicación cada pocos minutos;
--    si sale del rango o apaga la ubicación se genera alarma (repetida según la regla) y se cierra sola
--    al volver.
-- 5. conciliar_turnos_biometrico: el orden correcto es huella de entrada → iniciar turno, y finalizar
--    turno → huella de salida. Mientras el biométrico del día no esté cargado queda «pendiente» (sin
--    notificar); cuando se carga, se concilia: se cierran las alarmas que ya no aplican y se generan
--    (y notifican) las diferencias reales.

/* ---------- Tipos de alarma nuevos ---------- */
alter table public.shift_alerts drop constraint if exists shift_alerts_tipo_check;
alter table public.shift_alerts add constraint shift_alerts_tipo_check check (tipo in (
  'inicio_bloqueado', 'inicio_fuera_de_regla', 'cierre_bloqueado', 'cierre_otro_dispositivo', 'cierre_fuera_de_regla',
  'turno_excedido', 'extra_excedida', 'extra_autorizada', 'aviso_finalizar', 'cierre_autorizado',
  'dispositivo_no_autorizado', 'sin_ubicacion', 'fuera_de_rango', 'ubicacion_desactivada',
  'bio_pendiente', 'bio_sin_huella', 'bio_inicio_antes_huella', 'bio_fin_despues_salida', 'bio_sin_salida'));

alter table public.work_sessions
  add column if not exists ultima_ubicacion jsonb,
  add column if not exists ultima_ubicacion_at timestamptz,
  add column if not exists dentro_de_rango boolean;
grant select (ultima_ubicacion, ultima_ubicacion_at, dentro_de_rango) on public.work_sessions to authenticated;

/* ---------- Nombre legible del dispositivo ---------- */
create or replace function public._nombre_dispositivo(_t text)
returns text language sql immutable as $$
  select case _t when 'pc' then 'un computador' when 'movil' then 'un celular' when 'tablet' then 'una tablet' else 'este dispositivo' end;
$$;

/* ---------- Validación (rango estricto y dispositivo aparte) ---------- */
create or replace function public._validar_turno(_pol public.shift_policies, _ip text, _tipo text, _ubic jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  fallas text[] := '{}';
  v_ip_ok boolean; v_disp_ok boolean := true; v_rango boolean;
  v_lat double precision; v_lon double precision; v_prec double precision;
  v_dist double precision; v_lugar text; v_radio double precision; u jsonb; d double precision;
begin
  if _pol.id is null then return jsonb_build_object('ok', true, 'fallas', '[]'::jsonb, 'dispositivo_ok', true); end if;

  if cardinality(_pol.ips) > 0 then
    begin
      select exists (select 1 from unnest(_pol.ips) x where _ip::inet <<= x::inet) into v_ip_ok;
    exception when others then v_ip_ok := false;
    end;
    if not coalesce(v_ip_ok, false) then fallas := fallas || format('IP no autorizada (%s)', coalesce(_ip, 'sin IP')); end if;
  end if;

  if cardinality(_pol.dispositivos) > 0 and not coalesce(_tipo = any(_pol.dispositivos), false) then
    v_disp_ok := false;
    fallas := fallas || format('Dispositivo no autorizado (%s)', coalesce(_tipo, 'desconocido'));
  end if;

  if coalesce(_ubic->>'estado', '') = 'ok' then
    v_lat := (_ubic->>'lat')::double precision;
    v_lon := (_ubic->>'lon')::double precision;
    v_prec := coalesce((_ubic->>'precision_m')::double precision, 0);
  end if;
  if jsonb_array_length(_pol.ubicaciones) > 0 then
    if v_lat is null then
      fallas := fallas || 'Sin ubicación: la regla exige estar en una ubicación autorizada'::text;
    else
      -- la más cercana; dentro si la distancia, menos un margen de precisión de hasta 20 m, cabe en el radio
      for u in select * from jsonb_array_elements(_pol.ubicaciones) loop
        d := public._distancia_m(v_lat, v_lon, (u->>'lat')::double precision, (u->>'lon')::double precision);
        if v_dist is null or d < v_dist then
          v_dist := d; v_lugar := u->>'nombre'; v_radio := coalesce((u->>'radio_m')::double precision, 50);
        end if;
      end loop;
      v_rango := exists (select 1 from jsonb_array_elements(_pol.ubicaciones) u2
                         where public._distancia_m(v_lat, v_lon, (u2->>'lat')::double precision, (u2->>'lon')::double precision)
                               - least(v_prec, 20) <= coalesce((u2->>'radio_m')::double precision, 50));
      if v_prec > 500 then
        fallas := fallas || format('Ubicación imprecisa (±%s m): activa el GPS o la ubicación precisa', round(v_prec)::text);
        v_rango := false;
      elsif not v_rango then
        fallas := fallas || format('Fuera del rango autorizado: a %s m de %s (radio %s m)', round(v_dist)::text, coalesce(v_lugar, 'la sede'), round(v_radio)::text);
      end if;
    end if;
  elsif _pol.exigir_ubicacion and v_lat is null then
    fallas := fallas || 'Sin ubicación: la regla exige compartir la ubicación'::text;
  end if;

  return jsonb_build_object('ok', cardinality(fallas) = 0, 'fallas', to_jsonb(fallas), 'ip', _ip, 'dispositivo', _tipo,
                            'dispositivo_ok', v_disp_ok, 'dentro_de_rango', v_rango, 'distancia_m', round(v_dist),
                            'ubicacion', v_lugar, 'precision_m', round(v_prec), 'regla', _pol.nombre, 'modo', _pol.modo);
end $$;

/* ---------- Iniciar ---------- */
create or replace function public.iniciar_turno(_datos jsonb default '{}'::jsonb, _token text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id(); v_emp uuid; v_pol public.shift_policies;
  v_red jsonb := public._red_solicitud(); v_tipo text; v_val jsonb; v public.work_sessions; v_motivo text;
  v_roles text[];
begin
  if auth.uid() is null then raise exception 'Inicia sesión para registrar tu turno'; end if;
  if v_tenant is null then raise exception 'Tu usuario no tiene empresa asignada'; end if;
  if octet_length(coalesce(_datos, '{}')::text) > 20000 then raise exception 'Datos del equipo demasiado grandes'; end if;
  if coalesce(length(_token), 0) < 20 then raise exception 'Falta la llave del dispositivo: recarga la página e intenta de nuevo'; end if;

  update work_sessions set ended_at = now(), cierre = 'automatico'
  where user_id = auth.uid() and ended_at is null and started_at < now() - interval '16 hours';
  if exists (select 1 from work_sessions where user_id = auth.uid() and ended_at is null) then
    return jsonb_build_object('ok', false, 'motivo', 'Ya tienes un turno iniciado: finalízalo antes de iniciar otro');
  end if;

  select id into v_emp from employees where user_id = auth.uid() and tenant_id = v_tenant limit 1;
  v_pol := public._politica_turno(v_tenant, v_emp);
  v_roles := coalesce(v_pol.alertar_roles, '{supervisor,coordinador}');
  v_tipo := coalesce(public._tipo_dispositivo(v_red->>'navegador'), public._tipo_dispositivo(_datos#>>'{equipo,navegador}'));

  -- 1. Ubicación obligatoria para iniciar (en cualquier regla)
  if coalesce(_datos#>>'{ubicacion,estado}', '') <> 'ok' then
    perform public._alarma_turno(v_tenant, null, auth.uid(), v_emp, 'sin_ubicacion', 'media',
      'Intentó iniciar turno sin activar la ubicación (' || coalesce(_datos#>>'{ubicacion,estado}', 'no disponible') || ')',
      jsonb_build_object('equipo', _datos->'equipo', 'ip', v_red->>'ip'), v_roles, 'abierta');
    return jsonb_build_object('ok', false, 'motivo',
      'Debes activar la ubicación para iniciar el turno. Permite la ubicación en el navegador (ícono junto a la dirección de la página) e intenta de nuevo.');
  end if;

  v_val := public._validar_turno(v_pol, v_red->>'ip', v_tipo, _datos->'ubicacion');

  -- 2. Dispositivo no autorizado: bloquea siempre
  if not coalesce((v_val->>'dispositivo_ok')::boolean, true) then
    v_motivo := format('No puedes iniciar turno desde %s. Esta regla solo lo permite desde: %s.', public._nombre_dispositivo(v_tipo),
      (select string_agg(public._nombre_dispositivo(x), ', ') from unnest(v_pol.dispositivos) x));
    perform public._alarma_turno(v_tenant, null, auth.uid(), v_emp, 'dispositivo_no_autorizado', 'alta',
      'Intentó iniciar turno desde ' || public._nombre_dispositivo(v_tipo) || ' (no autorizado)', v_val, v_roles, 'abierta');
    return jsonb_build_object('ok', false, 'motivo', v_motivo, 'validacion', v_val);
  end if;

  -- 3. Resto de la regla: bloquea o alerta según el modo
  if not (v_val->>'ok')::boolean and v_pol.modo = 'bloquear' then
    perform public._alarma_turno(v_tenant, null, auth.uid(), v_emp, 'inicio_bloqueado', 'alta',
      'Intentó iniciar turno fuera de la regla: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(v_val->'fallas') x),
      v_val || jsonb_build_object('equipo', _datos->'equipo', 'ubicacion', _datos->'ubicacion'), v_roles, 'abierta');
    return jsonb_build_object('ok', false, 'motivo',
      'No puedes iniciar turno: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(v_val->'fallas') x), 'validacion', v_val);
  end if;

  insert into work_sessions (tenant_id, user_id, employee_id, inicio, policy_id, tipo_dispositivo, token_hash, ip_inicio, validacion,
                             ultima_ubicacion, ultima_ubicacion_at, dentro_de_rango)
  values (v_tenant, auth.uid(), v_emp,
          coalesce(_datos, '{}'::jsonb) || jsonb_build_object('red', v_red, 'hora_servidor', now()),
          v_pol.id, v_tipo, encode(extensions.digest(_token, 'sha256'), 'hex'), v_red->>'ip', v_val,
          _datos->'ubicacion', now(), (v_val->>'dentro_de_rango')::boolean)
  returning * into v;

  if not (v_val->>'ok')::boolean then
    perform public._alarma_turno(v_tenant, v.id, auth.uid(), v_emp, 'inicio_fuera_de_regla', 'media',
      'Inició turno fuera de la regla: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(v_val->'fallas') x),
      v_val, v_roles, 'abierta');
  end if;
  return jsonb_build_object('ok', true, 'id', v.id, 'started_at', v.started_at, 'max_horas', v_pol.max_horas,
                            'advertencias', v_val->'fallas');
end $$;

/* ---------- Finalizar ---------- */
create or replace function public.finalizar_turno(_datos jsonb default '{}'::jsonb, _token text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v public.work_sessions; v_pol public.shift_policies; v_red jsonb := public._red_solicitud();
  v_tipo text; v_val jsonb; v_cambio text[] := '{}'; d double precision; v_roles text[];
begin
  if auth.uid() is null then raise exception 'Inicia sesión para registrar tu turno'; end if;
  if octet_length(coalesce(_datos, '{}')::text) > 20000 then raise exception 'Datos del equipo demasiado grandes'; end if;
  select * into v from work_sessions where user_id = auth.uid() and ended_at is null for update;
  if v.id is null then return jsonb_build_object('ok', false, 'motivo', 'No tienes un turno iniciado'); end if;
  select * into v_pol from shift_policies where id = v.policy_id;
  v_roles := coalesce(v_pol.alertar_roles, '{supervisor,coordinador}');
  v_tipo := coalesce(public._tipo_dispositivo(v_red->>'navegador'), public._tipo_dispositivo(_datos#>>'{equipo,navegador}'));

  -- Dispositivo no autorizado: bloquea siempre
  if v_pol.id is not null and cardinality(v_pol.dispositivos) > 0 and not coalesce(v_tipo = any(v_pol.dispositivos), false) then
    perform public._alarma_turno(v.tenant_id, v.id, auth.uid(), v.employee_id, 'dispositivo_no_autorizado', 'alta',
      'Intentó finalizar turno desde ' || public._nombre_dispositivo(v_tipo) || ' (no autorizado)',
      jsonb_build_object('dispositivo', v_tipo, 'ip', v_red->>'ip'), v_roles, 'abierta');
    return jsonb_build_object('ok', false, 'motivo', format('No puedes finalizar turno desde %s. Esta regla solo lo permite desde: %s.',
      public._nombre_dispositivo(v_tipo), (select string_agg(public._nombre_dispositivo(x), ', ') from unnest(v_pol.dispositivos) x)));
  end if;

  -- Mismo dispositivo y navegador donde inició
  if v.token_hash is not null and coalesce(v_pol.mismo_dispositivo_cierre, true)
     and v.token_hash is distinct from encode(extensions.digest(coalesce(_token, ''), 'sha256'), 'hex') then
    perform public._alarma_turno(v.tenant_id, v.id, auth.uid(), v.employee_id, 'cierre_otro_dispositivo', 'alta',
      format('Intentó finalizar el turno desde otro dispositivo o navegador (%s, IP %s)', coalesce(v_tipo, 'desconocido'), coalesce(v_red->>'ip', 'sin IP')),
      jsonb_build_object('equipo', _datos->'equipo', 'ip', v_red->>'ip', 'ubicacion', _datos->'ubicacion'), v_roles, 'abierta');
    return jsonb_build_object('ok', false, 'motivo',
      'Este turno se inició en otro dispositivo o navegador. Finalízalo desde ese mismo equipo o pide a tu supervisor un cierre autorizado.');
  end if;

  v_val := public._validar_turno(v_pol, v_red->>'ip', v_tipo, _datos->'ubicacion');
  if not (v_val->>'ok')::boolean and v_pol.modo = 'bloquear' then
    perform public._alarma_turno(v.tenant_id, v.id, auth.uid(), v.employee_id, 'cierre_bloqueado', 'alta',
      'Intentó finalizar fuera de la regla: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(v_val->'fallas') x),
      v_val, v_roles, 'abierta');
    return jsonb_build_object('ok', false, 'motivo',
      'No puedes finalizar desde aquí: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(v_val->'fallas') x)
      || '. Vuelve a la ubicación o red autorizada, o pide un cierre autorizado.');
  end if;

  if v.ip_inicio is not null and v_red->>'ip' is not null and v.ip_inicio <> v_red->>'ip' then
    v_cambio := v_cambio || format('IP distinta (inició en %s, finalizó en %s)', v.ip_inicio, v_red->>'ip');
  end if;
  if v.inicio#>>'{ubicacion,estado}' = 'ok' and _datos#>>'{ubicacion,estado}' = 'ok' then
    d := public._distancia_m((v.inicio#>>'{ubicacion,lat}')::double precision, (v.inicio#>>'{ubicacion,lon}')::double precision,
                             (_datos#>>'{ubicacion,lat}')::double precision, (_datos#>>'{ubicacion,lon}')::double precision);
    if d > 300 then v_cambio := v_cambio || format('Finalizó a %s m de donde inició', round(d)::text); end if;
  end if;
  if not (v_val->>'ok')::boolean then
    v_cambio := v_cambio || (select array_agg(x) from jsonb_array_elements_text(v_val->'fallas') x);
  end if;

  update work_sessions set ended_at = now(), cierre = 'usuario', ip_fin = v_red->>'ip',
         fin = coalesce(_datos, '{}'::jsonb) || jsonb_build_object('red', v_red, 'hora_servidor', now(), 'tipo_dispositivo', v_tipo, 'validacion', v_val)
  where id = v.id returning * into v;
  update shift_alerts set estado = 'atendida', atendida_at = now(), atendida_por = auth.uid()
  where session_id = v.id and estado = 'abierta'
    and tipo in ('turno_excedido', 'extra_excedida', 'fuera_de_rango', 'ubicacion_desactivada');

  if cardinality(v_cambio) > 0 then
    perform public._alarma_turno(v.tenant_id, v.id, auth.uid(), v.employee_id, 'cierre_fuera_de_regla', 'media',
      'Finalizó con diferencias: ' || array_to_string(v_cambio, '; '), coalesce(v_val, '{}'::jsonb), v_roles, 'abierta');
  end if;
  return jsonb_build_object('ok', true, 'id', v.id, 'started_at', v.started_at, 'ended_at', v.ended_at,
                            'advertencias', to_jsonb(v_cambio));
end $$;

/* ---------- Ubicación durante el turno ---------- */
create or replace function public.reportar_ubicacion_turno(_ubic jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v public.work_sessions; v_pol public.shift_policies; v_val jsonb; v_tipo text; v_det text;
  v_abierta public.shift_alerts; v_rec integer;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false); end if;
  if octet_length(coalesce(_ubic, '{}')::text) > 2000 then raise exception 'Datos inválidos'; end if;
  select * into v from work_sessions where user_id = auth.uid() and ended_at is null;
  if v.id is null then return jsonb_build_object('ok', false, 'motivo', 'Sin turno abierto'); end if;
  select * into v_pol from shift_policies where id = v.policy_id;
  v_rec := coalesce(v_pol.recordatorio_min, 30);

  if coalesce(_ubic->>'estado', '') <> 'ok' then
    v_tipo := 'ubicacion_desactivada';
    v_det := 'Desactivó o bloqueó la ubicación durante el turno (' || coalesce(_ubic->>'estado', 'no disponible') || ')';
  elsif v_pol.id is not null and jsonb_array_length(v_pol.ubicaciones) > 0 then
    v_val := public._validar_turno(v_pol, null, null, _ubic);
    if not coalesce((v_val->>'dentro_de_rango')::boolean, false) then
      v_tipo := 'fuera_de_rango';
      v_det := 'Salió del rango autorizado durante el turno: '
        || coalesce((select string_agg(x, '; ') from jsonb_array_elements_text(v_val->'fallas') x where x ~* 'rango|imprecisa'), 'fuera del rango');
    end if;
  end if;

  update work_sessions set ultima_ubicacion = _ubic, ultima_ubicacion_at = now(),
         dentro_de_rango = case when v_tipo is null then (case when v_val is null then dentro_de_rango else true end) else false end
  where id = v.id;

  if v_tipo is null then
    -- volvió al rango o reactivó la ubicación: se cierran las alarmas abiertas de ubicación
    update shift_alerts set estado = 'atendida', atendida_at = now(),
           datos = datos || jsonb_build_object('nota', 'Volvió al rango / reactivó la ubicación')
    where session_id = v.id and estado = 'abierta' and tipo in ('fuera_de_rango', 'ubicacion_desactivada');
    return jsonb_build_object('ok', true, 'dentro', true);
  end if;

  -- Alarma: se notifica la primera vez y luego cada «recordatorio_min»; entre medias solo se actualiza
  select * into v_abierta from shift_alerts where session_id = v.id and tipo = v_tipo and estado = 'abierta' limit 1;
  if v_abierta.id is not null and v_abierta.ultima_at > now() - make_interval(mins => v_rec) then
    update shift_alerts set detalle = v_det, datos = coalesce(v_val, '{}'::jsonb) || jsonb_build_object('ubicacion', _ubic) where id = v_abierta.id;
  else
    perform public._alarma_turno(v.tenant_id, v.id, v.user_id, v.employee_id, v_tipo, 'alta', v_det,
      coalesce(v_val, '{}'::jsonb) || jsonb_build_object('ubicacion', _ubic),
      case when coalesce(v_pol.alarmas_activas, true) then coalesce(v_pol.alertar_roles, '{supervisor,coordinador}') else '{}' end, 'abierta');
  end if;
  return jsonb_build_object('ok', true, 'dentro', false, 'motivo', v_det);
end $$;

/* ---------- Cruce con el biométrico ---------- */
create or replace function public.conciliar_turnos_biometrico(_desde date, _hasta date)
returns integer
language plpgsql security definer set search_path = public
as $$
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
end $$;

revoke all on function public._nombre_dispositivo(text) from public, anon;
revoke all on function public.reportar_ubicacion_turno(jsonb) from public, anon;
revoke all on function public.conciliar_turnos_biometrico(date, date) from public, anon;
grant execute on function public.reportar_ubicacion_turno(jsonb) to authenticated;
grant execute on function public.conciliar_turnos_biometrico(date, date) to authenticated, service_role;

notify pgrst, 'reload schema';
