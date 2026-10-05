-- Novedades: ciclo de revisión con segunda instancia, historial con evidencias y registro de horas sin Excel.
--
-- Estados de revisión (por persona y periodo):
--   pendiente → aprobado | observado | rechazado  (Nómina)
--   observado / rechazado → respondido            (el supervisor refuta o aclara, con evidencia)
--   respondido → aprobado | observado | rechazado  (Nómina, segunda revisión)

alter table public.novelty_totals drop constraint if exists novelty_totals_review_status_chk;
alter table public.novelty_totals add constraint novelty_totals_review_status_chk
  check (review_status in ('pendiente', 'aprobado', 'observado', 'rechazado', 'respondido'));

-- Historial: cada decisión, respuesta o comentario, con sus archivos
create table if not exists public.novelty_review_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  total_id uuid not null references public.novelty_totals(id) on delete cascade,
  document text not null,
  tipo text not null check (tipo in ('aprobado', 'observado', 'rechazado', 'pendiente', 'respondido', 'comentario', 'horas')),
  comentario text,
  archivos jsonb not null default '[]'::jsonb,  -- [{ path, nombre, tipo, tamano }]
  user_id uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists novelty_review_events_total_idx on public.novelty_review_events (total_id, created_at);
alter table public.novelty_review_events enable row level security;

-- Se ve el historial de las personas que se pueden ver; se escribe solo con las funciones de abajo
drop policy if exists "historial novedades lectura" on public.novelty_review_events;
create policy "historial novedades lectura" on public.novelty_review_events for select to authenticated using (
  ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  and (select public.has_permission('novedades', 'ver'))
  and ((select public.ve_toda_empresa()) or array[document] <@ (select public.my_documents()))
);

-- Nómina decide (aprobar, observar, rechazar o reabrir); observar y rechazar exigen comentario
create or replace function public.revisar_novedades(_ids uuid[], _estado text, _comentario text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.has_permission('novedades', 'aprobar') then
    raise exception 'No tienes permiso para aprobar novedades';
  end if;
  if _estado not in ('aprobado', 'observado', 'rechazado', 'pendiente') then raise exception 'Estado inválido'; end if;
  if _estado in ('observado', 'rechazado') and coalesce(trim(_comentario), '') = '' then
    raise exception 'Observar o rechazar requiere un comentario';
  end if;
  update public.novelty_totals set review_status = _estado, review_comment = nullif(trim(_comentario), ''),
         reviewed_by = auth.uid(), reviewed_at = now()
  where id = any(_ids) and public.tenant_visible(tenant_id);
  get diagnostics n = row_count;
  insert into public.novelty_review_events (tenant_id, total_id, document, tipo, comentario)
  select t.tenant_id, t.id, t.document, _estado, nullif(trim(_comentario), '')
  from public.novelty_totals t where t.id = any(_ids) and public.tenant_visible(t.tenant_id);
  insert into public.audit_logs (tenant_id, user_id, module, action, new_value, reason)
  values (public.current_tenant_id(), auth.uid(), 'novedades', _estado,
          jsonb_build_object('registros', n, 'ids', _ids), nullif(trim(_comentario), ''));
  return n;
end $$;

-- El supervisor comenta o refuta con evidencia. Si _enviar es true (o la novedad estaba observada o
-- rechazada), vuelve a Nómina como «respondido» para la segunda revisión.
create or replace function public.comentar_novedad(_id uuid, _comentario text, _archivos jsonb default '[]'::jsonb, _enviar boolean default true)
returns text language plpgsql security definer set search_path = public as $$
declare t public.novelty_totals; v_estado text;
begin
  if not (public.has_permission('novedades', 'crear') or public.has_permission('novedades', 'editar') or public.has_permission('novedades', 'aprobar')) then
    raise exception 'No tienes permiso para comentar novedades';
  end if;
  select * into t from public.novelty_totals where id = _id;
  if t.id is null or not (public.tenant_visible(t.tenant_id) and (public.ve_toda_empresa() or t.document = any(public.my_documents()))) then
    raise exception 'Novedad no encontrada';
  end if;
  if coalesce(trim(_comentario), '') = '' and jsonb_array_length(coalesce(_archivos, '[]'::jsonb)) = 0 then
    raise exception 'Escribe un comentario o adjunta evidencia';
  end if;
  v_estado := case when _enviar and t.review_status in ('observado', 'rechazado', 'pendiente') then 'respondido' else t.review_status end;
  update public.novelty_totals set review_status = v_estado where id = _id;
  insert into public.novelty_review_events (tenant_id, total_id, document, tipo, comentario, archivos)
  values (t.tenant_id, t.id, t.document, case when v_estado = 'respondido' and v_estado <> t.review_status then 'respondido' else 'comentario' end,
          nullif(trim(_comentario), ''), coalesce(_archivos, '[]'::jsonb));
  return v_estado;
end $$;
grant execute on function public.comentar_novedad(uuid, text, jsonb, boolean) to authenticated;

-- Registrar horas sin Excel (una persona o varias): solo cambia los conceptos enviados en _valores.
-- Si ya había horas para esa persona y periodo, se actualizan y la revisión vuelve a «pendiente».
create or replace function public.guardar_horas_novedad(_documentos text[], _desde date, _hasta date, _valores jsonb, _comentario text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare d text; e record; n integer := 0; v_id uuid;
  campos text[] := array['horas_nocturnas','ajuste_horas_nocturnas','horas_dom_fest_090','ajuste_dom_fest_090','horas_dom_fest_190',
                         'ajuste_dom_fest_190','horas_extra_diurnas','ajuste_extra_diurnas','horas_extra_nocturnas','ajuste_extra_nocturnas'];
  k text;
begin
  if not (public.has_permission('novedades', 'crear') or public.has_permission('novedades', 'importar')) then
    raise exception 'No tienes permiso para registrar novedades';
  end if;
  if _hasta < _desde then raise exception 'La fecha final no puede ser anterior a la inicial'; end if;
  for k in select jsonb_object_keys(_valores) loop
    if not k = any(campos) then raise exception 'Concepto no válido: %', k; end if;
  end loop;
  foreach d in array _documentos loop
    select emp.id, emp.tenant_id, emp.document, emp.full_name, emp.position, c.name as campana into e
    from public.employees emp left join public.campaigns c on c.id = emp.campaign_id
    where emp.document = d and emp.tenant_id = public.current_tenant_id();
    if e.id is null then continue; end if;
    if not (public.ve_toda_empresa() or e.document = any(public.my_documents())) then continue; end if;
    insert into public.novelty_totals (tenant_id, employee_id, document, full_name, position, campaign_label, period_start, period_end, source)
    values (e.tenant_id, e.id, e.document, e.full_name, e.position, e.campana, _desde, _hasta, 'manual')
    on conflict (tenant_id, document, period_start, period_end) do nothing;
    select id into v_id from public.novelty_totals where tenant_id = e.tenant_id and document = e.document and period_start = _desde and period_end = _hasta;
    for k in select jsonb_object_keys(_valores) loop
      execute format('update public.novelty_totals set %I = $1 where id = $2', k) using coalesce((_valores->>k)::numeric, 0), v_id;
    end loop;
    update public.novelty_totals set review_status = 'pendiente', review_comment = null where id = v_id;
    insert into public.novelty_review_events (tenant_id, total_id, document, tipo, comentario)
    values (e.tenant_id, v_id, e.document, 'horas', coalesce(nullif(trim(_comentario), ''), 'Horas registradas en la plataforma'));
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function public.guardar_horas_novedad(text[], date, date, jsonb, text) to authenticated;

-- Bucket privado para las evidencias: <empresa>/<novedad>/<archivo>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documentos-novedades', 'documentos-novedades', false, 10485760,
        array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif',
              'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "evidencias novedades lectura" on storage.objects;
create policy "evidencias novedades lectura" on storage.objects for select to authenticated using (
  bucket_id = 'documentos-novedades'
  and (storage.foldername(name))[1] = public.current_tenant_id()::text
  and public.has_permission('novedades', 'ver')
  -- solo evidencias de novedades de personas que el usuario puede ver (RLS de novelty_totals)
  and exists (select 1 from public.novelty_totals t where t.id::text = (storage.foldername(name))[2])
);
drop policy if exists "evidencias novedades subir" on storage.objects;
create policy "evidencias novedades subir" on storage.objects for insert to authenticated with check (
  bucket_id = 'documentos-novedades'
  and (storage.foldername(name))[1] = public.current_tenant_id()::text
  and (public.has_permission('novedades', 'crear') or public.has_permission('novedades', 'editar') or public.has_permission('novedades', 'aprobar'))
);
