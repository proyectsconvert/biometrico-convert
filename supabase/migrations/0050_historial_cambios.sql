-- Migración 0050: Historial de cambios visible en cada día (novedades y malla)
-- La auditoría completa solo la ve quien tiene «auditoria.ver». Esta función muestra, a quien puede
-- ver a la persona, quién creó o cambió una novedad del día o un día de la malla, cuándo y qué
-- valor tenía antes y después.

create index if not exists audit_logs_registro on public.audit_logs (tenant_id, record_id);
create index if not exists audit_logs_modulo_fecha on public.audit_logs (tenant_id, module, created_at desc);

create or replace function public.historial_cambios(_tabla text, _clave jsonb)
returns table(created_at timestamptz, usuario text, accion text, antes jsonb, despues jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_ids text[];
begin
  if _tabla = 'novelty_entries' then
    if not public.has_permission('novedades', 'ver')
       or not (public.ve_toda_empresa() or (_clave->>'document') = any(public.my_documents())) then
      raise exception 'Sin acceso a esta persona';
    end if;
    select array_agg(distinct x.id) into v_ids from (
      select e.id::text as id from public.novelty_entries e
       where e.tenant_id = v_tenant and e.document = _clave->>'document' and e.work_date = (_clave->>'fecha')::date
      union
      -- altas y borrados guardan el registro completo (sirve para lo ya eliminado)
      select a.record_id from public.audit_logs a
       where a.tenant_id = v_tenant and a.module = 'novedades' and a.action in ('crear_novedad_dia', 'eliminar_novedad_dia')
         and coalesce(a.new_value, a.old_value)->>'document' = _clave->>'document'
         and coalesce(a.new_value, a.old_value)->>'work_date' = _clave->>'fecha'
    ) x;
  elsif _tabla = 'shift_schedule' then
    if not public.has_permission('turnos', 'ver') or not public.evidencia_visible('empleado', _clave->>'employee_id') then
      raise exception 'Sin acceso a esta persona';
    end if;
    select array_agg(distinct x.id) into v_ids from (
      select m.id::text as id from public.shift_schedule m
       where m.tenant_id = v_tenant and m.employee_id = (_clave->>'employee_id')::uuid and m.fecha = (_clave->>'fecha')::date
      union
      select a.record_id from public.audit_logs a
       where a.tenant_id = v_tenant and a.module = 'turnos' and a.action in ('crear_malla', 'eliminar_malla')
         and coalesce(a.new_value, a.old_value)->>'employee_id' = _clave->>'employee_id'
         and coalesce(a.new_value, a.old_value)->>'fecha' = _clave->>'fecha'
    ) x;
  else
    raise exception 'Historial no disponible para %', _tabla;
  end if;

  return query
    select a.created_at, coalesce(p.full_name, 'Sistema'), a.action, a.old_value, a.new_value
    from public.audit_logs a
    left join public.profiles p on p.id = a.user_id
    where a.tenant_id = v_tenant and a.record_id = any(coalesce(v_ids, '{}'))
    order by a.created_at desc
    limit 100;
end $$;
grant execute on function public.historial_cambios(text, jsonb) to authenticated, service_role;
