-- Migración 0031: El servidor puede esperar su turno al procesar varios archivos a la vez
-- PostgREST aplica lock_timeout=8s (rol authenticator). El procesamiento de cada archivo se
-- serializa con un candado; con 4-5 archivos simultáneos, la espera superaba 8 s y se cancelaba
-- («canceling statement due to lock timeout»). El rol service_role (solo servidor) espera más.
alter role service_role set lock_timeout = '10min';
