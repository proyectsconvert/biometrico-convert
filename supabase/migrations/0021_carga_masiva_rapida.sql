-- Migración 0021: Carga masiva más rápida de CSV del biométrico
-- El cuello de botella era el volumen enviado por red (JSON con nombres de columna repetidos
-- en cada fila, en lotes de 1.000). Ahora el servidor envía lotes grandes de filas compactas
-- (arreglos) y la base normaliza el documento. Además, varios archivos pueden cargarse a la vez:
-- el paso de procesamiento se serializa por empresa con un candado para evitar choques.

create or replace function public.cargar_eventos(_import_id uuid, _filas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; n integer;
begin
  select tenant_id into v_tenant from public.biometric_imports where id = _import_id;
  if v_tenant is null then raise exception 'Importación no encontrada'; end if;
  if coalesce(auth.role(),'') <> 'service_role'
     and not (public.tenant_visible(v_tenant) and public.has_permission('importaciones','importar')) then
    raise exception 'Sin permiso para importar';
  end if;

  -- cada fila: [fecha, puerta, id_dispositivo, dispositivo, grupo, usuario, evento]
  insert into public.biometric_events
    (tenant_id, import_id, event_at, door, device_code, device_name, user_group, raw_user, document, biometric_name, event_type)
  select v_tenant, _import_id, (r->>0)::timestamp, nullif(r->>1,''), r->>2, nullif(r->>3,''), nullif(r->>4,''),
         nullif(r->>5,''),
         -- «012345(CONVERTIA)» -> documento 012345 + nombre; «012345» -> documento
         nullif(regexp_replace(coalesce(m[1], r->>5, ''), '\D', '', 'g'), ''),
         upper(trim(m[2])),
         coalesce(r->>6, '')
  from jsonb_array_elements(_filas) r
  left join lateral regexp_match(r->>5, '^\s*([0-9A-Za-z.\-]+)\s*\((.+)\)\s*$') m on true
  where nullif(r->>0,'') is not null and nullif(r->>2,'') is not null
  order by 3, 5, 11, 8  -- orden estable de claves: evita bloqueos cruzados entre cargas simultáneas
  on conflict (tenant_id, event_at, device_code, event_type, raw_user) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.cargar_eventos(uuid, jsonb) from public, anon;
grant execute on function public.cargar_eventos(uuid, jsonb) to authenticated, service_role;

-- Un solo procesamiento a la vez por empresa (creación de empleados/dispositivos y duplicados)
do $$
declare d text;
begin
  d := pg_get_functiondef('public.procesar_importacion(uuid)'::regprocedure);
  if position('pg_advisory_xact_lock' in d) = 0 then
    d := replace(d, '  v_dedupe := coalesce(v_dedupe, 60);',
      '  v_dedupe := coalesce(v_dedupe, 60);' || chr(10) ||
      '  perform pg_advisory_xact_lock(hashtext(''procesar_importacion:'' || v_tenant::text));');
    execute d;
  end if;
end $$;

-- Índice sin uso (idx_scan = 0): el buscador por nombre usa ilike '%…%', que un btree no aprovecha
drop index if exists public.bio_events_name_trgm_idx;
