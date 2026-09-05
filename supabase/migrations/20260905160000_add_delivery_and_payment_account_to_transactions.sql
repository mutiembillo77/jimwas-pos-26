-- Migration: Add Delivery and Payment Account to Transactions
-- Safe, additive, idempotent migration. Does not drop or delete existing data.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'delivery_type'
  ) THEN
    ALTER TABLE public.transactions ADD COLUMN delivery_type TEXT DEFAULT 'none';
    COMMENT ON COLUMN public.transactions.delivery_type IS 'Delivery type option: none, to_cbd, from_cbd_300, from_cbd_500';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'delivery_fee'
  ) THEN
    ALTER TABLE public.transactions ADD COLUMN delivery_fee DECIMAL(12,2) DEFAULT 0;
    COMMENT ON COLUMN public.transactions.delivery_fee IS 'Structured transaction-level delivery charge';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'payment_account'
  ) THEN
    ALTER TABLE public.transactions ADD COLUMN payment_account TEXT;
    COMMENT ON COLUMN public.transactions.payment_account IS 'Designated payment account: KCB, NCBA, CASH, MPESA';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'discount'
  ) THEN
    ALTER TABLE public.transactions ADD COLUMN discount DECIMAL(12,2) DEFAULT 0;
    COMMENT ON COLUMN public.transactions.discount IS 'Transaction-level discount';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'subtotal'
  ) THEN
    ALTER TABLE public.transactions ADD COLUMN subtotal DECIMAL(12,2);
    COMMENT ON COLUMN public.transactions.subtotal IS 'Merchandise subtotal before delivery fee and discounts';
  END IF;
END $$;
