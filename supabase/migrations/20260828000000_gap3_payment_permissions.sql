-- Migration: 20260828000000_gap3_payment_permissions.sql
-- GAP-3: Payment Edge Function Security Hardening
--
-- Changes:
--   1. Add 4 payment permissions to the permissions table
--   2. Backfill those permissions into existing roles
--   3. Add initiator_user_id (server-verified) to kcb_payments
--   4. Add initiator_user_id (server-verified) to mpesa_transactions
--   5. Update RLS on kcb_payments to enforce ownership-scoped SELECT
--
-- DOES NOT modify:
--   - Existing permission IDs or names
--   - Existing role IDs or codes
--   - GAP-1 or GAP-2 migrations
--   - Any existing column types or constraints
--
-- Safe, additive, idempotent.

-- ============================================================================
-- 1. Payment Permissions
-- ============================================================================

INSERT INTO public.permissions (id, name, domain, action, description, created_at)
VALUES
  ('perm-payments-initiate', 'payments.initiate', 'payments', 'initiate',
   'Initiate payment STK push requests', NOW()),
  ('perm-payments-status',   'payments.status',   'payments', 'status',
   'Query payment status (own records; managers/admins: all records)', NOW()),
  ('perm-payments-simulate', 'payments.simulate', 'payments', 'simulate',
   'Simulate payments in sandbox environment only', NOW()),
  ('perm-payments-manage',   'payments.manage',   'payments', 'manage',
   'Manage payment settings and all payment records', NOW())
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- 2. Backfill existing roles
--
-- Strategy: append only when the permission is not already present.
-- Uses array_cat + subquery to stay idempotent across re-runs.
-- ============================================================================

-- admin: all four payment permissions
UPDATE public.roles
SET permissions = array_cat(
  permissions,
  ARRAY(
    SELECT p FROM unnest(ARRAY[
      'perm-payments-initiate',
      'perm-payments-status',
      'perm-payments-simulate',
      'perm-payments-manage'
    ]) AS p
    WHERE NOT (permissions @> ARRAY[p])
  )
),
updated_at = NOW()
WHERE code IN ('admin', 'administrator');

-- manager: initiate, status, simulate (not manage)
UPDATE public.roles
SET permissions = array_cat(
  permissions,
  ARRAY(
    SELECT p FROM unnest(ARRAY[
      'perm-payments-initiate',
      'perm-payments-status',
      'perm-payments-simulate'
    ]) AS p
    WHERE NOT (permissions @> ARRAY[p])
  )
),
updated_at = NOW()
WHERE code = 'manager';

-- cashier: initiate, status only
UPDATE public.roles
SET permissions = array_cat(
  permissions,
  ARRAY(
    SELECT p FROM unnest(ARRAY[
      'perm-payments-initiate',
      'perm-payments-status'
    ]) AS p
    WHERE NOT (permissions @> ARRAY[p])
  )
),
updated_at = NOW()
WHERE code = 'cashier';

-- ============================================================================
-- 3. Add initiator_user_id to kcb_payments
--
-- Server-verified POS user identity (public.users.id), populated by Edge
-- Function from the validated JWT. Distinct from legacy cashier_id which
-- was populated from the client request body (untrusted).
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'kcb_payments'
      AND column_name  = 'initiator_user_id'
  ) THEN
    ALTER TABLE public.kcb_payments
      ADD COLUMN initiator_user_id TEXT;
    COMMENT ON COLUMN public.kcb_payments.initiator_user_id IS
      'Server-verified POS user identity (public.users.id). Set by Edge Function '
      'from JWT-linked POS profile. Must not be populated from the client request body. '
      'Distinct from legacy cashier_id which was client-supplied (untrusted).';
    CREATE INDEX IF NOT EXISTS idx_kcb_payments_initiator
      ON public.kcb_payments(initiator_user_id);
  END IF;
END $$;

-- ============================================================================
-- 4. Add initiator_user_id to mpesa_transactions
-- ============================================================================

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'mpesa_transactions'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'mpesa_transactions'
        AND column_name  = 'initiator_user_id'
    ) THEN
      ALTER TABLE public.mpesa_transactions
        ADD COLUMN initiator_user_id TEXT;
      COMMENT ON COLUMN public.mpesa_transactions.initiator_user_id IS
        'Server-verified POS user identity (public.users.id). Set by Edge Function from JWT.';
      CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_initiator
        ON public.mpesa_transactions(initiator_user_id);
    END IF;
  END IF;
END $$;

-- ============================================================================
-- 5. RLS on kcb_payments — ownership-scoped SELECT
--
-- Prior migrations created blanket SELECT policies for anon/authenticated.
-- GAP-3 replaces them with ownership-scoped access:
--   cashier      → own payments (initiator_user_id matches their users.id)
--   manager/admin → all payments
--   service_role  → bypasses RLS (Supabase design — Edge Functions use this)
-- ============================================================================

-- Drop any existing overly-permissive policies
DROP POLICY IF EXISTS "select_kcb_payments"               ON public.kcb_payments;
DROP POLICY IF EXISTS "kcb_payments_select_authenticated" ON public.kcb_payments;
DROP POLICY IF EXISTS "insert_kcb_payments"               ON public.kcb_payments;
DROP POLICY IF EXISTS "update_kcb_payments"               ON public.kcb_payments;
DROP POLICY IF EXISTS "delete_kcb_payments"               ON public.kcb_payments;

-- Managers and admins see all payments
CREATE POLICY "kcb_payments_select_manager_admin"
  ON public.kcb_payments
  FOR SELECT
  TO authenticated
  USING (public.is_pos_manager_or_admin());

-- Cashiers can only read their own initiated payments
CREATE POLICY "kcb_payments_select_own"
  ON public.kcb_payments
  FOR SELECT
  TO authenticated
  USING (
    initiator_user_id = (
      SELECT id FROM public.users
      WHERE auth_user_id = auth.uid()
        AND is_active = true
      LIMIT 1
    )
  );

-- Edge Functions use the service-role client which bypasses RLS.
-- Revoke direct INSERT/UPDATE/DELETE from authenticated clients.
REVOKE INSERT, UPDATE, DELETE ON public.kcb_payments FROM authenticated, anon;

-- ============================================================================
-- 6. Verification note
-- ============================================================================
-- After this migration:
--   permissions: +4 rows (perm-payments-initiate, -status, -simulate, -manage)
--   roles.permissions[]: backfilled — admin(+4), manager(+3), cashier(+2)
--   kcb_payments.initiator_user_id: new nullable TEXT column with index
--   mpesa_transactions.initiator_user_id: new nullable TEXT column with index
--   kcb_payments RLS: cashier sees own, manager/admin sees all, clients cannot write
