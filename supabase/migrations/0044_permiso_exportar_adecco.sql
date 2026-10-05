-- Permiso para descargar el archivo de Adecco (solo horas de novedades aprobadas).
-- Por defecto: Nómina, Administrador y Super Administrador; se puede delegar a otros roles en Roles y permisos.
insert into public.permissions (module, action, label)
select 'novedades', 'exportar_adecco', 'Exportar Adecco (horas aprobadas)'
where not exists (select 1 from public.permissions where module = 'novedades' and action = 'exportar_adecco');

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('super_admin', 'admin', 'nomina')
  and p.module = 'novedades' and p.action = 'exportar_adecco'
  and not exists (select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id);
