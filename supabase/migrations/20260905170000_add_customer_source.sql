-- Migration: Add Customer Source for Acquisition Intelligence
-- Safe, additive, idempotent migration. Does not drop or delete existing data.
-- Preserves all historical customer records without data mutation.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'customer_source'
  ) THEN
    ALTER TABLE public.customers ADD COLUMN customer_source VARCHAR(20) DEFAULT 'UNKNOWN';
    
    -- Add check constraint for valid source channels
    ALTER TABLE public.customers ADD CONSTRAINT chk_customer_source 
      CHECK (customer_source IN ('FACEBOOK', 'WHATSAPP', 'INSTAGRAM', 'WALK_IN', 'REFERRAL', 'OTHER', 'UNKNOWN'));
      
    COMMENT ON COLUMN public.customers.customer_source IS 'Customer acquisition channel: FACEBOOK, WHATSAPP, INSTAGRAM, WALK_IN, REFERRAL, OTHER, UNKNOWN';
  END IF;
END $$;
