-- Migración 0060: Nómina corrige horas reportadas sin subir otra plantilla; permiso para borrar plantillas
-- 1. ajustar_horas_novedad: quien aprueba novedades (Super Administrador, Administración, Nómina)
--    corrige las horas reportadas de un periodo (p. ej. 17 → 14). Queda en el historial de la
--    revisión (antes → después y el motivo) y en la auditoría; el supervisor lo ve en su resumen.
-- 2. Permiso «novedades.eliminar_plantillas» (Borrar plantillas cargadas), asignable en Roles y
--    permisos; de inicio Administración y Nómina.

/* ---------- 1. Corregir horas reportadas ---------- */
create or replace function public.ajustar_horas_novedad(_total uuid, _cambios jsonb, _motivo text default null)
returns public.novelty_totals
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.novelty_totals;
  v public.novelty_totals;
  k text;
  nuevo numeric;
  lineas text[] := '{}';
  etiquetas constant jsonb := '{
    "horas_nocturnas": "Nocturnas (0,35)",
    "horas_dom_fest_090": "Dominical/festivo (0,90)",
    "horas_dom_fest_190": "Dominical/festivo (1,90)",
    "horas_extra_diurnas": "Extras diurnas (1,25)",
    "horas_extra_nocturnas": "Extras nocturnas (1,75)"
  }';
begin
  if not public.has_permission('novedades', 'aprobar') then
    raise exception 'No tienes permiso para corregir horas de novedades';
  end if;
  select * into t from novelty_totals where id = _total and public.tenant_visible(tenant_id) for update;
  if t.id is null then raise exception 'Registro no encontrado'; end if;
  if jsonb_typeof(_cambios) <> 'object' then raise exception 'Cambios inválidos'; end if;

  v := t;
  for k in select jsonb_object_keys(_cambios) loop
    if not etiquetas ? k then raise exception 'Campo no permitido: %', k; end if;
    nuevo := round((_cambios->>k)::numeric, 2);
    if nuevo is null or nuevo < 0 or nuevo > 744 then raise exception 'Valor inválido para %: debe estar entre 0 y 744 h', etiquetas->>k; end if;
    case k
      when 'horas_nocturnas' then if nuevo is distinct from t.horas_nocturnas then lineas := lineas || format('%s: %s h → %s h', etiquetas->>k, replace(trim_scale(t.horas_nocturnas)::text, '.', ','), replace(trim_scale(nuevo)::text, '.', ',')); v.horas_nocturnas := nuevo; end if;
      when 'horas_dom_fest_090' then if nuevo is distinct from t.horas_dom_fest_090 then lineas := lineas || format('%s: %s h → %s h', etiquetas->>k, replace(trim_scale(t.horas_dom_fest_090)::text, '.', ','), replace(trim_scale(nuevo)::text, '.', ',')); v.horas_dom_fest_090 := nuevo; end if;
      when 'horas_dom_fest_190' then if nuevo is distinct from t.horas_dom_fest_190 then lineas := lineas || format('%s: %s h → %s h', etiquetas->>k, replace(trim_scale(t.horas_dom_fest_190)::text, '.', ','), replace(trim_scale(nuevo)::text, '.', ',')); v.horas_dom_fest_190 := nuevo; end if;
      when 'horas_extra_diurnas' then if nuevo is distinct from t.horas_extra_diurnas then lineas := lineas || format('%s: %s h → %s h', etiquetas->>k, replace(trim_scale(t.horas_extra_diurnas)::text, '.', ','), replace(trim_scale(nuevo)::text, '.', ',')); v.horas_extra_diurnas := nuevo; end if;
      when 'horas_extra_nocturnas' then if nuevo is distinct from t.horas_extra_nocturnas then lineas := lineas || format('%s: %s h → %s h', etiquetas->>k, replace(trim_scale(t.horas_extra_nocturnas)::text, '.', ','), replace(trim_scale(nuevo)::text, '.', ',')); v.horas_extra_nocturnas := nuevo; end if;
    end case;
  end loop;
  if array_length(lineas, 1) is null then return t; end if;

  update novelty_totals set
    horas_nocturnas = v.horas_nocturnas, horas_dom_fest_090 = v.horas_dom_fest_090,
    horas_dom_fest_190 = v.horas_dom_fest_190, horas_extra_diurnas = v.horas_extra_diurnas,
    horas_extra_nocturnas = v.horas_extra_nocturnas
  where id = t.id
  returning * into v;

  insert into novelty_review_events (tenant_id, total_id, document, tipo, comentario)
  values (t.tenant_id, t.id, t.document, 'horas',
          'Nómina corrigió las horas reportadas. ' || array_to_string(lineas, ' · ') || '.'
          || coalesce(' Motivo: ' || nullif(trim(_motivo), ''), ''));
  return v;
end $$;

revoke all on function public.ajustar_horas_novedad(uuid, jsonb, text) from public, anon;
grant execute on function public.ajustar_horas_novedad(uuid, jsonb, text) to authenticated;

/* ---------- 2. Permiso para borrar plantillas cargadas ---------- */
insert into public.permissions (module, action, label)
select 'novedades', 'eliminar_plantillas', 'Borrar plantillas cargadas de novedades'
where not exists (select 1 from public.permissions where module = 'novedades' and action = 'eliminar_plantillas');

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.module = 'novedades' and p.action = 'eliminar_plantillas'
where r.code in ('admin', 'nomina')
  and not exists (select 1 from public.role_permissions x where x.role_id = r.id and x.permission_id = p.id);

drop policy if exists "novedades eliminar" on public.novelty_reports;
create policy "novedades eliminar" on public.novelty_reports for delete
  using (((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
         and (public.has_permission('novedades', 'eliminar') or public.has_permission('novedades', 'eliminar_plantillas')));

notify pgrst, 'reload schema';
