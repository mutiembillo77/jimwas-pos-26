DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT tgname
    FROM pg_trigger
    WHERE tgrelid = 'auth.users'::regclass
      AND NOT tgisinternal
  LOOP
    RAISE NOTICE 'Dropping trigger % on auth.users', t.tgname;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON auth.users CASCADE;', t.tgname);
  END LOOP;
END $$;
