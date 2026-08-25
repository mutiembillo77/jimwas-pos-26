-- Migration 20260825000005: Harden public.users self-update authorization and prevent privilege escalation (GAP-1)
--
-- SECURITY INVARIANT:
-- A non-administrator must NEVER be able to modify authorization-sensitive identity fields
-- (role_code, role_id, is_active, auth_user_id, email, username, created_by, created_at)
-- even if directly calling Supabase with an authenticated JWT.
--
-- ARCHITECTURE:
-- 1. Replace vulnerable "users_update_admin_or_self" RLS policy with distinct policies:
--    - "users_update_admin": full update rights for authenticated administrators.
--    - "users_update_self": restricted self-update rights for active users on their own row.
-- 2. PostgreSQL BEFORE UPDATE trigger function "enforce_user_update_privileges()":
--    - If caller is admin (is_pos_admin() = true) or internal service role: allow full update.
--    - If caller is non-admin: reject any modification to role_code, role_id, is_active,
--      auth_user_id, email, username, created_by, or created_at with SQLSTATE 42501.
--    - Permitted self-service profile fields (e.g. full_name, last_login_at, failed_login_attempts,
--      locked_until, branch_id, branch_name, updated_at, sync_status) are allowed.

-- ============================================================================
-- 1. Trigger Function to Enforce Column-Level Immutability on Self-Update
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_user_update_privileges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  -- Administrators and service role bypass column restrictions
  IF public.is_pos_admin() OR (auth.jwt() ->> 'role') = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Non-administrator checks: strictly forbid privilege escalation and identity tampering
  IF NEW.role_code IS DISTINCT FROM OLD.role_code THEN
    RAISE EXCEPTION 'Unauthorized: Only administrators can modify user role_code'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.role_id IS DISTINCT FROM OLD.role_id THEN
    RAISE EXCEPTION 'Unauthorized: Only administrators can modify user role_id'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    RAISE EXCEPTION 'Unauthorized: Only administrators can modify user is_active status'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id THEN
    RAISE EXCEPTION 'Unauthorized: Cannot reassign or modify auth_user_id'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'Unauthorized: Email is managed through Supabase Auth'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'Unauthorized: Only administrators can modify username'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Unauthorized: Cannot modify created_by'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Unauthorized: Cannot modify created_at'
      USING ERRCODE = '42501';
  END IF;

  -- Always ensure updated_at is refreshed on update
  NEW.updated_at := NOW();

  RETURN NEW;
END;
$$;

-- Grant execution to authenticated users and service_role
REVOKE EXECUTE ON FUNCTION public.enforce_user_update_privileges() FROM public;
GRANT EXECUTE ON FUNCTION public.enforce_user_update_privileges() TO authenticated, service_role;

-- Attach trigger to public.users
DROP TRIGGER IF EXISTS trg_enforce_user_update_privileges ON public.users;

CREATE TRIGGER trg_enforce_user_update_privileges
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_user_update_privileges();

-- ============================================================================
-- 2. Refine RLS Policies on public.users
-- ============================================================================

DROP POLICY IF EXISTS "users_update_admin_or_self" ON public.users;
DROP POLICY IF EXISTS "users_update_admin" ON public.users;
DROP POLICY IF EXISTS "users_update_self" ON public.users;

-- Admin update policy: full update access
CREATE POLICY "users_update_admin" ON public.users
  FOR UPDATE TO authenticated
  USING (public.is_pos_admin())
  WITH CHECK (public.is_pos_admin());

-- Self update policy: active user can update their own row (further restricted by trigger)
CREATE POLICY "users_update_self" ON public.users
  FOR UPDATE TO authenticated
  USING (auth_user_id = auth.uid() AND public.is_active_pos_user())
  WITH CHECK (auth_user_id = auth.uid());
