-- Migración 0047: Malla diaria de turnos (programación por persona y día)
-- La malla guarda, para cada persona y fecha, su horario (ingreso/salida) o una novedad
-- (DESCANSO, VACACIONES, INCAPACIDAD, ...). Tiene prioridad sobre las rotaciones y los
-- horarios fijos. Se llena desde la plataforma o cargando la plantilla de Excel.
-- Cada par ingreso/salida usa un horario del catálogo de la campaña; si no existe se crea.

create table if not exists public.shift_schedule (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  fecha date not null,
  shift_id uuid references public.shifts(id) on delete restrict,
  novedad text,
  nota text,
  origen text not null default 'manual' check (origen in ('manual','plantilla')),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (employee_id, fecha),
  check ((shift_id is null) <> (novedad is null))
);
create index if not exists shift_schedule_tenant_fecha on public.shift_schedule (tenant_id, fecha);
grant select on public.shift_schedule to authenticated;
grant all on public.shift_schedule to service_role;
alter table public.shift_schedule enable row level security;
create policy "malla lectura" on public.shift_schedule for select
  using (((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
     and ((select public.ve_toda_empresa()) or array[employee_id] <@ (select public.my_employee_ids())));

-- Novedades válidas en la malla (formato de mallas de las campañas)
create or replace function public.novedades_malla()
returns text[] language sql immutable as $$
  select array['DESCANSO','VACACIONES','INCAPACIDAD','DIA DE LA FAMILIA','LICENCIA DE MATERNIDAD','LICENCIA DE PATERNIDAD',
               'LICENCIA DE LUTO','FESTIVO','LICENCIA REMUNERADA','LICENCIA NO REMUNERADA','PERMISO','CALAMIDAD DOMESTICA','SUSPENSION'];
$$;
grant execute on function public.novedades_malla() to authenticated;
alter table public.shift_schedule add constraint shift_schedule_novedad_valida check (novedad is null or novedad = any(public.novedades_malla()));

/* ---------- Turno programado: malla > asignación (rotación u horario fijo) ---------- */
drop function if exists public.turnos_programados(date[], uuid[]);
drop function if exists public._turnos_programados(uuid, date[], uuid[]);

create function public._turnos_programados(_tenant uuid, _fechas date[], _empleados uuid[] default null)
returns table(employee_id uuid, fecha date, shift_id uuid, laborable boolean, assignment_id uuid, rotation_id uuid, semana integer, novedad text, origen text)
language sql stable security definer set search_path = public as $$
  with malla as (
    select m.employee_id, m.fecha, m.shift_id, m.shift_id is not null as laborable,
           null::uuid as assignment_id, null::uuid as rotation_id, null::int as semana, m.novedad, 'malla'::text as origen
    from public.shift_schedule m
    where m.tenant_id = _tenant and m.fecha = any(_fechas) and (_empleados is null or m.employee_id = any(_empleados))
  ), asignado as (
    select distinct on (x.employee_id, x.fecha)
           x.employee_id, x.fecha, sh.id as shift_id, extract(dow from x.fecha)::int = any(sh.workdays) as laborable,
           x.id as assignment_id, x.rotation_id, x.semana, null::text as novedad,
           case when x.rotation_id is null then 'fijo' else 'rotacion' end as origen
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
    order by x.employee_id, x.fecha, x.start_date desc, x.created_at desc
  )
  select * from malla
  union all
  select a.* from asignado a
  where not exists (select 1 from malla m where m.employee_id = a.employee_id and m.fecha = a.fecha);
$$;
revoke execute on function public._turnos_programados(uuid, date[], uuid[]) from public, anon, authenticated;
grant execute on function public._turnos_programados(uuid, date[], uuid[]) to service_role;

create function public.turnos_programados(_fechas date[], _empleados uuid[] default null)
returns table(employee_id uuid, fecha date, shift_id uuid, laborable boolean, assignment_id uuid, rotation_id uuid, semana integer, novedad text, origen text)
language plpgsql stable security definer set search_path = public as $$
begin
  if cardinality(_fechas) > 93 then raise exception 'Máximo 93 fechas por consulta'; end if;
  return query
    select t.* from public._turnos_programados(public.current_tenant_id(), _fechas, _empleados) t
    where public.ve_toda_empresa() or t.employee_id = any(public.my_employee_ids());
end $$;
grant execute on function public.turnos_programados(date[], uuid[]) to authenticated;

/* ---------- Guardar la malla (desde la plataforma o la plantilla) ---------- */
-- _filas: [{fila, documento | employee_id, fecha, ingreso 'HH:MM', salida 'HH:MM', novedad, nota, borrar}]
-- Con _solo_validar devuelve el resumen y los errores sin guardar nada.
create or replace function public.guardar_malla(_filas jsonb, _solo_validar boolean default false, _origen text default 'manual')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_res jsonb; v_creados int := 0; v_guardados int := 0; v_borrados int := 0;
begin
  if not public.has_permission('turnos','asignar') then raise exception 'No tienes permiso para programar turnos'; end if;
  if jsonb_typeof(_filas) <> 'array' then raise exception 'Formato de filas no válido'; end if;
  if jsonb_array_length(_filas) > 25000 then raise exception 'Máximo 25.000 días por carga'; end if;

  drop table if exists pg_temp._malla;
  create temp table _malla on commit drop as
  select x.fila, nullif(trim(x.documento), '') as documento, x.employee_id as emp_param, x.fecha,
         nullif(trim(x.ingreso), '') as ingreso_txt, nullif(trim(x.salida), '') as salida_txt,
         nullif(upper(trim(x.novedad)), '') as novedad, nullif(trim(x.nota), '') as nota, coalesce(x.borrar, false) as borrar,
         null::uuid as employee_id, null::text as nombre, null::uuid as campaign_id, null::time as ingreso, null::time as salida,
         null::uuid as shift_id, null::text as error
  from jsonb_to_recordset(_filas) x(fila int, documento text, employee_id uuid, fecha date, ingreso text, salida text, novedad text, nota text, borrar boolean);

  update _malla m set employee_id = e.id, nombre = e.full_name, campaign_id = e.campaign_id,
         error = case when e.status <> 'activo' then 'La persona está inactiva: solicita su activación en Empleados'
                      when not (public.ve_toda_empresa() or e.id = any(public.my_employee_ids())) then 'La persona no es de tus campañas' end
  from public.employees e
  where e.tenant_id = v_tenant and (e.id = m.emp_param or (m.emp_param is null and e.document = m.documento));

  update _malla set error = coalesce(error, case
      when employee_id is null then 'El documento no existe en Empleados'
      when fecha is null then 'Fecha no válida'
      when borrar then null
      when novedad is not null and not (novedad = any(public.novedades_malla())) then 'Novedad no reconocida: ' || novedad
      when novedad is not null then null
      when ingreso_txt is null or salida_txt is null then 'Falta la hora de ' || case when ingreso_txt is null then 'ingreso' else 'salida' end
      when ingreso_txt !~ '^\d{1,2}:\d{2}(:\d{2})?$' or salida_txt !~ '^\d{1,2}:\d{2}(:\d{2})?$' then 'Hora no válida (usa HH:MM, 24 horas)'
      when split_part(ingreso_txt, ':', 1)::int > 23 or split_part(salida_txt, ':', 1)::int > 23 then 'Hora no válida (usa HH:MM, 24 horas)'
      when ingreso_txt::time = salida_txt::time then 'La hora de ingreso y salida son iguales' end)
  where true; -- la API exige WHERE en todo UPDATE
  update _malla set ingreso = ingreso_txt::time, salida = salida_txt::time
   where error is null and not borrar and novedad is null;

  -- Un mismo día repetido en la carga
  update _malla m set error = 'Día repetido en la carga (fila ' || d.primera || ')'
  from (select employee_id, fecha, min(fila) as primera, count(*) as n from _malla where error is null group by 1, 2 having count(*) > 1) d
  where m.error is null and m.employee_id = d.employee_id and m.fecha = d.fecha and m.fila > d.primera;

  -- Horario existente de la campaña (o general) con esas horas
  update _malla m set shift_id = (
      select s.id from public.shifts s
      where s.tenant_id = v_tenant and s.status = 'activo' and s.start_time = m.ingreso and s.end_time = m.salida
        and (s.campaign_id is not distinct from m.campaign_id or s.campaign_id is null)
      order by s.campaign_id is null, s.created_at limit 1)
  where m.error is null and m.ingreso is not null;

  if _solo_validar then
    select jsonb_build_object(
      'total', count(*),
      'validas', count(*) filter (where error is null),
      'personas', count(distinct employee_id) filter (where error is null),
      'con_horario', count(*) filter (where error is null and ingreso is not null),
      'novedades', count(*) filter (where error is null and novedad is not null),
      'a_borrar', count(*) filter (where error is null and borrar),
      'horarios_nuevos', (select count(*) from (select distinct campaign_id, ingreso, salida from _malla where error is null and ingreso is not null and shift_id is null) z),
      'desde', min(fecha) filter (where error is null), 'hasta', max(fecha) filter (where error is null),
      'errores', coalesce((select jsonb_agg(jsonb_build_object('fila', fila, 'documento', documento, 'nombre', nombre, 'fecha', fecha, 'error', error) order by fila, fecha)
                           from (select * from _malla where error is not null order by fila, fecha limit 500) e), '[]'))
    into v_res from _malla;
    return v_res;
  end if;

  -- Crear los horarios que faltan, en la campaña de cada persona
  with nuevos as (
    select distinct campaign_id, ingreso, salida from _malla where error is null and ingreso is not null and shift_id is null
  ), ins as (
    insert into public.shifts (tenant_id, campaign_id, code, name, start_time, end_time, crosses_midnight, workdays, color, break_minutes)
    select v_tenant, n.campaign_id,
           to_char(n.ingreso, 'HH24MI') || '-' || to_char(n.salida, 'HH24MI'),
           to_char(n.ingreso, 'HH24:MI') || ' – ' || to_char(n.salida, 'HH24:MI'),
           n.ingreso, n.salida, n.salida < n.ingreso, '{0,1,2,3,4,5,6}',
           (array['#2563eb','#16a34a','#ea580c','#9333ea','#db2777','#0891b2','#ca8a04','#64748b'])[1 + (extract(hour from n.ingreso)::int % 8)], 0
    from nuevos n
    on conflict (tenant_id, campaign_id, code) do nothing
    returning id
  )
  select count(*) into v_creados from ins;

  update _malla m set shift_id = (
      select s.id from public.shifts s
      where s.tenant_id = v_tenant and s.start_time = m.ingreso and s.end_time = m.salida
        and (s.campaign_id is not distinct from m.campaign_id or s.campaign_id is null)
      order by s.status = 'activo' desc, s.campaign_id is null, s.created_at limit 1)
  where m.error is null and m.ingreso is not null and m.shift_id is null;

  delete from public.shift_schedule s using _malla m
   where m.error is null and m.borrar and s.employee_id = m.employee_id and s.fecha = m.fecha;
  get diagnostics v_borrados = row_count;

  insert into public.shift_schedule as s (tenant_id, employee_id, fecha, shift_id, novedad, nota, origen, created_by, updated_at)
  select v_tenant, employee_id, fecha, case when novedad is null then shift_id end, novedad, nota,
         case when _origen = 'plantilla' then 'plantilla' else 'manual' end, auth.uid(), now()
  from _malla where error is null and not borrar and (novedad is not null or shift_id is not null)
  on conflict (employee_id, fecha) do update
    set shift_id = excluded.shift_id, novedad = excluded.novedad, nota = coalesce(excluded.nota, s.nota),
        origen = excluded.origen, created_by = excluded.created_by, updated_at = now();
  get diagnostics v_guardados = row_count;

  select jsonb_build_object(
    'guardados', v_guardados, 'borrados', v_borrados, 'horarios_creados', v_creados,
    'personas', count(distinct employee_id) filter (where error is null),
    'desde', min(fecha) filter (where error is null), 'hasta', max(fecha) filter (where error is null),
    'errores', coalesce((select jsonb_agg(jsonb_build_object('fila', fila, 'documento', documento, 'nombre', nombre, 'fecha', fecha, 'error', error) order by fila, fecha)
                         from (select * from _malla where error is not null order by fila, fecha limit 500) e), '[]'))
  into v_res from _malla;

  insert into public.audit_logs (tenant_id, user_id, module, action, new_value)
  values (v_tenant, auth.uid(), 'turnos', case when _origen = 'plantilla' then 'cargar_malla' else 'programar_malla' end, v_res - 'errores');
  return v_res;
end $$;
grant execute on function public.guardar_malla(jsonb, boolean, text) to authenticated;
