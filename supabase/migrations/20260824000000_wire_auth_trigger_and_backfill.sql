-- Migration 20260824000000: Wire auth trigger and backfill existing auth users into public.users
-- 
-- ROOT CAUSE: handle_new_pos_user() function was created in 20260821000000 but the
-- CREATE TRIGGER statement that attaches it to auth.users was missing.
-- This caused Supabase Auth signups to NOT automatically provision a public.users row,
-- meaning every login returned "no POS employee profile" despite HTTP 200 from Supabase Auth.
--
-- FIX:
--   1. Create the missing trigger on auth.users
--   2. Backfill existing auth.users records that have no corresponding public.users row
--   3. Ensure the trigger function handles role_id gracefully (it was missing role_id)
--
-- Safe, additive, idempotent.

-- ============================================================================
-- 1. Update handle_new_pos_user to also set role_id from roles table
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_pos_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_role_code TEXT;
  v_role_id   TEXT;
BEGIN
  v_role_code := COALESCE(NEW.raw_user_meta_data ->> 'role_code', 'cashier');

  -- Resolve role_id from roles table; fall back gracefully if not seeded yet
  SELECT id INTO v_role_id
  FROM public.roles
  WHERE code = v_role_code
  LIMIT 1;

  INSERT INTO public.users (
    id,
    auth_user_id,
    username,
    email,
    password_hash,
    full_name,
    role_id,
    role_code,
    is_active,
    failed_login_attempts,
    sync_status,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id::text,
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'username', split_part(NEW.email, '@', 1)),
    LOWER(NEW.email),
    'supabase-managed',
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', split_part(NEW.email, '@', 1)),
    v_role_id,
    v_role_code,
    true,
    0,
    'synced',
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO UPDATE
    SET auth_user_id = EXCLUDED.auth_user_id,
        email        = EXCLUDED.email,
        updated_at   = NOW();

  RETURN NEW;
END;
$function$;

-- ============================================================================
-- 2. Create the missing trigger on auth.users
-- ============================================================================

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_pos_user();

-- ============================================================================
-- 3. Backfill existing auth.users that have no public.users row
-- ============================================================================

DO $$
DECLARE
  v_role_code TEXT;
  v_role_id   TEXT;
  r           RECORD;
BEGIN
  FOR r IN
    SELECT a.id, a.email, a.raw_user_meta_data
    FROM auth.users a
    WHERE NOT EXISTS (
      SELECT 1 FROM public.users u WHERE u.auth_user_id = a.id
    )
  LOOP
    v_role_code := COALESCE(r.raw_user_meta_data ->> 'role_code', 'admin');

    SELECT id INTO v_role_id
    FROM public.roles
    WHERE code = v_role_code
    LIMIT 1;

    -- If no role found, try 'admin' as default
    IF v_role_id IS NULL THEN
      SELECT id INTO v_role_id FROM public.roles WHERE code = 'admin' LIMIT 1;
      v_role_code := 'admin';
    END IF;

    INSERT INTO public.users (
      id,
      auth_user_id,
      username,
      email,
      password_hash,
      full_name,
      role_id,
      role_code,
      is_active,
      failed_login_attempts,
      sync_status,
      created_at,
      updated_at
    )
    VALUES (
      r.id::text,
      r.id,
      COALESCE(r.raw_user_meta_data ->> 'username', split_part(r.email, '@', 1)),
      LOWER(r.email),
      'supabase-managed',
      COALESCE(r.raw_user_meta_data ->> 'full_name', split_part(r.email, '@', 1)),
      v_role_id,
      v_role_code,
      true,
      0,
      'synced',
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO UPDATE
      SET auth_user_id = EXCLUDED.auth_user_id,
          email        = EXCLUDED.email,
          updated_at   = NOW();
  END LOOP;
END $$;

-- ============================================================================
-- 4. Also link any existing public.users rows matched by email (legacy)
-- ============================================================================

UPDATE public.users u
SET auth_user_id = a.id,
    updated_at   = NOW()
FROM auth.users a
WHERE LOWER(u.email) = LOWER(a.email)
  AND u.auth_user_id IS NULL;
