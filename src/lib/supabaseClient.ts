import { createClient, SupabaseClient } from '@supabase/supabase-js';

function getValidEnv(...keys: (string | undefined | null)[]): string | undefined {
  for (const k of keys) {
    if (typeof k === 'string' && k.trim().length > 0) {
      return k.trim();
    }
  }
  return undefined;
}

// Only VITE_* variables are exposed to the browser by Vite.
// NEXT_PUBLIC_* and bare SUPABASE_* are server-side only and must
// never be used here — they would silently resolve to undefined.
const url = getValidEnv(
  import.meta.env.VITE_SUPABASE_URL
);

const anonKey = getValidEnv(
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
);

let _supabase: SupabaseClient | null = null;

if (url && anonKey) {
  _supabase = createClient(url, anonKey);
}

export const isSupabaseConfigured = (): boolean => {
  return Boolean(url && anonKey && _supabase);
};

export const initialAuthRedirectError: string | null = null;
export const supabase = _supabase;
export default supabase;

