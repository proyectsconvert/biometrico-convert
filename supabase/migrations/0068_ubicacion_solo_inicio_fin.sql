-- Migración 0068: La ubicación se toma solo al iniciar y al finalizar el turno
-- * Ya no se reporta la ubicación durante el turno: reportar_ubicacion_turno queda sin efecto (por si
--   algún navegador tiene la versión anterior abierta) y no genera alarmas.
-- * Al finalizar, «dentro de rango» y la última ubicación quedan con la ubicación del cierre.
-- * La aplicación no deja iniciar ni finalizar sin ubicación: la vuelve a pedir hasta que se active.
-- * Limpieza: las alarmas de ubicación «durante el turno» abiertas se cierran y el rango vuelve al del inicio.

create or replace function public.reportar_ubicacion_turno(_ubic jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ok', true, 'dentro', null, 'motivo', 'La ubicación solo se toma al iniciar y al finalizar el turno');
$$;

do $$
declare d text; viejo text; nuevo text;
begin
  d := pg_get_functiondef('public.finalizar_turno(jsonb,text)'::regprocedure);
  viejo := $v$update work_sessions set ended_at = now(), cierre = 'usuario', ip_fin = v_red->>'ip',$v$;
  nuevo := $n$update work_sessions set ended_at = now(), cierre = 'usuario', ip_fin = v_red->>'ip',
         ultima_ubicacion = coalesce(_datos->'ubicacion', ultima_ubicacion), ultima_ubicacion_at = now(),
         dentro_de_rango = coalesce((v_val->>'dentro_de_rango')::boolean, dentro_de_rango),$n$;
  if position(viejo in d) = 0 then raise exception 'finalizar_turno: no se encontró el texto a reemplazar'; end if;
  execute replace(d, viejo, nuevo);
end $$;

update public.work_sessions w
   set dentro_de_rango = coalesce((w.validacion->>'dentro_de_rango')::boolean,
         (select (public._validar_turno(p, null, null, w.inicio->'ubicacion')->>'dentro_de_rango')::boolean
            from public.shift_policies p where p.id = w.policy_id)),
       ultima_ubicacion = w.inicio->'ubicacion', ultima_ubicacion_at = w.started_at
 where w.ended_at is null;

update public.shift_alerts
   set estado = 'atendida', atendida_at = now(),
       datos = datos || jsonb_build_object('nota', 'La ubicación ya no se revisa durante el turno (solo al iniciar y finalizar)')
 where estado = 'abierta' and tipo in ('fuera_de_rango', 'ubicacion_desactivada');

notify pgrst, 'reload schema';
