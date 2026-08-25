-- Diagnostic: list triggers and functions on auth.users and public.users
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN 
    SELECT tgname, relname 
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname IN ('auth', 'public') AND (c.relname IN ('users', 'audit_logs'))
  LOOP
    RAISE NOTICE 'Trigger % on table %', r.tgname, r.relname;
  END LOOP;
END $$;
