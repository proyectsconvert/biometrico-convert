-- Migración 0034: Regla configurable «qué eventos cuentan como marcación»
--   · todos_con_usuario (por defecto, igual que la consolidación histórica en Excel/Power Query):
--     cualquier evento con usuario del CSV cuenta; entrada = primer registro del día y salida = el
--     último, sin importar la puerta ni el tipo de evento (debe haber más de un registro).
--   · exitosas: solo autenticaciones exitosas (huella/tarjeta).
-- Los empleados se siguen creando solo para personas con al menos una autenticación exitosa
-- (evita crear «empleados» desde sincronizaciones masivas de usuarios en BioStar).

insert into public.rules (tenant_id, key, value, description)
select t.id, 'eventos_asistencia', '"todos_con_usuario"'::jsonb,
       'Qué eventos cuentan como marcación: todos_con_usuario (cualquier registro con usuario) o exitosas (solo autenticaciones exitosas)'
from public.tenants t
on conflict (tenant_id, key) do update set value = excluded.value, description = excluded.description;

create or replace function public.cuenta_como_marcacion(_tenant uuid, _event_type text, _document text)
returns boolean language sql stable security definer set search_path = public as $$
  select _document is not null and (
    coalesce((select value#>>'{}' from public.rules where tenant_id = _tenant and key = 'eventos_asistencia'), 'exitosas') = 'todos_con_usuario'
    or public.es_marcacion_valida(_event_type));
$$;
grant execute on function public.cuenta_como_marcacion(uuid, text, text) to authenticated, service_role;

-- procesar_importacion y reconstruir_mes usan la regla (leída una vez por llamada)
do $$
declare d text;
begin
  d := pg_get_functiondef('public.procesar_importacion(uuid)'::regprocedure);
  d := replace(d, 'v_desde timestamp; v_hasta timestamp;', 'v_desde timestamp; v_hasta timestamp; v_todos boolean;');
  d := replace(d, '  v_dedupe := coalesce(v_dedupe, 60);',
    '  v_dedupe := coalesce(v_dedupe, 60);' || chr(10) ||
    '  v_todos := coalesce((select value#>>''{}'' from public.rules where tenant_id = v_tenant and key = ''eventos_asistencia''), ''exitosas'') = ''todos_con_usuario'';');
  d := replace(d, 'is_attendance = (e.document is not null and public.es_marcacion_valida(e.event_type))',
                  'is_attendance = (e.document is not null and (v_todos or public.es_marcacion_valida(e.event_type)))');
  if position('v_todos or public.es_marcacion_valida' in d) = 0 then raise exception 'procesar_importacion no actualizada'; end if;
  execute d;

  d := pg_get_functiondef('public.reconstruir_mes(uuid,date,date)'::regprocedure);
  d := replace(d, 'declare v_dedupe integer;', 'declare v_todos boolean; v_dedupe integer;');
  d := replace(d, '  v_dedupe := coalesce(v_dedupe, 60);',
    '  v_dedupe := coalesce(v_dedupe, 60);' || chr(10) ||
    '  v_todos := coalesce((select value#>>''{}'' from rules where tenant_id = _tenant and key = ''eventos_asistencia''), ''exitosas'') = ''todos_con_usuario'';');
  d := replace(d, 'update biometric_events set is_attendance = (document is not null and es_marcacion_valida(event_type))',
                  'update biometric_events set is_attendance = (document is not null and (v_todos or es_marcacion_valida(event_type)))');
  -- empleados: solo quien tenga al menos una autenticación exitosa
  d := replace(d, 'from biometric_events where tenant_id = _tenant and event_at >= _desde and event_at < _hasta + 1 and is_attendance
  group by document',
                  'from biometric_events where tenant_id = _tenant and event_at >= _desde and event_at < _hasta + 1
    and document is not null and es_marcacion_valida(event_type)
  group by document');
  if position('v_todos or es_marcacion_valida' in d) = 0 or position('and document is not null and es_marcacion_valida(event_type)' in d) = 0 then
    raise exception 'reconstruir_mes no actualizada';
  end if;
  execute d;
end $$;
