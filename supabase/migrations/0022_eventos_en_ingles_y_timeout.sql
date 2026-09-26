-- Migración 0022: Reportes del biométrico en inglés y tiempo máximo del servidor
-- 1. Algunas exportaciones de BioStar (p. ej. marzo 2025) vienen en inglés:
--    «1:N authentication succeeded (Fingerprint)», «1:1 authentication succeeded (Card)».
--    Solo se reconocía «Autenticación exitosa», así que esas marcaciones no contaban.
-- 2. PostgREST aplica statement_timeout=8s (rol authenticator). Con varias cargas simultáneas,
--    el procesamiento espera su turno (candado) y superaba ese límite. El rol service_role
--    (solo lo usa el servidor) recibe un límite amplio.

create or replace function public.es_marcacion_valida(_event_type text)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(
    (_event_type ilike '%autenticaci_n exitosa%' or _event_type ilike '%authentication succeeded%')
    and _event_type not ilike '%fallida%' and _event_type not ilike '%failed%',
    false);
$$;

alter role service_role set statement_timeout = '15min';
notify pgrst, 'reload config';

-- Reprocesar las importaciones con marcaciones en inglés que no se contaron
do $$
declare r record; v jsonb;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  for r in
    select distinct e.import_id, i.tenant_id
    from public.biometric_events e join public.biometric_imports i on i.id = e.import_id
    where not e.is_attendance and public.es_marcacion_valida(e.event_type)
  loop
    v := public.procesar_importacion(r.import_id);
    if v->>'desde' is not null then
      perform public.recalcular_asistencia(r.tenant_id, (v->>'desde')::date, (v->>'hasta')::date);
    end if;
    update public.biometric_imports
    set status = 'completado', error_message = null, finished_at = coalesce(finished_at, now())
    where id = r.import_id and status = 'error';
  end loop;
end $$;
