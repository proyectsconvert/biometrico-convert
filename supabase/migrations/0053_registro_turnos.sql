-- Migración 0053: Registro de inicio y fin de turno desde la aplicación
-- 1. work_sessions: cada inicio/fin de turno con la hora del servidor, el equipo, la red (IP que ve
--    Cloudflare) y la ubicación que comparta el navegador. Solo se escribe por funciones: nadie
--    puede inventar ni editar horas.
-- 2. iniciar_turno / finalizar_turno: un solo turno abierto por usuario. Un turno que quedó abierto
--    más de 16 h se cierra solo al iniciar el siguiente (queda marcado «sin cierre»).
-- 3. reporte_registro_turnos: cruza cada turno con el biométrico del día (primera y última marca):
--    tiempo conectado frente a tiempo en la empresa y alarmas, p. ej. iniciar turno antes de marcar
--    la huella de entrada o finalizarlo después de la salida.
-- 4. Permiso «registro_turnos» (ver, exportar) para Administración, Nómina, Coordinación y
--    Supervisión (estos dos solo ven a su personal). Reglas: zona horaria y tolerancia.

/* ---------- 1. Tabla ---------- */
create table if not exists public.work_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- 'usuario' = lo finalizó la persona; 'automatico' = quedó abierto y se cerró al iniciar otro
  cierre text check (cierre in ('usuario', 'automatico')),
  inicio jsonb not null default '{}'::jsonb,
  fin jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists work_sessions_un_abierto on public.work_sessions (user_id) where ended_at is null;
create index if not exists work_sessions_tenant_inicio on public.work_sessions (tenant_id, started_at);
create index if not exists work_sessions_empleado_inicio on public.work_sessions (employee_id, started_at);

alter table public.work_sessions enable row level security;
drop policy if exists "registro turnos lectura" on public.work_sessions;
create policy "registro turnos lectura" on public.work_sessions for select
  using (
    user_id = auth.uid()
    or (public.tenant_visible(tenant_id) and public.has_permission('registro_turnos', 'ver')
        and (public.ve_toda_empresa() or employee_id = any(public.my_employee_ids())))
  );
-- Solo por funciones (hora del servidor, sin ediciones)
revoke insert, update, delete, truncate on public.work_sessions from authenticated, anon;
grant select on public.work_sessions to authenticated;

/* ---------- 2. Red que ve el servidor (no la declara el navegador) ---------- */
create or replace function public._red_solicitud()
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare h jsonb;
begin
  begin
    h := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  exception when others then h := '{}'::jsonb;
  end;
  return jsonb_strip_nulls(jsonb_build_object(
    'ip', coalesce(h->>'cf-connecting-ip', h->>'x-real-ip', trim(split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1))),
    'pais', h->>'cf-ipcountry',
    'ciudad', h->>'cf-ipcity',
    'region', h->>'cf-region',
    'navegador', h->>'user-agent'
  ));
end $$;

/* ---------- 3. Iniciar y finalizar ---------- */
create or replace function public.iniciar_turno(_datos jsonb default '{}'::jsonb)
returns public.work_sessions
language plpgsql
security definer
set search_path = public
as $$
declare v_tenant uuid := public.current_tenant_id(); v_emp uuid; v public.work_sessions;
begin
  if auth.uid() is null then raise exception 'Inicia sesión para registrar tu turno'; end if;
  if v_tenant is null then raise exception 'Tu usuario no tiene empresa asignada'; end if;
  if octet_length(coalesce(_datos, '{}')::text) > 20000 then raise exception 'Datos del equipo demasiado grandes'; end if;

  -- Un turno olvidado (más de 16 h abierto) se cierra solo; uno reciente impide abrir otro
  update work_sessions set ended_at = now(), cierre = 'automatico'
  where user_id = auth.uid() and ended_at is null and started_at < now() - interval '16 hours';
  if exists (select 1 from work_sessions where user_id = auth.uid() and ended_at is null) then
    raise exception 'Ya tienes un turno iniciado: finalízalo antes de iniciar otro';
  end if;

  select id into v_emp from employees where user_id = auth.uid() and tenant_id = v_tenant limit 1;
  insert into work_sessions (tenant_id, user_id, employee_id, inicio)
  values (v_tenant, auth.uid(), v_emp,
          coalesce(_datos, '{}'::jsonb) || jsonb_build_object('red', public._red_solicitud(), 'hora_servidor', now()))
  returning * into v;
  return v;
end $$;

create or replace function public.finalizar_turno(_datos jsonb default '{}'::jsonb)
returns public.work_sessions
language plpgsql
security definer
set search_path = public
as $$
declare v public.work_sessions;
begin
  if auth.uid() is null then raise exception 'Inicia sesión para registrar tu turno'; end if;
  if octet_length(coalesce(_datos, '{}')::text) > 20000 then raise exception 'Datos del equipo demasiado grandes'; end if;
  update work_sessions set ended_at = now(), cierre = 'usuario',
         fin = coalesce(_datos, '{}'::jsonb) || jsonb_build_object('red', public._red_solicitud(), 'hora_servidor', now())
  where user_id = auth.uid() and ended_at is null
  returning * into v;
  if v.id is null then raise exception 'No tienes un turno iniciado'; end if;
  return v;
end $$;

/* ---------- 4. Cruce con el biométrico ---------- */
-- ¿Ya se cargaron marcaciones de ese día? (sin el filtro de alcance: solo distingue «sin huella» de
-- «biométrico aún no cargado», no expone datos)
create or replace function public._hay_biometrico_dia(_tenant uuid, _dia date)
returns boolean
language sql
stable
security definer
set search_path = public
as $f$
  select exists (select 1 from biometric_events b
                 where b.tenant_id = _tenant and b.event_at >= _dia and b.event_at < _dia + 1);
$f$;

create or replace function public.reporte_registro_turnos(_desde date, _hasta date)
returns table (
  id uuid, fecha date, usuario text, email text, documento text, empleado text, campana text,
  inicio timestamp, fin timestamp, cierre text, minutos_conectado integer,
  entrada_biometrico timestamp, salida_biometrico timestamp, minutos_en_empresa integer,
  minutos_inicio_vs_entrada integer, minutos_fin_vs_salida integer,
  alarmas text[], avisos text[], inicio_datos jsonb, fin_datos jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  with cfg as (
    select coalesce((select value#>>'{}' from rules where key = 'zona_horaria' and tenant_id = public.current_tenant_id()), 'America/Bogota') as tz,
           coalesce((select (value#>>'{}')::numeric from rules where key = 'tolerancia_registro_turno_min' and tenant_id = public.current_tenant_id()), 0) as tol
  ),
  s as (
    select w.*, (w.started_at at time zone cfg.tz) as ini_local,
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
$$;

revoke all on function public._red_solicitud() from public, anon, authenticated;
revoke all on function public._hay_biometrico_dia(uuid, date) from public, anon;
grant execute on function public._hay_biometrico_dia(uuid, date) to authenticated;
revoke all on function public.iniciar_turno(jsonb) from public, anon;
revoke all on function public.finalizar_turno(jsonb) from public, anon;
revoke all on function public.reporte_registro_turnos(date, date) from public, anon;
grant execute on function public.iniciar_turno(jsonb) to authenticated;
grant execute on function public.finalizar_turno(jsonb) to authenticated;
grant execute on function public.reporte_registro_turnos(date, date) to authenticated;

/* ---------- 5. Permisos y reglas ---------- */
insert into public.permissions (module, action, label)
select m, a, l from (values
  ('registro_turnos', 'ver', 'Ver registro de turnos'),
  ('registro_turnos', 'exportar', 'Exportar registro de turnos')
) v(m, a, l)
where not exists (select 1 from public.permissions p where p.module = v.m and p.action = v.a);

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.module = 'registro_turnos' and p.action in ('ver', 'exportar')
where r.code in ('admin', 'nomina', 'coordinador', 'supervisor')
  and not exists (select 1 from public.role_permissions x where x.role_id = r.id and x.permission_id = p.id);

insert into public.rules (tenant_id, key, value, description, updated_at)
select t.id, k, v, d, now() from public.tenants t,
  (values ('zona_horaria', '"America/Bogota"'::jsonb, 'Zona horaria para cruzar el registro de turnos con el biométrico'),
          ('tolerancia_registro_turno_min', '0'::jsonb, 'Minutos de tolerancia entre la huella y el inicio o fin de turno')) r(k, v, d)
where not exists (select 1 from public.rules x where x.tenant_id = t.id and x.key = r.k);

notify pgrst, 'reload schema';
