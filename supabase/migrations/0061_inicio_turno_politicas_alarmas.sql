-- Migración 0061: Configuración de turnos, validaciones de seguridad y alarmas (Inicio turno)
-- 1. shift_policies: reglas por empresa, campaña o empleado (la más específica manda): IP o rangos
--    autorizados, ubicaciones con radio, tipos de dispositivo, tiempo máximo, tolerancia, cada cuánto
--    repetir la alarma, destinatarios por rol y si se bloquea o solo se alerta.
-- 2. Inicio y fin validados en la base: la IP la toma el servidor (cabeceras de Cloudflare), el tipo
--    de dispositivo sale del navegador que ve el servidor. El turno solo se finaliza desde el mismo
--    navegador: al iniciar se guarda el hash de una llave secreta que queda en ese navegador.
--    Excepción: el supervisor puede hacer un cierre autorizado (con motivo, queda trazado).
-- 3. shift_alerts: bloqueos, intentos de cierre desde otro dispositivo, turnos vencidos, horas extra
--    autorizadas o excedidas, avisos y cierres autorizados. Se notifica a los roles configurados.
-- 4. revisar_alarmas_turno: genera las alarmas de turnos que pasan el tiempo configurado (la ejecuta
--    el servidor cada minuto, aunque nadie tenga el tablero abierto).
-- 5. gestionar_turno: el supervisor avisa que finalice, autoriza horas extra o cierra el turno.
-- 6. Permisos: registro_turnos.configurar; módulo «inicio_turno» (ver, gestionar).

/* ============================== 1. Políticas ============================== */
create table if not exists public.shift_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  nombre text not null,
  alcance text not null check (alcance in ('empresa', 'campana', 'empleado')),
  campaign_id uuid references public.campaigns(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete cascade,
  activo boolean not null default true,
  -- bloquear: no deja iniciar/finalizar fuera de la regla; alertar: deja, pero genera alarma
  modo text not null default 'alertar' check (modo in ('bloquear', 'alertar')),
  ips text[] not null default '{}',
  ubicaciones jsonb not null default '[]'::jsonb,
  exigir_ubicacion boolean not null default false,
  dispositivos text[] not null default '{}',
  mismo_dispositivo_cierre boolean not null default true,
  max_horas numeric(5,2) not null default 8 check (max_horas > 0 and max_horas <= 24),
  tolerancia_min integer not null default 0 check (tolerancia_min between 0 and 240),
  recordatorio_min integer not null default 30 check (recordatorio_min between 5 and 720),
  alarmas_activas boolean not null default true,
  alertar_roles text[] not null default '{supervisor,coordinador}',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_policies_alcance_ok check (
    (alcance = 'empresa' and campaign_id is null and employee_id is null)
    or (alcance = 'campana' and campaign_id is not null and employee_id is null)
    or (alcance = 'empleado' and employee_id is not null)),
  constraint shift_policies_dispositivos_ok check (dispositivos <@ array['pc', 'movil', 'tablet']),
  constraint shift_policies_roles_ok check (alertar_roles <@ array['supervisor', 'coordinador', 'admin', 'nomina'])
);
create unique index if not exists shift_policies_una_por_alcance
  on public.shift_policies (tenant_id, alcance, campaign_id, employee_id) nulls not distinct;

alter table public.shift_policies enable row level security;
drop policy if exists "politicas turno lectura" on public.shift_policies;
drop policy if exists "politicas turno gestion" on public.shift_policies;
create policy "politicas turno lectura" on public.shift_policies for select
  using (public.tenant_visible(tenant_id) and (public.has_permission('registro_turnos', 'ver')
         or public.has_permission('registro_turnos', 'configurar') or public.has_permission('inicio_turno', 'ver')));
create policy "politicas turno gestion" on public.shift_policies for all
  using (public.tenant_visible(tenant_id) and public.has_permission('registro_turnos', 'configurar'))
  with check (public.tenant_visible(tenant_id) and public.has_permission('registro_turnos', 'configurar'));
grant select, insert, update, delete on public.shift_policies to authenticated;

drop trigger if exists auditar_ins on public.shift_policies;
drop trigger if exists auditar_upd on public.shift_policies;
drop trigger if exists auditar_del on public.shift_policies;
create trigger auditar_ins after insert on public.shift_policies referencing new table as nuevos
  for each statement execute function public.auditar_ins('registro_turnos', 'politica');
create trigger auditar_upd after update on public.shift_policies referencing old table as viejos new table as nuevos
  for each statement execute function public.auditar_upd('registro_turnos', 'politica');
create trigger auditar_del after delete on public.shift_policies referencing old table as viejos
  for each statement execute function public.auditar_del('registro_turnos', 'politica');

-- Regla por defecto de cada empresa: no bloquea nada, alarma a las 8 h
insert into public.shift_policies (tenant_id, nombre, alcance, modo, max_horas, tolerancia_min, recordatorio_min)
select t.id, 'Regla general de la empresa', 'empresa', 'alertar', 8, 15, 30
from public.tenants t
where not exists (select 1 from public.shift_policies p where p.tenant_id = t.id and p.alcance = 'empresa');

/* ============================== 2. Turnos ============================== */
alter table public.work_sessions
  add column if not exists policy_id uuid references public.shift_policies(id) on delete set null,
  add column if not exists tipo_dispositivo text,
  add column if not exists token_hash text,
  add column if not exists ip_inicio text,
  add column if not exists ip_fin text,
  add column if not exists validacion jsonb,
  add column if not exists extra_autorizada_hasta timestamptz,
  add column if not exists extra_autorizada_horas numeric(5,2),
  add column if not exists ultimo_aviso_at timestamptz,
  add column if not exists avisos integer not null default 0,
  add column if not exists cerrado_por uuid references auth.users(id) on delete set null,
  add column if not exists motivo_cierre text;
alter table public.work_sessions drop constraint if exists work_sessions_cierre_check;
alter table public.work_sessions add constraint work_sessions_cierre_check
  check (cierre in ('usuario', 'automatico', 'autorizado'));
-- El hash de la llave del dispositivo nunca se expone
revoke select on public.work_sessions from authenticated;
grant select (id, tenant_id, user_id, employee_id, started_at, ended_at, cierre, inicio, fin, created_at, policy_id,
              tipo_dispositivo, ip_inicio, ip_fin, validacion, extra_autorizada_hasta, extra_autorizada_horas,
              ultimo_aviso_at, avisos, cerrado_por, motivo_cierre)
  on public.work_sessions to authenticated;

-- El reporte de registro de turnos ya no lee la llave del dispositivo (columnas explícitas)
CREATE OR REPLACE FUNCTION public.reporte_registro_turnos(_desde date, _hasta date)
 RETURNS TABLE(id uuid, fecha date, usuario text, email text, documento text, empleado text, campana text, inicio timestamp without time zone, fin timestamp without time zone, cierre text, minutos_conectado integer, entrada_biometrico timestamp without time zone, salida_biometrico timestamp without time zone, minutos_en_empresa integer, minutos_inicio_vs_entrada integer, minutos_fin_vs_salida integer, alarmas text[], avisos text[], inicio_datos jsonb, fin_datos jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with cfg as (
    select coalesce((select value#>>'{}' from rules where key = 'zona_horaria' and tenant_id = public.current_tenant_id()), 'America/Bogota') as tz,
           coalesce((select (value#>>'{}')::numeric from rules where key = 'tolerancia_registro_turno_min' and tenant_id = public.current_tenant_id()), 0) as tol
  ),
  s as (
    select w.id, w.tenant_id, w.user_id, w.employee_id, w.started_at, w.ended_at, w.cierre, w.inicio, w.fin, (w.started_at at time zone cfg.tz) as ini_local,
           (w.ended_at at time zone cfg.tz) as fin_local, cfg.tol
    from work_sessions w, cfg
    where (w.started_at at time zone cfg.tz)::date between _desde and _hasta
  ),
  x as (
    select s.*, p.full_name as usuario, p.email, e.document, e.full_name as empleado, c.name as campana,
           a.first_in, a.last_out, a.status::text as estado_jornada,
           public._hay_biometrico_dia(s.tenant_id, s.ini_local::date) as hay_biometrico_dia
    from s
    left join profiles p on p.id = s.user_id
    left join employees e on e.id = s.employee_id
    left join campaigns c on c.id = e.campaign_id
    left join attendance_daily a on a.employee_id = s.employee_id and a.work_date = s.ini_local::date
  )
  select x.id, x.ini_local::date, x.usuario, x.email, x.document, x.empleado, x.campana,
         x.ini_local, x.fin_local, x.cierre,
         case when x.ended_at is not null then (extract(epoch from x.ended_at - x.started_at) / 60)::int end,
         x.first_in, case when x.estado_jornada = 'completa' then x.last_out end,
         case when x.estado_jornada = 'completa' then (extract(epoch from x.last_out - x.first_in) / 60)::int end,
         case when x.first_in is not null then (extract(epoch from x.ini_local - x.first_in) / 60)::int end,
         case when x.fin_local is not null and x.estado_jornada = 'completa'
              then (extract(epoch from x.fin_local - x.last_out) / 60)::int end,
         array_remove(array[
           case when x.first_in is not null and x.ini_local < x.first_in - make_interval(mins => x.tol::int)
                then 'inicio_antes_de_huella' end,
           case when x.employee_id is not null and x.first_in is null and x.hay_biometrico_dia
                then 'sin_huella' end,
           case when x.fin_local is not null and x.estado_jornada = 'completa' and x.cierre = 'usuario'
                     and x.fin_local > x.last_out + make_interval(mins => x.tol::int)
                then 'fin_despues_de_salida' end,
           case when x.cierre = 'automatico' or (x.ended_at is null and x.started_at < now() - interval '16 hours')
                then 'sin_cierre' end
         ], null),
         array_remove(array[
           case when x.employee_id is null then 'sin_empleado_vinculado' end,
           case when x.employee_id is not null and x.first_in is null and not x.hay_biometrico_dia
                then 'biometrico_pendiente' end,
           case when coalesce(x.inicio#>>'{ubicacion,estado}', '') <> 'ok' then 'sin_ubicacion' end,
           case when x.ended_at is null and x.started_at >= now() - interval '16 hours' then 'en_curso' end
         ], null),
         x.inicio, x.fin
  from x
  order by x.started_at desc;
$function$;

/* ============================== 3. Alarmas ============================== */
create table if not exists public.shift_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  session_id uuid references public.work_sessions(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  tipo text not null check (tipo in ('inicio_bloqueado', 'inicio_fuera_de_regla', 'cierre_bloqueado',
    'cierre_otro_dispositivo', 'cierre_fuera_de_regla', 'turno_excedido', 'extra_excedida', 'extra_autorizada',
    'aviso_finalizar', 'cierre_autorizado')),
  severidad text not null default 'media' check (severidad in ('alta', 'media', 'info')),
  detalle text not null,
  datos jsonb not null default '{}'::jsonb,
  estado text not null default 'abierta' check (estado in ('abierta', 'atendida', 'informativa')),
  repeticiones integer not null default 1,
  ultima_at timestamptz not null default now(),
  creada_por uuid default auth.uid(),
  atendida_por uuid references auth.users(id) on delete set null,
  atendida_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists shift_alerts_tenant_fecha on public.shift_alerts (tenant_id, created_at desc);
create index if not exists shift_alerts_sesion on public.shift_alerts (session_id);
create index if not exists shift_alerts_abiertas on public.shift_alerts (tenant_id) where estado = 'abierta';

alter table public.shift_alerts enable row level security;
drop policy if exists "alarmas turno lectura" on public.shift_alerts;
create policy "alarmas turno lectura" on public.shift_alerts for select
  using (user_id = auth.uid()
         or (public.tenant_visible(tenant_id)
             and (public.has_permission('inicio_turno', 'ver') or public.has_permission('registro_turnos', 'ver'))
             and (public.ve_toda_empresa() or employee_id = any(public.my_employee_ids()))));
revoke insert, update, delete, truncate on public.shift_alerts from authenticated, anon;
grant select on public.shift_alerts to authenticated;

/* ============================== Utilidades ============================== */
-- Tipo de dispositivo según el navegador que ve el servidor
create or replace function public._tipo_dispositivo(_ua text)
returns text language sql immutable as $$
  select case
    when coalesce(_ua, '') = '' then null
    when _ua ~* 'ipad|tablet|kindle|silk' or (_ua ~* 'android' and _ua !~* 'mobile') then 'tablet'
    when _ua ~* 'mobi|iphone|ipod|android|windows phone' then 'movil'
    else 'pc' end;
$$;

-- Distancia en metros entre dos puntos (haversine)
create or replace function public._distancia_m(_lat1 double precision, _lon1 double precision, _lat2 double precision, _lon2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(power(sin(radians(_lat2 - _lat1) / 2), 2)
         + cos(radians(_lat1)) * cos(radians(_lat2)) * power(sin(radians(_lon2 - _lon1) / 2), 2)));
$$;

-- Regla que aplica a un empleado: empleado > campaña > empresa
create or replace function public._politica_turno(_tenant uuid, _emp uuid)
returns public.shift_policies language sql stable security definer set search_path = public as $$
  select p.* from shift_policies p
  where p.tenant_id = _tenant and p.activo
    and ((p.alcance = 'empleado' and p.employee_id = _emp)
      or (p.alcance = 'campana' and p.campaign_id = (select e.campaign_id from employees e where e.id = _emp))
      or p.alcance = 'empresa')
  order by case p.alcance when 'empleado' then 1 when 'campana' then 2 else 3 end
  limit 1;
$$;

-- Valida IP, dispositivo y ubicación contra la regla. Devuelve {ok, fallas[], ...}
create or replace function public._validar_turno(_pol public.shift_policies, _ip text, _tipo text, _ubic jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  fallas text[] := '{}';
  v_ip_ok boolean;
  v_lat double precision; v_lon double precision; v_prec double precision;
  v_dist double precision; v_lugar text; u jsonb; d double precision;
begin
  if _pol.id is null then return jsonb_build_object('ok', true, 'fallas', '[]'::jsonb); end if;

  if cardinality(_pol.ips) > 0 then
    begin
      select exists (select 1 from unnest(_pol.ips) x where _ip::inet <<= x::inet) into v_ip_ok;
    exception when others then v_ip_ok := false;
    end;
    if not coalesce(v_ip_ok, false) then fallas := fallas || format('IP no autorizada (%s)', coalesce(_ip, 'sin IP')); end if;
  end if;

  if cardinality(_pol.dispositivos) > 0 and not coalesce(_tipo = any(_pol.dispositivos), false) then
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
      for u in select * from jsonb_array_elements(_pol.ubicaciones) loop
        d := public._distancia_m(v_lat, v_lon, (u->>'lat')::double precision, (u->>'lon')::double precision);
        if v_dist is null or d < v_dist then v_dist := d; v_lugar := u->>'nombre'; end if;
        -- dentro si la distancia (menos el margen de precisión del GPS, hasta 100 m) cabe en el radio
        if d - least(v_prec, 100) <= coalesce((u->>'radio_m')::double precision, 100) then v_lugar := u->>'nombre'; v_dist := d; exit; end if;
      end loop;
      if not exists (select 1 from jsonb_array_elements(_pol.ubicaciones) u2
                     where public._distancia_m(v_lat, v_lon, (u2->>'lat')::double precision, (u2->>'lon')::double precision)
                           - least(v_prec, 100) <= coalesce((u2->>'radio_m')::double precision, 100)) then
        fallas := fallas || format('Fuera de la ubicación autorizada (a %s m de %s)', round(v_dist)::text, coalesce(v_lugar, 'la más cercana'));
      end if;
    end if;
  elsif _pol.exigir_ubicacion and v_lat is null then
    fallas := fallas || 'Sin ubicación: la regla exige compartir la ubicación'::text;
  end if;

  return jsonb_build_object('ok', cardinality(fallas) = 0, 'fallas', to_jsonb(fallas), 'ip', _ip, 'dispositivo', _tipo,
                            'distancia_m', round(v_dist), 'ubicacion', v_lugar, 'regla', _pol.nombre, 'modo', _pol.modo);
end $$;

-- Usuarios de ciertos roles que cubren la campaña (supervisor/coordinador) o toda la empresa
create or replace function public._usuarios_roles_turno(_tenant uuid, _roles text[], _campaign uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct p.id), '{}')
  from profiles p
  join user_roles ur on ur.user_id = p.id
  join roles r on r.id = ur.role_id
  where p.is_active and coalesce(ur.tenant_id, p.tenant_id) = _tenant and r.code = any(_roles)
    and (r.code not in ('supervisor', 'coordinador') or ur.scope in ('mi_empresa', 'plataforma')
         or (_campaign is not null and _campaign = any(coalesce(ur.campaign_ids, '{}'))));
$$;

-- Registra una alarma (o repite la abierta del mismo tipo) y notifica a los roles de la regla
create or replace function public._alarma_turno(
  _tenant uuid, _sesion uuid, _usuario uuid, _emp uuid, _tipo text, _severidad text, _detalle text,
  _datos jsonb, _roles text[], _estado text default 'abierta')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_camp uuid; v_nombre text;
begin
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
end $$;

/* ============================== Inicio y fin ============================== */
drop function if exists public.iniciar_turno(jsonb);
drop function if exists public.finalizar_turno(jsonb);

create or replace function public.iniciar_turno(_datos jsonb default '{}'::jsonb, _token text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id(); v_emp uuid; v_pol public.shift_policies;
  v_red jsonb := public._red_solicitud(); v_tipo text; v_val jsonb; v public.work_sessions;
begin
  if auth.uid() is null then raise exception 'Inicia sesión para registrar tu turno'; end if;
  if v_tenant is null then raise exception 'Tu usuario no tiene empresa asignada'; end if;
  if octet_length(coalesce(_datos, '{}')::text) > 20000 then raise exception 'Datos del equipo demasiado grandes'; end if;
  if coalesce(length(_token), 0) < 20 then raise exception 'Falta la llave del dispositivo: recarga la página e intenta de nuevo'; end if;

  -- Un turno olvidado (más de 16 h abierto) se cierra solo; uno reciente impide abrir otro
  update work_sessions set ended_at = now(), cierre = 'automatico'
  where user_id = auth.uid() and ended_at is null and started_at < now() - interval '16 hours';
  if exists (select 1 from work_sessions where user_id = auth.uid() and ended_at is null) then
    return jsonb_build_object('ok', false, 'motivo', 'Ya tienes un turno iniciado: finalízalo antes de iniciar otro');
  end if;

  select id into v_emp from employees where user_id = auth.uid() and tenant_id = v_tenant limit 1;
  v_pol := public._politica_turno(v_tenant, v_emp);
  v_tipo := coalesce(public._tipo_dispositivo(v_red->>'navegador'), public._tipo_dispositivo(_datos#>>'{equipo,navegador}'));
  v_val := public._validar_turno(v_pol, v_red->>'ip', v_tipo, _datos->'ubicacion');

  if not (v_val->>'ok')::boolean and v_pol.modo = 'bloquear' then
    perform public._alarma_turno(v_tenant, null, auth.uid(), v_emp, 'inicio_bloqueado', 'alta',
      'Intentó iniciar turno fuera de la regla: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(v_val->'fallas') x),
      v_val || jsonb_build_object('equipo', _datos->'equipo', 'ubicacion', _datos->'ubicacion'), v_pol.alertar_roles, 'abierta');
    return jsonb_build_object('ok', false, 'motivo',
      'No puedes iniciar turno: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(v_val->'fallas') x), 'validacion', v_val);
  end if;

  insert into work_sessions (tenant_id, user_id, employee_id, inicio, policy_id, tipo_dispositivo, token_hash, ip_inicio, validacion)
  values (v_tenant, auth.uid(), v_emp,
          coalesce(_datos, '{}'::jsonb) || jsonb_build_object('red', v_red, 'hora_servidor', now()),
          v_pol.id, v_tipo, encode(extensions.digest(_token, 'sha256'), 'hex'), v_red->>'ip', v_val)
  returning * into v;

  if not (v_val->>'ok')::boolean then
    perform public._alarma_turno(v_tenant, v.id, auth.uid(), v_emp, 'inicio_fuera_de_regla', 'media',
      'Inició turno fuera de la regla: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(v_val->'fallas') x),
      v_val, v_pol.alertar_roles, 'abierta');
  end if;
  return jsonb_build_object('ok', true, 'id', v.id, 'started_at', v.started_at, 'max_horas', v_pol.max_horas,
                            'advertencias', v_val->'fallas');
end $$;

create or replace function public.finalizar_turno(_datos jsonb default '{}'::jsonb, _token text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v public.work_sessions; v_pol public.shift_policies; v_red jsonb := public._red_solicitud();
  v_tipo text; v_val jsonb; v_cambio text[] := '{}'; d double precision;
begin
  if auth.uid() is null then raise exception 'Inicia sesión para registrar tu turno'; end if;
  if octet_length(coalesce(_datos, '{}')::text) > 20000 then raise exception 'Datos del equipo demasiado grandes'; end if;
  select * into v from work_sessions where user_id = auth.uid() and ended_at is null for update;
  if v.id is null then return jsonb_build_object('ok', false, 'motivo', 'No tienes un turno iniciado'); end if;
  select * into v_pol from shift_policies where id = v.policy_id;
  v_tipo := coalesce(public._tipo_dispositivo(v_red->>'navegador'), public._tipo_dispositivo(_datos#>>'{equipo,navegador}'));

  -- Mismo dispositivo y navegador donde inició (los turnos anteriores a esta regla no tienen llave)
  if v.token_hash is not null and coalesce(v_pol.mismo_dispositivo_cierre, true)
     and v.token_hash is distinct from encode(extensions.digest(coalesce(_token, ''), 'sha256'), 'hex') then
    perform public._alarma_turno(v.tenant_id, v.id, auth.uid(), v.employee_id, 'cierre_otro_dispositivo', 'alta',
      format('Intentó finalizar el turno desde otro dispositivo o navegador (%s, IP %s)', coalesce(v_tipo, 'desconocido'), coalesce(v_red->>'ip', 'sin IP')),
      jsonb_build_object('equipo', _datos->'equipo', 'ip', v_red->>'ip', 'ubicacion', _datos->'ubicacion'),
      coalesce(v_pol.alertar_roles, '{supervisor,coordinador}'), 'abierta');
    return jsonb_build_object('ok', false, 'motivo',
      'Este turno se inició en otro dispositivo o navegador. Finalízalo desde ese mismo equipo o pide a tu supervisor un cierre autorizado.');
  end if;

  v_val := public._validar_turno(v_pol, v_red->>'ip', v_tipo, _datos->'ubicacion');
  if not (v_val->>'ok')::boolean and v_pol.modo = 'bloquear' then
    perform public._alarma_turno(v.tenant_id, v.id, auth.uid(), v.employee_id, 'cierre_bloqueado', 'alta',
      'Intentó finalizar fuera de la regla: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(v_val->'fallas') x),
      v_val, v_pol.alertar_roles, 'abierta');
    return jsonb_build_object('ok', false, 'motivo',
      'No puedes finalizar desde aquí: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(v_val->'fallas') x)
      || '. Vuelve a la ubicación o red autorizada, o pide un cierre autorizado.');
  end if;

  -- Cambios respecto al inicio (informativos): IP y ubicación
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
  -- Las alarmas de tiempo quedan atendidas al finalizar
  update shift_alerts set estado = 'atendida', atendida_at = now(), atendida_por = auth.uid()
  where session_id = v.id and estado = 'abierta' and tipo in ('turno_excedido', 'extra_excedida');

  if cardinality(v_cambio) > 0 then
    perform public._alarma_turno(v.tenant_id, v.id, auth.uid(), v.employee_id, 'cierre_fuera_de_regla', 'media',
      'Finalizó con diferencias: ' || array_to_string(v_cambio, '; '), coalesce(v_val, '{}'::jsonb),
      coalesce(v_pol.alertar_roles, '{}'), 'abierta');
  end if;
  return jsonb_build_object('ok', true, 'id', v.id, 'started_at', v.started_at, 'ended_at', v.ended_at,
                            'advertencias', to_jsonb(v_cambio));
end $$;

/* ============================== 4. Alarmas automáticas ============================== */
create or replace function public.revisar_alarmas_turno()
returns integer
language plpgsql security definer set search_path = public
as $$
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
    from work_sessions w left join shift_policies p on p.id = w.policy_id
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
end $$;

/* ============================== 5. Acciones del supervisor ============================== */
create or replace function public.gestionar_turno(_sesion uuid, _accion text, _horas numeric default null, _motivo text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v public.work_sessions; v_pol public.shift_policies; v_desde timestamptz; v_nombre text;
begin
  if not public.has_permission('inicio_turno', 'gestionar') then raise exception 'No tienes permiso para gestionar turnos'; end if;
  select * into v from work_sessions where id = _sesion for update;
  if v.id is null or not public.tenant_visible(v.tenant_id)
     or not (public.ve_toda_empresa() or v.employee_id = any(public.my_employee_ids())) then
    raise exception 'Turno no encontrado';
  end if;
  if v.ended_at is not null then raise exception 'El turno ya fue finalizado'; end if;
  select * into v_pol from shift_policies where id = v.policy_id;
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
end $$;

create or replace function public.atender_alarma_turno(_alarma uuid, _nota text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_permission('inicio_turno', 'gestionar') then raise exception 'No tienes permiso para gestionar turnos'; end if;
  update shift_alerts a set estado = 'atendida', atendida_at = now(), atendida_por = auth.uid(),
         datos = a.datos || jsonb_build_object('nota', nullif(trim(_nota), ''))
  where a.id = _alarma and a.estado = 'abierta' and public.tenant_visible(a.tenant_id)
    and (public.ve_toda_empresa() or a.employee_id = any(public.my_employee_ids()));
end $$;

/* ============================== Tablero ============================== */
create or replace function public.tablero_inicio_turno(_desde date, _hasta date)
returns table (
  id uuid, user_id uuid, employee_id uuid, empleado text, documento text, usuario text, campana text, supervisores text,
  inicio timestamptz, fin timestamptz, cierre text, motivo_cierre text, tipo_dispositivo text, ip_inicio text, ip_fin text,
  ubicacion jsonb, validacion jsonb, max_horas numeric, limite timestamptz, extra_autorizada_hasta timestamptz,
  extra_autorizada_horas numeric, estado text, avisos integer, alarmas_abiertas integer, regla text
)
language sql stable security definer set search_path = public
as $$
  select w.id, w.user_id, w.employee_id, e.full_name, e.document, coalesce(pr.full_name, pr.email), c.name,
         (select string_agg(s.nombre, ', ') from public.supervisores_campanas() s
           where s.todas or e.campaign_id = any(s.campaign_ids)),
         w.started_at, w.ended_at, w.cierre, w.motivo_cierre, w.tipo_dispositivo, w.ip_inicio, w.ip_fin,
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
         p.nombre
  from work_sessions w
  left join employees e on e.id = w.employee_id
  left join campaigns c on c.id = e.campaign_id
  left join profiles pr on pr.id = w.user_id
  left join shift_policies p on p.id = w.policy_id
  where (public.has_permission('inicio_turno', 'ver') or public.has_permission('registro_turnos', 'ver'))
    and public.tenant_visible(w.tenant_id)
    and (public.ve_toda_empresa() or w.employee_id = any(public.my_employee_ids()))
    and ((w.started_at at time zone 'America/Bogota')::date between _desde and _hasta or w.ended_at is null)
  order by (w.ended_at is null) desc, w.started_at desc;
$$;

/* ============================== Permisos de funciones ============================== */
revoke all on function public._tipo_dispositivo(text) from public, anon;
revoke all on function public._politica_turno(uuid, uuid) from public, anon, authenticated;
revoke all on function public._validar_turno(public.shift_policies, text, text, jsonb) from public, anon, authenticated;
revoke all on function public._usuarios_roles_turno(uuid, text[], uuid) from public, anon, authenticated;
revoke all on function public._alarma_turno(uuid, uuid, uuid, uuid, text, text, text, jsonb, text[], text) from public, anon, authenticated;
revoke all on function public.iniciar_turno(jsonb, text) from public, anon;
revoke all on function public.finalizar_turno(jsonb, text) from public, anon;
revoke all on function public.revisar_alarmas_turno() from public, anon;
revoke all on function public.gestionar_turno(uuid, text, numeric, text) from public, anon;
revoke all on function public.atender_alarma_turno(uuid, text) from public, anon;
revoke all on function public.tablero_inicio_turno(date, date) from public, anon;
grant execute on function public.iniciar_turno(jsonb, text) to authenticated;
grant execute on function public.finalizar_turno(jsonb, text) to authenticated;
grant execute on function public.revisar_alarmas_turno() to authenticated, service_role;
grant execute on function public.gestionar_turno(uuid, text, numeric, text) to authenticated;
grant execute on function public.atender_alarma_turno(uuid, text) to authenticated;
grant execute on function public.tablero_inicio_turno(date, date) to authenticated;

/* ============================== 6. Permisos ============================== */
insert into public.permissions (module, action, label)
select m, a, l from (values
  ('registro_turnos', 'configurar', 'Configurar reglas de turno (IP, ubicación, dispositivos, alarmas)'),
  ('inicio_turno', 'ver', 'Ver tablero de inicio de turno'),
  ('inicio_turno', 'gestionar', 'Gestionar turnos: avisar, autorizar horas extra, cierre autorizado')
) v(m, a, l)
where not exists (select 1 from public.permissions p where p.module = v.m and p.action = v.a);

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on
     (p.module = 'registro_turnos' and p.action = 'configurar' and r.code in ('admin', 'nomina'))
  or (p.module = 'inicio_turno' and p.action in ('ver', 'gestionar') and r.code in ('admin', 'nomina', 'supervisor', 'coordinador'))
where not exists (select 1 from public.role_permissions x where x.role_id = r.id and x.permission_id = p.id);

notify pgrst, 'reload schema';
