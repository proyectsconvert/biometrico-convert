-- Migración 0049: Endurecimiento de seguridad (auditoría de reglas de acceso)
-- Hallazgos corregidos:
-- 1. Perfiles: cualquier usuario podía cambiar su propia empresa o reactivarse (WITH CHECK true).
-- 2. Responsables de campaña: cualquiera podía declararse responsable de una campaña y ver sus datos.
-- 3. Altas sin permiso: bastaba pertenecer a la empresa para crear campañas, centros de costo,
--    empleadores, festivos, reglas, dispositivos, importaciones, marcaciones y asistencia.
-- 4. Lecturas abiertas: roles y campañas de todos los usuarios, ajustes de asistencia de todo el
--    personal e historial de importaciones.
-- 5. Funciones internas invocables desde el navegador y funciones ejecutables sin sesión (anon).

/* ---------- 1. Perfiles ---------- */
create or replace function public.proteger_perfil()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- El servidor (service_role) y quien administra usuarios pueden cambiarlo todo
  if coalesce(auth.role(), '') = 'service_role' or auth.uid() is null
     or public.is_super_admin() or public.has_permission('usuarios', 'editar') then
    return new;
  end if;
  -- Un usuario solo puede cambiar su nombre: empresa, estado y correo se conservan
  new.id := old.id;
  new.tenant_id := old.tenant_id;
  new.is_active := old.is_active;
  new.email := old.email;
  return new;
end $$;
drop trigger if exists proteger_perfil on public.profiles;
create trigger proteger_perfil before update on public.profiles for each row execute function public.proteger_perfil();

drop policy if exists "admin gestiona perfiles (crear)" on public.profiles;
create policy "admin gestiona perfiles (crear)" on public.profiles for insert
  with check (public.is_super_admin() or (public.tenant_visible(tenant_id)
              and (public.has_permission('usuarios','crear') or public.has_permission('usuarios','editar'))));

/* ---------- 2 y 3. Altas solo con permiso del módulo ---------- */
do $$
declare t record; p text;
begin
  for t in select * from (values
      ('campaign_responsibles', 'responsables gestion (crear)', '(public.has_permission(''campanas'',''editar'') or public.has_permission(''usuarios'',''editar''))'),
      ('campaigns',             'campanas gestion (crear)',     '(public.has_permission(''campanas'',''crear'') or public.has_permission(''campanas'',''editar''))'),
      ('cost_centers',          'centros_costo gestion (crear)','(public.has_permission(''centros_costo'',''crear'') or public.has_permission(''centros_costo'',''editar''))'),
      ('employers',             'empleadores gestion (crear)',  '(public.has_permission(''empleadores'',''crear'') or public.has_permission(''empleadores'',''editar''))'),
      ('holidays',              'festivos gestion (crear)',     '(public.has_permission(''festivos'',''crear'') or public.has_permission(''festivos'',''editar''))'),
      ('rules',                 'reglas gestion (crear)',       '(public.has_permission(''reglas'',''crear'') or public.has_permission(''reglas'',''editar''))'),
      ('devices',               'dispositivos gestion (crear)', '(public.has_permission(''dispositivos'',''crear'') or public.has_permission(''dispositivos'',''editar''))'),
      ('biometric_imports',     'importaciones gestion (crear)','(public.has_permission(''importaciones'',''importar'') or public.has_permission(''importaciones'',''crear''))'),
      ('attendance_daily',      'asistencia gestion (crear)',   '(public.has_permission(''asistencia'',''editar'') or public.has_permission(''asistencia'',''ajustar''))'),
      ('attendance_adjustments','ajustes gestion (crear)',      '(public.has_permission(''asistencia'',''editar'') or public.has_permission(''asistencia'',''ajustar''))')
    ) v(tabla, politica, permiso)
  loop
    -- Se reemplaza cualquier política de alta existente por una que exige el permiso
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t.tabla and cmd = 'INSERT' loop
      execute format('drop policy %I on public.%I', p, t.tabla);
    end loop;
    execute format('create policy %I on public.%I for insert with check (public.tenant_visible(tenant_id) and %s)',
                   'alta con permiso', t.tabla, t.permiso);
  end loop;
end $$;

-- Marcaciones: solo quien importa
do $$
declare p text;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'biometric_events' and cmd = 'INSERT' loop
    execute format('drop policy %I on public.biometric_events', p);
  end loop;
end $$;
create policy "alta con permiso" on public.biometric_events for insert
  with check (((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
              and (select public.has_permission('importaciones','importar')));

/* ---------- 4. Lecturas restringidas ---------- */
drop policy if exists "user_roles lectura" on public.user_roles;
do $$
declare p text;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'user_roles' and cmd = 'SELECT' loop
    execute format('drop policy %I on public.user_roles', p);
  end loop;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'attendance_adjustments' and cmd = 'SELECT' loop
    execute format('drop policy %I on public.attendance_adjustments', p);
  end loop;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'biometric_imports' and cmd = 'SELECT' loop
    execute format('drop policy %I on public.biometric_imports', p);
  end loop;
end $$;
-- Roles de usuarios: el propio, o quien administra usuarios o roles
create policy "roles de usuario lectura" on public.user_roles for select
  using (user_id = auth.uid() or public.is_super_admin()
         or (public.tenant_visible(tenant_id) and (public.has_permission('usuarios','ver') or public.has_permission('roles','ver'))));
-- Ajustes de asistencia: solo del personal que se puede ver
create policy "ajustes lectura" on public.attendance_adjustments for select
  using (public.tenant_visible(tenant_id) and public.has_permission('asistencia','ver')
         and exists (select 1 from public.attendance_daily a where a.id = attendance_id
                     and (public.ve_toda_empresa() or a.employee_id = any(public.my_employee_ids()))));
-- Historial de importaciones: módulos de importación o calidad de datos
create policy "importaciones lectura" on public.biometric_imports for select
  using (public.tenant_visible(tenant_id)
         and (public.has_permission('importaciones','ver') or public.has_permission('datos','ver') or public.has_permission('asistencia','editar')));

/* ---------- 5. Funciones ---------- */
-- Internas: solo las usan otras funciones o triggers
revoke execute on function public.asignar_empleador_por_grupo(uuid) from public, anon, authenticated;
revoke execute on function public.copias_en_csv(uuid, timestamp, text, text, text) from public, anon, authenticated;
revoke execute on function public.cuenta_como_marcacion(uuid, text, text) from public, anon, authenticated;

-- Sin sesión no se ejecuta nada: se conserva el acceso explícito de usuarios autenticados y del servidor
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as firma, has_function_privilege('authenticated', p.oid, 'execute') as auth_ok
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f'
  loop
    if f.auth_ok then execute format('grant execute on function %s to authenticated', f.firma); end if;
    execute format('grant execute on function %s to service_role', f.firma);
    execute format('revoke execute on function %s from public, anon', f.firma);
  end loop;
end $$;
alter default privileges in schema public revoke execute on functions from public, anon;
