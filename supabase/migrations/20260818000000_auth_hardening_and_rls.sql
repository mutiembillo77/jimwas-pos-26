-- Migration 20260818000000: Supabase Auth Hardening, auth_user_id linkage, and Role-Based RLS Policies

-- 1. Add auth_user_id column to public.users if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'auth_user_id'
  ) THEN
    ALTER TABLE public.users ADD COLUMN auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 2. Create Unique Partial Index on auth_user_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_user_id
ON public.users(auth_user_id)
WHERE auth_user_id IS NOT NULL;

-- 3. Secure Helper Functions for POS Authentication & RBAC

-- Secure lookup for username login (returns only the registered email for an active user)
CREATE OR REPLACE FUNCTION public.get_auth_email_for_username(p_username text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT email FROM public.users
  WHERE LOWER(username) = LOWER(TRIM(p_username)) AND is_active = true
  LIMIT 1;
$$;

-- Check if current authenticated user has an active POS user profile
CREATE OR REPLACE FUNCTION public.is_active_pos_user()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid() AND is_active = true
  );
$$;

-- Get role code of current authenticated POS user
CREATE OR REPLACE FUNCTION public.get_pos_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT role_code FROM public.users
  WHERE auth_user_id = auth.uid() AND is_active = true
  LIMIT 1;
$$;

-- Check if current authenticated POS user is an admin
CREATE OR REPLACE FUNCTION public.is_pos_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid() AND is_active = true AND role_code IN ('admin', 'administrator')
  );
$$;

-- Check if current authenticated POS user is manager or admin
CREATE OR REPLACE FUNCTION public.is_pos_manager_or_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid() AND is_active = true AND role_code IN ('admin', 'administrator', 'manager')
  );
$$;

-- 4. Harden RLS on Core Tables (Drop permissive anon policies and enforce authenticated active POS user access)

-- USERS Table
DROP POLICY IF EXISTS "select_users" ON public.users;
DROP POLICY IF EXISTS "insert_users" ON public.users;
DROP POLICY IF EXISTS "update_users" ON public.users;
DROP POLICY IF EXISTS "delete_users" ON public.users;

CREATE POLICY "users_select_authenticated" ON public.users
  FOR SELECT TO authenticated
  USING (is_active_pos_user() OR auth_user_id = auth.uid() OR is_pos_admin());

CREATE POLICY "users_insert_admin" ON public.users
  FOR INSERT TO authenticated
  WITH CHECK (is_pos_admin());

CREATE POLICY "users_update_admin_or_self" ON public.users
  FOR UPDATE TO authenticated
  USING (is_pos_admin() OR auth_user_id = auth.uid())
  WITH CHECK (is_pos_admin() OR auth_user_id = auth.uid());

CREATE POLICY "users_delete_admin" ON public.users
  FOR DELETE TO authenticated
  USING (is_pos_admin());

-- PRODUCTS Table
DROP POLICY IF EXISTS "select_products" ON public.products;
DROP POLICY IF EXISTS "insert_products" ON public.products;
DROP POLICY IF EXISTS "update_products" ON public.products;
DROP POLICY IF EXISTS "delete_products" ON public.products;

CREATE POLICY "products_select_pos" ON public.products
  FOR SELECT TO authenticated
  USING (is_active_pos_user());

CREATE POLICY "products_insert_pos" ON public.products
  FOR INSERT TO authenticated
  WITH CHECK (is_pos_manager_or_admin());

CREATE POLICY "products_update_pos" ON public.products
  FOR UPDATE TO authenticated
  USING (is_pos_manager_or_admin())
  WITH CHECK (is_pos_manager_or_admin());

CREATE POLICY "products_delete_admin" ON public.products
  FOR DELETE TO authenticated
  USING (is_pos_admin());

-- CUSTOMERS Table
DROP POLICY IF EXISTS "select_customers" ON public.customers;
DROP POLICY IF EXISTS "insert_customers" ON public.customers;
DROP POLICY IF EXISTS "update_customers" ON public.customers;
DROP POLICY IF EXISTS "delete_customers" ON public.customers;

CREATE POLICY "customers_select_pos" ON public.customers
  FOR SELECT TO authenticated
  USING (is_active_pos_user());

CREATE POLICY "customers_insert_pos" ON public.customers
  FOR INSERT TO authenticated
  WITH CHECK (is_active_pos_user());

CREATE POLICY "customers_update_pos" ON public.customers
  FOR UPDATE TO authenticated
  USING (is_active_pos_user())
  WITH CHECK (is_active_pos_user());

CREATE POLICY "customers_delete_admin" ON public.customers
  FOR DELETE TO authenticated
  USING (is_pos_admin());

-- TRANSACTIONS Table
DROP POLICY IF EXISTS "select_transactions" ON public.transactions;
DROP POLICY IF EXISTS "insert_transactions" ON public.transactions;
DROP POLICY IF EXISTS "update_transactions" ON public.transactions;
DROP POLICY IF EXISTS "delete_transactions" ON public.transactions;

CREATE POLICY "transactions_select_pos" ON public.transactions
  FOR SELECT TO authenticated
  USING (is_active_pos_user());

CREATE POLICY "transactions_insert_pos" ON public.transactions
  FOR INSERT TO authenticated
  WITH CHECK (is_active_pos_user());

CREATE POLICY "transactions_update_pos" ON public.transactions
  FOR UPDATE TO authenticated
  USING (is_pos_manager_or_admin())
  WITH CHECK (is_pos_manager_or_admin());

-- TRANSACTION_ITEMS Table
DROP POLICY IF EXISTS "select_transaction_items" ON public.transaction_items;
DROP POLICY IF EXISTS "insert_transaction_items" ON public.transaction_items;
DROP POLICY IF EXISTS "update_transaction_items" ON public.transaction_items;
DROP POLICY IF EXISTS "delete_transaction_items" ON public.transaction_items;

CREATE POLICY "transaction_items_select_pos" ON public.transaction_items
  FOR SELECT TO authenticated
  USING (is_active_pos_user());

CREATE POLICY "transaction_items_insert_pos" ON public.transaction_items
  FOR INSERT TO authenticated
  WITH CHECK (is_active_pos_user());

CREATE POLICY "transaction_items_update_pos" ON public.transaction_items
  FOR UPDATE TO authenticated
  USING (is_pos_manager_or_admin())
  WITH CHECK (is_pos_manager_or_admin());

-- KCB_SETTINGS Table (Critical configuration - Admin Only)
DROP POLICY IF EXISTS "select_kcb_settings" ON public.kcb_settings;
DROP POLICY IF EXISTS "insert_kcb_settings" ON public.kcb_settings;
DROP POLICY IF EXISTS "update_kcb_settings" ON public.kcb_settings;
DROP POLICY IF EXISTS "delete_kcb_settings" ON public.kcb_settings;

CREATE POLICY "kcb_settings_select_admin" ON public.kcb_settings
  FOR SELECT TO authenticated
  USING (is_pos_admin());

CREATE POLICY "kcb_settings_insert_admin" ON public.kcb_settings
  FOR INSERT TO authenticated
  WITH CHECK (is_pos_admin());

CREATE POLICY "kcb_settings_update_admin" ON public.kcb_settings
  FOR UPDATE TO authenticated
  USING (is_pos_admin())
  WITH CHECK (is_pos_admin());

CREATE POLICY "kcb_settings_delete_admin" ON public.kcb_settings
  FOR DELETE TO authenticated
  USING (is_pos_admin());

-- AUDIT_LOGS Table (Write by all active POS users, read by managers/admins)
DROP POLICY IF EXISTS "select_audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "insert_audit_logs" ON public.audit_logs;

CREATE POLICY "audit_logs_select_manager" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (is_pos_manager_or_admin());

CREATE POLICY "audit_logs_insert_pos" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (is_active_pos_user());
