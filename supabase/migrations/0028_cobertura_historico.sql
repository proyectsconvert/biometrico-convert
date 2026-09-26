-- Migración 0028: Cobertura del histórico de marcaciones por mes (qué días tienen datos cargados)
create or replace function public.cobertura_historico()
returns table (mes date, dias_mes integer, dias_con_datos integer, dias_sin_datos date[], personas bigint, archivos bigint)
language sql stable security invoker set search_path = public as $$
  with dias as (
    select event_at::date as dia, count(distinct document) filter (where is_attendance) personas, count(distinct import_id) archivos
    from biometric_events where is_attendance group by 1
  ), meses as (
    select date_trunc('month', dia)::date as mes, count(*)::int con_datos, max(personas) personas,
           (select count(distinct e.import_id) from biometric_events e where e.event_at >= date_trunc('month', min(d.dia)) and e.event_at < date_trunc('month', min(d.dia)) + interval '1 month') archivos
    from dias d group by 1
  )
  select m.mes,
         extract(day from (m.mes + interval '1 month - 1 day'))::int,
         m.con_datos,
         array(select g::date from generate_series(m.mes, (m.mes + interval '1 month - 1 day')::date, interval '1 day') g
               where not exists (select 1 from dias x where x.dia = g::date) order by 1),
         m.personas, m.archivos
  from meses m order by m.mes desc;
$$;
grant execute on function public.cobertura_historico() to authenticated;
