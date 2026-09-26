create table public.staging_personal (doc text, nom text, car text, code text, ccname text);
alter table public.staging_personal enable row level security;
grant all on public.staging_personal to service_role;