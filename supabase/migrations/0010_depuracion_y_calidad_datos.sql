
insert into public.permissions(module, action, label) values
 ('datos','ver','Ver calidad de datos'),
 ('datos','depurar','Borrar u ocultar datos por fechas')
on conflict do nothing;

alter table public.biometric_events add column if not exists oculto boolean not null default false;
alter table public.attendance_daily add column if not exists oculto boolean not null default false;
alter table public.novelty_entries add column if not exists oculto boolean not null default false;

create table public.data_cleanups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  desde date not null,
  hasta date not null,
  modo text not null,
  alcance text[] not null default '{}',
  filas integer not null default 0,
  revertido boolean not null default false,
  motivo text,
  created_by uuid,
  created_at timestamptz not null default now()
);
grant select on public.data_cleanups to authenticated;
grant all on public.data_cleanups to service_role;
alter table public.data_cleanups enable row level security;
create policy "depuraciones lectura" on public.data_cleanups for select to authenticated
 using (public.tenant_visible(tenant_id) and (public.has_permission('datos','ver') or public.has_permission('datos','depurar')));

drop policy "eventos lectura" on public.biometric_events;
create policy "eventos lectura" on public.biometric_events for select using (
 not oculto and ((( select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
 and ((select public.ve_toda_empresa()) or array[document] <@ (select public.my_documents()))));

drop policy "asistencia lectura" on public.attendance_daily;
create policy "asistencia lectura" on public.attendance_daily for select using (
 not oculto and ((( select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
 and ((select public.ve_toda_empresa()) or array[employee_id] <@ (select public.my_employee_ids()))));

drop policy "novedades lectura" on public.novelty_entries;
create policy "novedades lectura" on public.novelty_entries for select using (
 not oculto and ((( select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
 and (select public.has_permission('novedades','ver'))
 and ((select public.ve_toda_empresa()) or array[document] <@ (select public.my_documents()))));

create or replace function public.depurar_datos(_tenant uuid, _user uuid, _desde date, _hasta date, _modo text, _alcance text[], _motivo text)
returns integer language plpgsql security definer set search_path = public set statement_timeout = '300s' as $$
declare n integer := 0; k integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'No autorizado'; end if;
  if _modo not in ('eliminar','ocultar','mostrar') then raise exception 'Modo inválido'; end if;
  if _hasta < _desde then raise exception 'Rango inválido'; end if;
  if 'marcaciones' = any(_alcance) then
    if _modo = 'eliminar' then
      delete from biometric_events where tenant_id=_tenant and event_at >= _desde and event_at < _hasta + 1;
    else
      update biometric_events set oculto = (_modo='ocultar') where tenant_id=_tenant and event_at >= _desde and event_at < _hasta + 1 and oculto <> (_modo='ocultar');
    end if;
    get diagnostics k = row_count; n := n + k;
  end if;
  if 'asistencia' = any(_alcance) then
    if _modo = 'eliminar' then
      delete from attendance_adjustments where attendance_id in (select id from attendance_daily where tenant_id=_tenant and work_date between _desde and _hasta);
      delete from attendance_daily where tenant_id=_tenant and work_date between _desde and _hasta;
    else
      update attendance_daily set oculto = (_modo='ocultar') where tenant_id=_tenant and work_date between _desde and _hasta and oculto <> (_modo='ocultar');
    end if;
    get diagnostics k = row_count; n := n + k;
  end if;
  if 'novedades' = any(_alcance) then
    if _modo = 'eliminar' then
      delete from novelty_entries where tenant_id=_tenant and work_date between _desde and _hasta;
    else
      update novelty_entries set oculto = (_modo='ocultar') where tenant_id=_tenant and work_date between _desde and _hasta and oculto <> (_modo='ocultar');
    end if;
    get diagnostics k = row_count; n := n + k;
  end if;
  insert into data_cleanups(tenant_id, desde, hasta, modo, alcance, filas, motivo, created_by)
    values (_tenant, _desde, _hasta, _modo, _alcance, n, _motivo, _user);
  insert into audit_logs(tenant_id, user_id, module, action, new_value, reason)
    values (_tenant, _user, 'datos', _modo, jsonb_build_object('desde',_desde,'hasta',_hasta,'alcance',_alcance,'filas',n), _motivo);
  return n;
end $$;
revoke all on function public.depurar_datos(uuid,uuid,date,date,text,text[],text) from public, anon, authenticated;
grant execute on function public.depurar_datos(uuid,uuid,date,date,text,text[],text) to service_role;

create or replace function public.calidad_datos(_desde date, _hasta date)
returns jsonb language sql stable security invoker set search_path = public as $$
  with ev as (
    select * from biometric_events where event_at >= _desde and event_at < _hasta + 1
  ),
  dias as (
    select event_at::date as dia,
      count(*) as eventos,
      count(*) filter (where is_attendance) as validas,
      count(*) filter (where is_duplicate) as duplicadas,
      count(*) filter (where document is null) as sin_documento,
      count(*) filter (where not is_attendance and document is not null) as no_validas,
      count(distinct import_id) as archivos,
      count(distinct document) filter (where is_attendance) as personas
    from ev group by 1
  ),
  asis as (
    select work_date as dia,
      count(*) filter (where status='completa') as completas,
      count(*) filter (where status='incompleta') as incompletas
    from attendance_daily where work_date between _desde and _hasta group by 1
  ),
  arch as (
    select i.id, i.filename, i.status, i.rows_found, i.started_at,
      count(e.id) as aportadas,
      min(e.event_at)::date as desde, max(e.event_at)::date as hasta
    from biometric_imports i join ev e on e.import_id = i.id
    group by i.id
  )
  select jsonb_build_object(
    'resumen', (select jsonb_build_object(
        'eventos', count(*), 'validas', count(*) filter (where is_attendance),
        'duplicadas', count(*) filter (where is_duplicate),
        'sin_documento', count(*) filter (where document is null),
        'sin_empleado', count(*) filter (where document is not null and employee_id is null),
        'archivos', count(distinct import_id),
        'personas', count(distinct document) filter (where is_attendance)) from ev),
    'empleados_sin_nombre', (select count(*) from employees where full_name ilike 'SIN NOMBRE%'),
    'dispositivos_sin_confirmar', (select count(*) from devices where not confirmed),
    'dias', coalesce((select jsonb_agg(jsonb_build_object('dia',d.dia,'eventos',d.eventos,'validas',d.validas,'duplicadas',d.duplicadas,
        'sin_documento',d.sin_documento,'no_validas',d.no_validas,'archivos',d.archivos,'personas',d.personas,
        'completas',coalesce(a.completas,0),'incompletas',coalesce(a.incompletas,0)) order by d.dia desc)
      from dias d left join asis a on a.dia=d.dia), '[]'::jsonb),
    'archivos', coalesce((select jsonb_agg(to_jsonb(arch) order by arch.desde) from arch), '[]'::jsonb)
  );
$$;
grant execute on function public.calidad_datos(date,date) to authenticated;
