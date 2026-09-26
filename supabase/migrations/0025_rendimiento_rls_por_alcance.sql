-- Migración 0025: Rendimiento de la seguridad por alcance (usuarios que no son administradores)
-- Problema medido: un supervisor tardaba > 4 s en contar el control diario de un mes (y el panel
-- superaba el límite de 8 s). Causas:
--  1. Las políticas «gestión» eran FOR ALL, así que también se evaluaban al LEER y llamaban
--     tenant_visible(tenant_id) fila por fila (~0,5 ms por fila).
--  2. Las vistas leían la regla «incluir personal sin empleador» con un LATERAL por fila,
--     pasando otra vez por la RLS de rules en cada fila.
-- Solución: las políticas de gestión solo aplican a INSERT/UPDATE/DELETE (la lectura la limita
-- la política de lectura, que define el alcance) y la regla se lee una sola vez por consulta.

-- 1. Dividir cada política FOR ALL en INSERT / UPDATE / DELETE (mismas condiciones)
do $$
declare p record; usar text; revisar text;
begin
  for p in select * from pg_policies where schemaname = 'public' and cmd = 'ALL' loop
    usar := coalesce(p.qual, 'true');
    revisar := coalesce(p.with_check, p.qual, 'true');
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)', p.policyname || ' (crear)', p.tablename, revisar);
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', p.policyname || ' (editar)', p.tablename, usar, revisar);
    execute format('create policy %I on public.%I for delete to authenticated using (%s)', p.policyname || ' (eliminar)', p.tablename, usar);
  end loop;
end $$;

-- 2. Regla de la empresa actual, leída una vez (definer: sin pasar por la RLS de rules)
create or replace function public.incluye_sin_empresa()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (value#>>'{}')::boolean from public.rules
                   where tenant_id = public.current_tenant_id() and key = 'reportes_incluir_sin_empresa'), true);
$$;
grant execute on function public.incluye_sin_empresa() to authenticated, service_role;

create or replace view public.asistencia_reporte with (security_invoker = true) as
select a.id, a.tenant_id, a.employee_id, a.work_date, a.shift_id, a.first_in, a.last_out,
       a.worked_minutes, a.expected_minutes, a.late_minutes, a.status, a.overtime_minutes,
       a.night_minutes, a.sunday_holiday_minutes, a.is_rest_day, a.is_manual, a.notes,
       e.document, e.full_name, e.position, e.employer_id, e.biometric_group,
       em.name as employer_name, c.name as campaign_name, s.name as shift_name,
       case when e.employer_id is null then (select public.incluye_sin_empresa())
            else coalesce(em.include_in_reports, true) end as en_reportes,
       a.first_in::time as hora_entrada, a.last_out::time as hora_salida,
       e.campaign_id, a.overtime_night_minutes, cc.name as cost_center_name
from public.attendance_daily a
join public.employees e on e.id = a.employee_id
left join public.employers em on em.id = e.employer_id
left join public.campaigns c on c.id = e.campaign_id
left join public.cost_centers cc on cc.id = e.cost_center_id
left join public.shifts s on s.id = a.shift_id;
grant select on public.asistencia_reporte to authenticated, service_role;

create or replace view public.marcaciones_reporte with (security_invoker = true) as
select b.id, b.tenant_id, b.import_id, b.event_at, b.door, b.device_code, b.device_name, b.user_group,
       b.raw_user, b.document, b.biometric_name, b.event_type, b.is_attendance, b.is_duplicate,
       b.employee_id, e.employer_id, em.name as employer_name,
       case when e.id is null then true
            when e.employer_id is null then (select public.incluye_sin_empresa())
            else coalesce(em.include_in_reports, true) end as en_reportes
from public.biometric_events b
left join public.employees e on e.id = b.employee_id
left join public.employers em on em.id = e.employer_id;
grant select on public.marcaciones_reporte to authenticated, service_role;

-- 3. Campañas: además de las asignadas, cada persona ve la campaña de su propio empleado
create or replace function public.mis_campanas_propias()
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct campaign_id) filter (where campaign_id is not null), '{}')
  from public.employees where user_id = auth.uid();
$$;
grant execute on function public.mis_campanas_propias() to authenticated;

drop policy if exists "campanas lectura" on public.campaigns;
create policy "campanas lectura" on public.campaigns for select to authenticated using (
  ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  and ((select public.ve_toda_empresa())
       or id in (select unnest(public.my_campaign_ids()))
       or id in (select unnest(public.mis_campanas_propias())))
);
