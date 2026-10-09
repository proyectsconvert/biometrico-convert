-- Migración 0064: El tablero «Inicio turno» muestra si la persona sigue dentro del rango autorizado
-- (según la última ubicación reportada durante el turno) y cuándo se reportó.

drop function if exists public.tablero_inicio_turno(date, date);
CREATE OR REPLACE FUNCTION public.tablero_inicio_turno(_desde date, _hasta date)
 RETURNS TABLE(id uuid, user_id uuid, employee_id uuid, empleado text, documento text, usuario text, campana text, supervisores text, inicio timestamp with time zone, fin timestamp with time zone, cierre text, motivo_cierre text, tipo_dispositivo text, ip_inicio text, ip_fin text, ubicacion jsonb, validacion jsonb, max_horas numeric, limite timestamp with time zone, extra_autorizada_hasta timestamp with time zone, extra_autorizada_horas numeric, estado text, avisos integer, alarmas_abiertas integer, regla text, dentro_de_rango boolean, ultima_ubicacion_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select w.id, w.user_id, w.employee_id, e.full_name, e.document, coalesce(pr.full_name, pr.email), c.name,
         (select string_agg(s.nombre, ', ') from public.supervisores_campanas() s
           where s.todas or e.campaign_id = any(s.campaign_ids)),
         w.started_at, w.ended_at, w.cierre, w.motivo_cierre,
         coalesce(w.tipo_dispositivo, public._tipo_dispositivo(w.inicio#>>'{red,navegador}')),
         coalesce(w.ip_inicio, w.inicio#>>'{red,ip}'), coalesce(w.ip_fin, w.fin#>>'{red,ip}'),
         w.inicio->'ubicacion', w.validacion, coalesce(p.max_horas, 8),
         coalesce(w.extra_autorizada_hasta, w.started_at + make_interval(mins => (coalesce(p.max_horas, 8) * 60)::int + coalesce(p.tolerancia_min, 0))),
         w.extra_autorizada_hasta, w.extra_autorizada_horas,
         case
           when w.ended_at is not null then case w.cierre when 'autorizado' then 'cierre_autorizado' when 'automatico' then 'sin_cierre' else 'finalizado' end
           when w.extra_autorizada_hasta is not null and now() > w.extra_autorizada_hasta then 'extra_vencida'
           when w.extra_autorizada_hasta is not null then 'en_extra'
           when now() > w.started_at + make_interval(mins => (coalesce(p.max_horas, 8) * 60)::int + coalesce(p.tolerancia_min, 0)) then 'vencido'
           else 'activo' end,
         w.avisos,
         (select count(*)::int from shift_alerts a where a.session_id = w.id and a.estado = 'abierta'),
         p.nombre, w.dentro_de_rango, w.ultima_ubicacion_at
  from work_sessions w
  left join employees e on e.id = w.employee_id
  left join campaigns c on c.id = e.campaign_id
  left join profiles pr on pr.id = w.user_id
  left join shift_policies p on p.id = w.policy_id
  where (public.has_permission('inicio_turno', 'ver') or public.has_permission('registro_turnos', 'ver'))
    and public.tenant_visible(w.tenant_id)
    and (public.ve_toda_empresa() or w.employee_id = any(public.my_employee_ids()))
    and ((w.started_at at time zone 'America/Bogota')::date between _desde and _hasta or w.ended_at is null)
  order by (w.ended_at is null) desc, w.started_at desc;
$function$;

revoke all on function public.tablero_inicio_turno(date, date) from public, anon;
grant execute on function public.tablero_inicio_turno(date, date) to authenticated;

notify pgrst, 'reload schema';
