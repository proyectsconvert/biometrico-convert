-- Migración 0016: Asegurar que todas las marcaciones con documento cuentan para asistencia (sin importar puerta)
-- y que 1 marcación = incompleta, 2+ marcaciones = completa (primera entrada, última salida)

create or replace function public.sugerir_clasificacion(_name text)
returns public.device_class language sql immutable as $$
  select 'entrada_salida'::public.device_class;
$$;

update public.devices set classification = 'entrada_salida' where classification = 'interno';

-- Actualizar todos los eventos biométricos para que ninguna puerta se excluya
update public.biometric_events
set is_attendance = (document is not null and event_type ilike '%exitosa%' and event_type not ilike '%fallida%')
where document is not null;

create or replace view public.biometric_daily with (security_invoker = true) as
select e.tenant_id, e.document, max(e.biometric_name) as nombre, e.event_at::date as fecha,
       min(e.event_at) filter (where e.is_attendance and not e.is_duplicate) as primera_entrada,
       case when max(e.event_at) filter (where e.is_attendance and not e.is_duplicate) > min(e.event_at) filter (where e.is_attendance and not e.is_duplicate)
         then max(e.event_at) filter (where e.is_attendance and not e.is_duplicate) else null end as ultima_salida,
       min(e.event_at) filter (where e.is_attendance) as primera_marcacion,
       max(e.event_at) filter (where e.is_attendance) as ultima_marcacion,
       count(*) filter (where e.is_attendance and not e.is_duplicate) as marcaciones_validas,
       count(*) as eventos_totales
from public.biometric_events e
where e.document is not null
group by e.tenant_id, e.document, e.event_at::date;

-- Recalcular la asistencia de todas las empresas en los periodos con eventos registrados
do $$
declare
  t record;
begin
  for t in select distinct tenant_id, min(event_at::date) as d1, max(event_at::date) as d2
           from public.biometric_events
           where is_attendance and not is_duplicate
           group by tenant_id
  loop
    if t.d1 is not null and t.d2 is not null then
      perform public.recalcular_asistencia(t.tenant_id, t.d1, t.d2);
    end if;
  end loop;
end $$;
