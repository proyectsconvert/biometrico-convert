-- Migración 0070: Supervisor de área (calidad, formación, BO…): ve a las personas por su CARGO, no por campaña
-- * Nuevo alcance «cargos_asignados»: el rol ve solo a los empleados cuyo cargo está en user_roles.cargos
--   (p. ej. ANALISTA DE CALIDAD), estén en la campaña o centro de costo que estén, y su propia información.
--   No ve campañas ni centros de costo (sus campaign_ids quedan vacíos).
-- * El coordinador y el supervisor de campaña siguen igual: ven a todos los de sus campañas, incluidos los
--   analistas de calidad y formadores de esas campañas.
-- * Nuevo rol del sistema «Supervisor de área» con los mismos permisos que «Supervisor».
-- Nota: el valor del enum se agrega en una sentencia aparte (no se puede usar en la misma transacción);
-- por eso las funciones comparan scope::text.

alter type public.app_scope add value if not exists 'cargos_asignados';
