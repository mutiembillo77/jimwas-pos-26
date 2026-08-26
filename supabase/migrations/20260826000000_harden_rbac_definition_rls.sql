-- Migration: 20260826000000_harden_rbac_definition_rls.sql
-- GAP-2: Harden RBAC definition tables (roles, permissions) Row Level Security
--
-- SECURITY BOUNDARY:
--   - Any active POS user may SELECT roles and permissions (required for
--     permission resolution, route guards, and offline auth snapshots).
--   - Only administrators may INSERT, UPDATE, or DELETE RBAC definitions.
--   - No authenticated user can manipulate the authorization graph from which
--     their own privileges derive.
--
-- VULNERABILITY FIXED:
--   Legacy policies "roles_write" and "permissions_write" used FOR ALL with
--   USING (true), granting every database principal (including unauthenticated
--   users via the `public` role) unrestricted write access to RBAC definition
--   tables. A cashier could:
--     - Modify role.permissions[] to grant themselves admin capabilities
--     - Insert a custom role with elevated permissions
--     - Delete system roles or permissions
--   All attack vectors are confirmed exploitable against ddxthibctyfplcrzwdve
--   prior to this migration.
--
-- ARCHITECTURE NOTE:
--   Permissions are stored as TEXT[] in roles.permissions (no junction table).
--   The application syncs roles/permissions from Supabase → IndexedDB (read-
--   only pull in sync.ts). All client-side reads use IndexedDB (getAllRoles,
--   getAllPermissions in db.ts). Supabase is the source-of-truth authority.
--
-- GRANTS UNCHANGED:
--   is_pos_admin() and is_active_pos_user() are SECURITY DEFINER functions
--   already in place from migration 20260821000000. No new function grants
--   are required.

-- ============================================================================
-- 1. ROLES TABLE: Drop legacy unrestricted policies
-- ============================================================================

-- Drop the original legacy policy from 006_security_rbac_schema.sql
DROP POLICY IF EXISTS "roles_write" ON public.roles;
DROP POLICY IF EXISTS "roles_read"  ON public.roles;

-- Drop any from the 20260714104830 batch (may or may not exist on remote)
DROP POLICY IF EXISTS "select_roles" ON public.roles;
DROP POLICY IF EXISTS "insert_roles" ON public.roles;
DROP POLICY IF EXISTS "update_roles" ON public.roles;
DROP POLICY IF EXISTS "delete_roles" ON public.roles;

-- ============================================================================
-- 2. ROLES TABLE: Create narrowly scoped policies
-- ============================================================================

-- Active POS users may read role definitions.
-- Required for: permission resolution, role display, offline snapshot.
CREATE POLICY "roles_select_pos"
  ON public.roles
  FOR SELECT
  TO authenticated
  USING (public.is_active_pos_user());

-- Only administrators may insert new roles.
CREATE POLICY "roles_insert_admin"
  ON public.roles
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_pos_admin());

-- Only administrators may update existing roles.
-- This specifically prevents non-admin users from modifying the
-- permissions[] array to escalate their own authorization.
CREATE POLICY "roles_update_admin"
  ON public.roles
  FOR UPDATE
  TO authenticated
  USING  (public.is_pos_admin())
  WITH CHECK (public.is_pos_admin());

-- Only administrators may delete roles.
-- System roles (is_system = true) are protected by application logic;
-- the RLS layer enforces the administrator boundary.
CREATE POLICY "roles_delete_admin"
  ON public.roles
  FOR DELETE
  TO authenticated
  USING (public.is_pos_admin());

-- ============================================================================
-- 3. PERMISSIONS TABLE: Drop legacy unrestricted policies
-- ============================================================================

DROP POLICY IF EXISTS "permissions_write" ON public.permissions;
DROP POLICY IF EXISTS "permissions_read"  ON public.permissions;

-- Drop any from the 20260714104830 batch
DROP POLICY IF EXISTS "select_permissions" ON public.permissions;
DROP POLICY IF EXISTS "insert_permissions" ON public.permissions;
DROP POLICY IF EXISTS "update_permissions" ON public.permissions;
DROP POLICY IF EXISTS "delete_permissions" ON public.permissions;

-- ============================================================================
-- 4. PERMISSIONS TABLE: Create narrowly scoped policies
-- ============================================================================

-- Active POS users may read permission definitions.
-- Required for: permission matrix, offline auth snapshot generation,
-- and UI feature-flag resolution via the permission names stored in roles.
CREATE POLICY "permissions_select_pos"
  ON public.permissions
  FOR SELECT
  TO authenticated
  USING (public.is_active_pos_user());

-- Only administrators may insert new permission definitions.
CREATE POLICY "permissions_insert_admin"
  ON public.permissions
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_pos_admin());

-- Only administrators may update permission definitions.
CREATE POLICY "permissions_update_admin"
  ON public.permissions
  FOR UPDATE
  TO authenticated
  USING  (public.is_pos_admin())
  WITH CHECK (public.is_pos_admin());

-- Only administrators may delete permission definitions.
CREATE POLICY "permissions_delete_admin"
  ON public.permissions
  FOR DELETE
  TO authenticated
  USING (public.is_pos_admin());

-- ============================================================================
-- 5. VERIFICATION NOTE
-- ============================================================================
-- After this migration:
--   SELECT on roles/permissions   → allowed for is_active_pos_user()
--   INSERT/UPDATE/DELETE on both  → allowed only for is_pos_admin()
--   Unauthenticated (anon)        → blocked (no policy grants TO anon)
--   service_role                  → bypasses RLS by PostgreSQL design
--
-- No junction tables exist (permissions stored as TEXT[] in roles.permissions).
-- The GAP-1 trigger (enforce_user_update_privileges) already prevents any
-- user from escalating their own role_code/role_id through the users table.
-- This migration closes the complementary attack vector of escalating via
-- direct RBAC definition manipulation.
