-- Migración 0072: my_employee_ids / my_documents calculan el alcance UNA vez (no por cada empleado)
-- Antes evaluaban my_scope(), my_campaign_ids() y _mis_cargos() por cada fila de employees (~2.600):
-- ~2,5 s por consulta para supervisores, coordinadores y supervisores de área, y las pantallas con
-- varias consultas se vencían (error 500). Mismo resultado, ahora en milisegundos.

CREATE OR REPLACE FUNCTION public.my_employee_ids()
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_campanas uuid[]; v_cargos text[]; v_ids uuid[];
begin
  if public.is_admin_or_nomina() or public.ve_toda_empresa() then
    select coalesce(array_agg(id), '{}'::uuid[]) into v_ids from public.employees where public.tenant_visible(tenant_id);
    return v_ids;
  end if;
  v_tenant := public.current_tenant_id();
  v_campanas := case when public.my_scope() <> 'solo_yo' then public.my_campaign_ids() else '{}'::uuid[] end;
  v_cargos := public._mis_cargos();
  select coalesce(array_agg(e.id), '{}'::uuid[]) into v_ids
  from public.employees e
  where e.tenant_id = v_tenant
    and (e.campaign_id = any(v_campanas) or e.user_id = auth.uid() or upper(trim(e.position)) = any(v_cargos));
  return v_ids;
end $function$;

CREATE OR REPLACE FUNCTION public.my_documents()
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_campanas uuid[]; v_cargos text[]; v_docs text[];
begin
  if public.is_admin_or_nomina() or public.ve_toda_empresa() then
    select coalesce(array_agg(document), '{}'::text[]) into v_docs
    from public.employees where public.tenant_visible(tenant_id) and document is not null;
    return v_docs;
  end if;
  v_tenant := public.current_tenant_id();
  v_campanas := case when public.my_scope() <> 'solo_yo' then public.my_campaign_ids() else '{}'::uuid[] end;
  v_cargos := public._mis_cargos();
  select coalesce(array_agg(e.document), '{}'::text[]) into v_docs
  from public.employees e
  where e.tenant_id = v_tenant and e.document is not null
    and (e.campaign_id = any(v_campanas) or e.user_id = auth.uid() or upper(trim(e.position)) = any(v_cargos));
  return v_docs;
end $function$;
