import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

/**
 * Cliente sin tipado estricto de tablas, usado por las pantallas genéricas
 * que reciben el nombre de la tabla como parámetro.
 */
export const dbAny = supabase as unknown as SupabaseClient;
