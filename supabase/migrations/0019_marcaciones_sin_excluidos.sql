-- Migración 0019: Marcaciones con indicador de personal reportable
-- El personal de empleadores excluidos (seguridad, aseo, contratistas) no se muestra en ningún
-- módulo salvo que el usuario lo pida con un filtro. Esta vista agrega el indicador en_reportes
-- a cada evento del biométrico (respeta RLS del usuario).

create or replace view public.marcaciones_reporte with (security_invoker = true) as
select b.id, b.tenant_id, b.import_id, b.event_at, b.door, b.device_code, b.device_name, b.user_group,
       b.raw_user, b.document, b.biometric_name, b.event_type, b.is_attendance, b.is_duplicate,
       b.employee_id, e.employer_id, em.name as employer_name,
       case when e.id is null then true
            when e.employer_id is null then coalesce(cfg.sin_empresa, true)
            else coalesce(em.include_in_reports, true) end as en_reportes
from public.biometric_events b
left join public.employees e on e.id = b.employee_id
left join public.employers em on em.id = e.employer_id
left join lateral (
  select (r.value#>>'{}')::boolean as sin_empresa from public.rules r
  where r.tenant_id = b.tenant_id and r.key = 'reportes_incluir_sin_empresa'
) cfg on true;
grant select on public.marcaciones_reporte to authenticated, service_role;

-- Documentos del personal que no cuenta en reportes (para filtrar novedades y otros listados)
create or replace function public.documentos_excluidos()
returns text[] language sql stable security invoker set search_path = public as $$
  select coalesce(array_agg(e.document), '{}')
  from public.employees e
  where not public.incluye_en_reportes(e.employer_id, e.tenant_id);
$$;
grant execute on function public.documentos_excluidos() to authenticated;
