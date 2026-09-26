-- Migración 0030: Entrada = primer registro y salida = último registro ABSOLUTOS del día
-- Las marcaciones repetidas (misma persona y lector en pocos segundos) ya no se descartan para
-- decidir la entrada/salida: si alguien marca 15:05:52 y 15:06:02, la salida es 15:06:02
-- (igual que la consolidación en Power Query). Las repetidas solo se usan para decidir si la
-- jornada está completa: se necesita más de una marcación distinta.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.recalcular_asistencia(uuid,date,date)'::regprocedure);
  d := replace(d, 's.start_time, s.break_minutes, s.tolerance_in_minutes, e.event_at,',
                  's.start_time, s.break_minutes, s.tolerance_in_minutes, e.event_at, e.is_duplicate,');
  d := replace(d, 'where e.tenant_id = _tenant and e.is_attendance and not e.is_duplicate',
                  'where e.tenant_id = _tenant and e.is_attendance');
  d := replace(d, 'case when max(event_at) > min(event_at) then max(event_at) else null end as last_out',
                  'case when count(*) filter (where not is_duplicate) > 1 then max(event_at) else null end as last_out');
  if position('count(*) filter (where not is_duplicate) > 1' in d) = 0 or position('e.event_at, e.is_duplicate,' in d) = 0 then
    raise exception 'No se pudo actualizar recalcular_asistencia';
  end if;
  execute d;
end $$;
