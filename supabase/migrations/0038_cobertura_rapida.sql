-- Cobertura del histórico en segundos: días y personas salen de las jornadas calculadas
-- (≈134 mil filas) en vez de recorrer millones de eventos, que superaba el límite de 8 s.
create or replace function public.cobertura_historico()
returns table (mes date, dias_mes integer, dias_con_datos integer, dias_sin_datos date[], personas bigint, archivos bigint)
language sql stable security invoker set search_path = public as $$
  with dias as (
    select work_date as dia, count(distinct employee_id) personas from attendance_daily group by 1
  ), arch as (
    select date_trunc('month', event_at)::date mes, count(distinct import_id) archivos
    from biometric_events where is_attendance group by 1
  ), meses as (
    select date_trunc('month', dia)::date as mes, count(*)::int con_datos, max(personas) personas
    from dias group by 1
  )
  select m.mes,
         extract(day from (m.mes + interval '1 month - 1 day'))::int,
         m.con_datos,
         array(select g::date from generate_series(m.mes, (m.mes + interval '1 month - 1 day')::date, interval '1 day') g
               where not exists (select 1 from dias x where x.dia = g::date) order by 1),
         m.personas, coalesce(a.archivos, 0)
  from meses m left join arch a on a.mes = m.mes order by m.mes desc;
$$;
grant execute on function public.cobertura_historico() to authenticated;
