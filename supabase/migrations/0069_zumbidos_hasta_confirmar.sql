-- Migración 0069: El zumbido (ventana emergente) sigue apareciendo hasta que la persona pulse «Entendido»
-- o termine el turno. Antes, abrirlo desde la campana de notificaciones lo marcaba como leído y la
-- ventana ya no salía. Ahora la ventana depende de confirmada_at (no de leida_at).

create index if not exists notifications_emergentes_sin_confirmar on public.notifications (user_id)
  where emergente and confirmada_at is null;

-- Al terminar el turno se dan por leídos y confirmados sus zumbidos pendientes
create or replace function public._apagar_avisos_turno() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update notifications set leida_at = coalesce(leida_at, now()), confirmada_at = coalesce(confirmada_at, now())
  where session_id = new.id and emergente and (leida_at is null or confirmada_at is null);
  return new;
end $$;

-- Al autorizar horas extra, los zumbidos pendientes de ese turno ya no aplican
do $$
declare d text; viejo text; nuevo text;
begin
  d := pg_get_functiondef('public.gestionar_turno(uuid,text,numeric,text)'::regprocedure);
  viejo := $v$    update notifications set leida_at = coalesce(leida_at, now())
    where session_id = v.id and emergente and leida_at is null;$v$;
  nuevo := $n$    update notifications set leida_at = coalesce(leida_at, now()), confirmada_at = coalesce(confirmada_at, now())
    where session_id = v.id and emergente and confirmada_at is null;$n$;
  if position(viejo in d) = 0 then raise exception 'gestionar_turno: no se encontró el texto a reemplazar'; end if;
  execute replace(d, viejo, nuevo);
end $$;

-- Turnos ya cerrados: sus zumbidos quedan confirmados
update public.notifications n set confirmada_at = coalesce(n.leida_at, now())
where n.emergente and n.confirmada_at is null
  and exists (select 1 from public.work_sessions w where w.id = n.session_id and w.ended_at is not null);

notify pgrst, 'reload schema';
