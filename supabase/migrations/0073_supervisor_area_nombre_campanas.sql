-- Migración 0073: El supervisor de área ve el NOMBRE de las campañas donde están sus personas a cargo
-- (para que el panel, los filtros y las tablas no digan «Sin campaña»). No le da acceso a nadie más:
-- todos los datos (asistencia, marcaciones, novedades, turnos) siguen limitados a sus personas por cargo.
-- mis_campanas_propias solo la usa la política de lectura de campaigns.

CREATE OR REPLACE FUNCTION public.mis_campanas_propias()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cargos as (select public._mis_cargos() as c)
  select coalesce(array_agg(distinct e.campaign_id) filter (where e.campaign_id is not null), '{}')
  from public.employees e, cargos
  where e.user_id = auth.uid()
     or (cardinality(cargos.c) > 0 and e.tenant_id = public.current_tenant_id() and upper(trim(e.position)) = any(cargos.c));
$function$;
