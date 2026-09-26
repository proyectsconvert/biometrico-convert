-- Migración 0029: La permanencia se trunca al minuto (9:23:32 → 9:23), igual que el histórico en Excel
do $$
declare d text;
begin
  d := pg_get_functiondef('public.recalcular_asistencia(uuid,date,date)'::regprocedure);
  d := replace(d, 'then (extract(epoch from (last_out - first_in))/60)::int else 0 end as stay',
                  'then floor(extract(epoch from (last_out - first_in))/60)::int else 0 end as stay');
  if position('floor(extract(epoch from (last_out - first_in))/60)' in d) = 0 then
    raise exception 'No se pudo actualizar recalcular_asistencia';
  end if;
  execute d;
end $$;
