-- Migration: Financial Environment Isolation
-- Adds immutable `environment` classification to all canonical financial records.
--
-- Architecture decision: JIMWAS POS uses ONE Supabase project (ddxthibctyfplcrzwdve)
-- for ALL environments. Data isolation is enforced at the RECORD level via this column.
--
-- Safe, additive, idempotent. Does NOT drop or recreate tables. Does NOT delete data.
--
-- Historical data classification:
-- All existing records are classified as SANDBOX.
-- Rationale: As of 2026-08-22, no verified production transactions exist in the database.
-- The project (ddxthibctyfplcrzwdve) was provisioned on 2026-08-15 and has never had
-- production-grade credentials or a production go-live. All prior data is confirmed sandbox/test.
--
-- DO NOT use this migration's DEFAULT as precedent for future historical data.
-- Future production deployments MUST stamp environment at creation time.

-- ============================================================================
-- 1. Create the environment type
-- ============================================================================
DO $$ BEGIN
  CREATE TYPE environment_type AS ENUM ('SANDBOX', 'PRODUCTION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- 2. transactions — canonical economic sale record
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'environment'
  ) THEN
    ALTER TABLE public.transactions
      ADD COLUMN environment environment_type NOT NULL DEFAULT 'SANDBOX';
    COMMENT ON COLUMN public.transactions.environment IS
      'Immutable financial environment. SANDBOX=test/dev/preview, PRODUCTION=live. Set at creation. Must not be changed after creation.';
    CREATE INDEX IF NOT EXISTS idx_transactions_environment ON public.transactions(environment);
  END IF;
END $$;

-- ============================================================================
-- 3. payment — internal payment record (provider-agnostic)
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment' AND column_name = 'environment'
  ) THEN
    ALTER TABLE public.payment
      ADD COLUMN environment environment_type NOT NULL DEFAULT 'SANDBOX';
    COMMENT ON COLUMN public.payment.environment IS
      'Immutable financial environment. Must match the parent transaction.environment.';
    CREATE INDEX IF NOT EXISTS idx_payment_environment ON public.payment(environment);
  END IF;
END $$;

-- ============================================================================
-- 4. kcb_payments — KCB BUNI / M-Pesa provider communication record
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'kcb_payments' AND column_name = 'environment'
  ) THEN
    ALTER TABLE public.kcb_payments
      ADD COLUMN environment environment_type NOT NULL DEFAULT 'SANDBOX';
    COMMENT ON COLUMN public.kcb_payments.environment IS
      'Provider environment. SANDBOX=KCB sandbox/UAT, PRODUCTION=KCB live. Callback settlement is only permitted when provider environment matches this value.';
    CREATE INDEX IF NOT EXISTS idx_kcb_payments_environment ON public.kcb_payments(environment);
  END IF;
END $$;

-- ============================================================================
-- 5. ledger_entries — accounting representation
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ledger_entries' AND column_name = 'environment'
  ) THEN
    ALTER TABLE public.ledger_entries
      ADD COLUMN environment environment_type NOT NULL DEFAULT 'SANDBOX';
    COMMENT ON COLUMN public.ledger_entries.environment IS
      'Inherited from source transaction. SANDBOX entries must not appear in PRODUCTION reports.';
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_environment ON public.ledger_entries(environment);
  END IF;
END $$;

-- ============================================================================
-- 6. shifts — shift/cashier session records
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shifts' AND column_name = 'environment'
  ) THEN
    ALTER TABLE public.shifts
      ADD COLUMN environment environment_type NOT NULL DEFAULT 'SANDBOX';
    COMMENT ON COLUMN public.shifts.environment IS
      'Financial environment for this shift. Cashbook/shift reports must filter by environment.';
  END IF;
END $$;

-- ============================================================================
-- 7. reconciliations — payment matching/control records
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'reconciliations' AND column_name = 'environment'
  ) THEN
    ALTER TABLE public.reconciliations
      ADD COLUMN environment environment_type NOT NULL DEFAULT 'SANDBOX';
    COMMENT ON COLUMN public.reconciliations.environment IS
      'A SANDBOX provider record must never reconcile against a PRODUCTION transaction.';
    CREATE INDEX IF NOT EXISTS idx_reconciliations_environment ON public.reconciliations(environment);
  END IF;
END $$;

-- ============================================================================
-- 8. refund_requests — refund reversal records
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'refund_requests' AND column_name = 'environment'
  ) THEN
    ALTER TABLE public.refund_requests
      ADD COLUMN environment environment_type NOT NULL DEFAULT 'SANDBOX';
    COMMENT ON COLUMN public.refund_requests.environment IS
      'Inherited from source transaction. A SANDBOX refund must not reduce PRODUCTION revenue.';
  END IF;
END $$;

-- ============================================================================
-- 9. void_requests — sale void records
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'void_requests' AND column_name = 'environment'
  ) THEN
    ALTER TABLE public.void_requests
      ADD COLUMN environment environment_type NOT NULL DEFAULT 'SANDBOX';
    COMMENT ON COLUMN public.void_requests.environment IS
      'Inherited from source transaction. A SANDBOX void must not remove PRODUCTION revenue.';
  END IF;
END $$;

-- ============================================================================
-- 10. installment_plans — credit sale plans
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'installment_plans' AND column_name = 'environment'
  ) THEN
    ALTER TABLE public.installment_plans
      ADD COLUMN environment environment_type NOT NULL DEFAULT 'SANDBOX';
    COMMENT ON COLUMN public.installment_plans.environment IS
      'Inherited from originating sale. Installment payments must match.';
  END IF;
END $$;

-- ============================================================================
-- 11. safe_drops — cash management records
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'safe_drops' AND column_name = 'environment'
  ) THEN
    ALTER TABLE public.safe_drops
      ADD COLUMN environment environment_type NOT NULL DEFAULT 'SANDBOX';
    COMMENT ON COLUMN public.safe_drops.environment IS
      'SANDBOX safe drops must not affect PRODUCTION cashbook totals.';
  END IF;
END $$;
