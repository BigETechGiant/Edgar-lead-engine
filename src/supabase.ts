/**
 * Service-role Supabase client.
 *
 * SUPABASE_URL points at the PostgREST API host (the dashboard's
 * NEXT_PUBLIC_SUPABASE_URL), NOT the Studio admin host. The service-role JWT —
 * sent in both the `apikey` and `Authorization: Bearer` headers, which the
 * supabase-js client sets automatically from the key — is the only auth the
 * REST API requires.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const supabase: SupabaseClient = createClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);
