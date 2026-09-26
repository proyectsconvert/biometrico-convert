-- Migración 0023: Columnas para ordenar el control diario por hora de entrada/salida
-- (first_in/last_out incluyen la fecha; para ordenar por la hora del día se exponen aparte).
create or replace view public.asistencia_reporte with (security_invoker = true) as
select a.id, a.tenant_id, a.employee_id, a.work_date, a.shift_id, a.first_in, a.last_out,
       a.worked_minutes, a.expected_minutes, a.late_minutes, a.status, a.overtime_minutes,
       a.night_minutes, a.sunday_holiday_minutes, a.is_rest_day, a.is_manual, a.notes,
       e.document, e.full_name, e.position, e.employer_id, e.biometric_group,
       em.name as employer_name, c.name as campaign_name, s.name as shift_name,
       case when e.employer_id is null then coalesce(cfg.sin_empresa, true)
            else coalesce(em.include_in_reports, true) end as en_reportes,
       a.first_in::time as hora_entrada, a.last_out::time as hora_salida
from public.attendance_daily a
join public.employees e on e.id = a.employee_id
left join public.employers em on em.id = e.employer_id
left join public.campaigns c on c.id = e.campaign_id
left join public.shifts s on s.id = a.shift_id
left join lateral (
  select (r.value#>>'{}')::boolean as sin_empresa from public.rules r
  where r.tenant_id = a.tenant_id and r.key = 'reportes_incluir_sin_empresa'
) cfg on true;
grant select on public.asistencia_reporte to authenticated, service_role;
