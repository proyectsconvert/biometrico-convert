-- Migración 0059: Permiso «Cálculo horas extra» en Control diario
-- Controla quién ve las horas extra, nocturnas y recargos (columna «Extras», desglose por tipo y
-- recargo, «Cómo se calculó», y esas columnas en el detalle por día de Novedades y en la exportación).
-- Se asigna desde Roles y permisos; de inicio solo Administración y Nómina (el Super Administrador
-- tiene todos los permisos).

insert into public.permissions (module, action, label)
select 'asistencia', 'calculo_horas_extra', 'Cálculo horas extra (desglose de extras, nocturnas y recargos)'
where not exists (select 1 from public.permissions where module = 'asistencia' and action = 'calculo_horas_extra');

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.module = 'asistencia' and p.action = 'calculo_horas_extra'
where r.code in ('admin', 'nomina')
  and not exists (select 1 from public.role_permissions x where x.role_id = r.id and x.permission_id = p.id);
