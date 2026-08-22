-- Migration 20260821000000: Jimwas POS Production Schema Reconciliation
-- Reconciles missing tables (kcb_settings, kcb_payments, settings, ledger, operations),
-- adds public.users.auth_user_id linkage, updates helper functions, and hardens RBAC RLS policies.
-- Safe, additive, idempotent, and data-preserving.

-- ============================================================================
-- 1. USERS TABLE AUTH HARDENING & LINKAGE
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'auth_user_id'
  ) THEN
    ALTER TABLE public.users ADD COLUMN auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_user_id
ON public.users(auth_user_id)
WHERE auth_user_id IS NOT NULL;

-- Link existing administrator user by matching email / id
UPDATE public.users u
SET auth_user_id = a.id
FROM auth.users a
WHERE (u.id = a.id::text OR LOWER(u.email) = LOWER(a.email))
  AND u.auth_user_id IS NULL;

-- Update trigger function to automatically link new auth users
CREATE OR REPLACE FUNCTION public.handle_new_pos_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
begin
  insert into public.users (id, auth_user_id, username, email, password_hash, full_name, role_code, is_active, failed_login_attempts, sync_status)
  values (
    new.id::text,
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)),
    lower(new.email),
    'supabase-managed',
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'role_code', 'cashier'),
    true,
    0,
    'synced'
  )
  on conflict (id) do update set
    auth_user_id = excluded.auth_user_id,
    email = excluded.email;
  return new;
end;
$function$;

-- ============================================================================
-- 2. RBAC & AUTH HELPER FUNCTIONS (SECURITY DEFINER)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_auth_email_for_username(p_username text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = 'public'
AS $$
  SELECT email FROM public.users
  WHERE LOWER(username) = LOWER(TRIM(p_username)) AND is_active = true
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_active_pos_user()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid() AND is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.get_pos_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = 'public'
AS $$
  SELECT role_code FROM public.users
  WHERE auth_user_id = auth.uid() AND is_active = true
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_pos_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid() AND is_active = true AND role_code IN ('admin', 'administrator')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_pos_manager_or_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid() AND is_active = true AND role_code IN ('admin', 'administrator', 'manager')
  );
$$;

REVOKE EXECUTE ON FUNCTION public.get_auth_email_for_username(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_auth_email_for_username(text) TO anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_active_pos_user() FROM public;
GRANT EXECUTE ON FUNCTION public.is_active_pos_user() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_pos_role() FROM public;
GRANT EXECUTE ON FUNCTION public.get_pos_role() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_pos_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.is_pos_admin() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_pos_manager_or_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.is_pos_manager_or_admin() TO authenticated, service_role;

-- ============================================================================
-- 3. KCB BUNI SETTINGS & PAYMENTS TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.kcb_settings (
  id TEXT PRIMARY KEY,
  is_enabled BOOLEAN DEFAULT false,
  environment TEXT DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'production')),
  client_id TEXT,
  client_secret TEXT,
  org_shortcode TEXT,
  org_passkey TEXT,
  callback_url TEXT,
  timeout_url TEXT,
  public_cert_path TEXT,
  default_phone_country_code TEXT DEFAULT '254',
  business_paybill TEXT,
  business_account TEXT,
  business_name TEXT,
  last_updated TIMESTAMPTZ,
  last_updated_by TEXT REFERENCES public.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  sync_status TEXT DEFAULT 'pending'
);

ALTER TABLE public.kcb_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.kcb_settings (
  id, is_enabled, environment, client_id, client_secret, org_shortcode, org_passkey,
  default_phone_country_code, business_paybill, business_account, business_name,
  created_at, updated_at, sync_status
) VALUES (
  'kcb-settings', false, 'sandbox', '', '', '', '',
  '254', '522522', '7941675', 'JIMWASENTERPRISES',
  NOW(), NOW(), 'synced'
) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.kcb_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_request_id TEXT UNIQUE,
  merchant_request_id TEXT,
  phone_number TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending',
  result_code TEXT,
  result_desc TEXT,
  mpesa_receipt_number TEXT,
  transaction_date TEXT,
  transaction_id UUID,
  customer_id UUID,
  cashier_id TEXT,
  cashier_name TEXT,
  callback_received BOOLEAN NOT NULL DEFAULT false,
  callback_payload JSONB,
  raw_request JSONB,
  raw_response JSONB,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  last_attempt_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kcb_payments_status_created ON public.kcb_payments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kcb_payments_transaction ON public.kcb_payments(transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kcb_payments_idempotency ON public.kcb_payments(idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.kcb_payments ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 4. POS SETTINGS, OPERATIONAL & ENTERPRISE TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.business_settings (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL DEFAULT 'Jimwas Store',
  business_phone TEXT,
  business_email TEXT,
  business_address TEXT,
  tax_id TEXT,
  currency TEXT DEFAULT 'KES',
  currency_symbol TEXT DEFAULT 'KES',
  receipt_header TEXT,
  receipt_footer TEXT,
  show_tax_on_receipt BOOLEAN DEFAULT true,
  logo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  sync_status TEXT DEFAULT 'pending'
);
ALTER TABLE public.business_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.business_settings (id, business_name, business_phone, currency, currency_symbol, created_at, updated_at, sync_status)
VALUES ('business-settings', 'Jimwas Store', '', 'KES', 'KES', NOW(), NOW(), 'synced')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.payment_methods (
  id TEXT PRIMARY KEY,
  method_name TEXT NOT NULL,
  is_enabled BOOLEAN DEFAULT true,
  display_name TEXT NOT NULL,
  requires_reference BOOLEAN DEFAULT false,
  icon TEXT,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;

INSERT INTO public.payment_methods (id, method_name, is_enabled, display_name, requires_reference, display_order, created_at, updated_at) VALUES
  ('pm-cash', 'cash', true, 'Cash', false, 1, NOW(), NOW()),
  ('pm-kcb-buni', 'kcb_buni', true, 'KCB BUNI (M-Pesa)', true, 2, NOW(), NOW()),
  ('pm-ncba', 'ncba', true, 'NCBA (M-Pesa)', true, 3, NOW(), NOW()),
  ('pm-card', 'card', true, 'Card', false, 4, NOW(), NOW()),
  ('pm-bank', 'bank_transfer', false, 'Bank Transfer', true, 5, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.payment_accounts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  institution TEXT NOT NULL,
  account_type TEXT NOT NULL,
  account_number_masked TEXT,
  paybill_number TEXT,
  account_number TEXT,
  business_category TEXT DEFAULT 'ANY',
  currency TEXT DEFAULT 'KES',
  status TEXT DEFAULT 'ACTIVE',
  is_default BOOLEAN DEFAULT false,
  device_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  sync_status TEXT DEFAULT 'pending'
);
ALTER TABLE public.payment_accounts ENABLE ROW LEVEL SECURITY;

INSERT INTO public.payment_accounts (id, code, name, institution, account_type, paybill_number, account_number, account_number_masked, business_category, currency, status, is_default, created_at, updated_at, sync_status) VALUES
  ('payment-account-kcb', 'KCB-PAYBILL-522522', 'KCB A/C 7941675', 'KCB', 'MOBILE_MONEY', '522522', '7941675', '••••675', 'ANY', 'KES', 'ACTIVE', true, NOW(), NOW(), 'synced'),
  ('payment-account-ncba', 'NCBA-PAYBILL-880100', 'NCBA A/C 166294', 'NCBA', 'MOBILE_MONEY', '880100', '166294', '••••294', 'ANY', 'KES', 'ACTIVE', false, NOW(), NOW(), 'synced')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.loyalty_settings (
  id TEXT PRIMARY KEY,
  is_enabled BOOLEAN DEFAULT true,
  points_per_currency INTEGER DEFAULT 100,
  point_value NUMERIC DEFAULT 1,
  minimum_points_to_redeem INTEGER DEFAULT 10,
  signup_bonus_points INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  sync_status TEXT DEFAULT 'pending'
);
ALTER TABLE public.loyalty_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.loyalty_settings (id, is_enabled, points_per_currency, point_value, minimum_points_to_redeem, signup_bonus_points, created_at, updated_at, sync_status)
VALUES ('loyalty-settings', true, 100, 1, 10, 0, NOW(), NOW(), 'synced')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.receipt_settings (
  id TEXT PRIMARY KEY,
  show_customer_name BOOLEAN DEFAULT true,
  show_customer_phone BOOLEAN DEFAULT false,
  show_item_barcode BOOLEAN DEFAULT false,
  show_item_sku BOOLEAN DEFAULT false,
  show_cashier_name BOOLEAN DEFAULT true,
  show_branch_name BOOLEAN DEFAULT false,
  show_tax_breakdown BOOLEAN DEFAULT true,
  print_copy_for_customer BOOLEAN DEFAULT true,
  print_copy_for_merchant BOOLEAN DEFAULT false,
  paper_width TEXT DEFAULT '58mm' CHECK (paper_width IN ('58mm', '80mm')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  sync_status TEXT DEFAULT 'pending'
);
ALTER TABLE public.receipt_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.receipt_settings (id, show_customer_name, show_cashier_name, show_tax_breakdown, print_copy_for_customer, paper_width, created_at, updated_at, sync_status)
VALUES ('receipt-settings', true, true, true, true, '58mm', NOW(), NOW(), 'synced')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.expense_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;

INSERT INTO public.expense_categories (name, description) VALUES
  ('Rent', 'Shop rent and lease payments'),
  ('Utilities', 'Electricity, water, internet bills'),
  ('Salaries', 'Staff wages and compensation'),
  ('Supplies', 'Shop supplies and packaging'),
  ('Maintenance', 'Equipment and shop repairs'),
  ('Marketing', 'Advertising and promotions'),
  ('Transport', 'Delivery and transport costs'),
  ('Other', 'Miscellaneous expenses')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date TIMESTAMPTZ DEFAULT NOW(),
  entry_type TEXT NOT NULL,
  category TEXT,
  description TEXT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_method TEXT DEFAULT 'cash',
  reference_id UUID,
  reference_type TEXT,
  customer_id UUID REFERENCES public.customers(id),
  cashier_id UUID,
  cashier_name TEXT,
  branch_id TEXT,
  notes TEXT,
  is_manual BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID,
  sync_status TEXT DEFAULT 'pending',
  local_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_date ON public.ledger_entries(date DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_type ON public.ledger_entries(entry_type);
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cashier_id UUID,
  branch_id TEXT,
  terminal_id TEXT,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  opening_float NUMERIC(12,2) NOT NULL DEFAULT 0,
  cash_count NUMERIC(12,2),
  cash_sales NUMERIC(12,2) NOT NULL DEFAULT 0,
  card_sales NUMERIC(12,2) NOT NULL DEFAULT 0,
  mobile_money_sales NUMERIC(12,2) NOT NULL DEFAULT 0,
  bank_sales NUMERIC(12,2) NOT NULL DEFAULT 0,
  credit_sales NUMERIC(12,2) NOT NULL DEFAULT 0,
  refunds NUMERIC(12,2) NOT NULL DEFAULT 0,
  discounts NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax NUMERIC(12,2) NOT NULL DEFAULT 0,
  gross_sales NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_sales NUMERIC(12,2) NOT NULL DEFAULT 0,
  variance NUMERIC(12,2),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  x_report_at TIMESTAMPTZ,
  y_report_at TIMESTAMPTZ,
  z_report_at TIMESTAMPTZ,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON public.shifts(status);
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_method TEXT NOT NULL,
  reference TEXT,
  transaction_id UUID,
  customer_id UUID,
  expected_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  received_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('matched','pending','partial','failed','duplicate','exception','reversed')),
  matched_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sync_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_reconciliations_status ON public.reconciliations(status);
ALTER TABLE public.reconciliations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.outbound_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL,
  customer_id UUID,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','packed','assigned','dispatched','in_transit','delivered','closed','returned')),
  address TEXT,
  courier TEXT,
  driver TEXT,
  vehicle TEXT,
  eta TIMESTAMPTZ,
  cod_amount NUMERIC(12,2),
  cod_status TEXT CHECK (cod_status IN ('pending','collected','failed','not_applicable')),
  proof_type TEXT CHECK (proof_type IN ('signature','photo','otp','qr')),
  proof_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sync_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_status ON public.outbound_deliveries(status);
ALTER TABLE public.outbound_deliveries ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  value NUMERIC(12,2) NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  product_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
  customer_group TEXT,
  stackable BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sync_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_offers_active ON public.offers(is_active);
ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.supplier_fulfillments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL,
  supplier_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','shipped','delivered','cancelled')),
  supplier_reference TEXT,
  margin NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sync_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_supplier_fulfillments_transaction ON public.supplier_fulfillments(transaction_id);
ALTER TABLE public.supplier_fulfillments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.report_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  report_type TEXT NOT NULL,
  frequency TEXT NOT NULL,
  recipients JSONB NOT NULL DEFAULT '[]'::JSONB,
  filters JSONB NOT NULL DEFAULT '{}'::JSONB,
  next_run_at TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sync_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_report_schedules_active ON public.report_schedules(is_active);
ALTER TABLE public.report_schedules ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.safe_drops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  approved_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sync_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_safe_drops_shift ON public.safe_drops(shift_id);
ALTER TABLE public.safe_drops ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 5. HARDENED RBAC ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- Drop all old policies
DROP POLICY IF EXISTS "users_read" ON public.users;
DROP POLICY IF EXISTS "users_write" ON public.users;
DROP POLICY IF EXISTS "select_users" ON public.users;
DROP POLICY IF EXISTS "insert_users" ON public.users;
DROP POLICY IF EXISTS "update_users" ON public.users;
DROP POLICY IF EXISTS "delete_users" ON public.users;
DROP POLICY IF EXISTS "users_select_authenticated" ON public.users;
DROP POLICY IF EXISTS "users_insert_admin" ON public.users;
DROP POLICY IF EXISTS "users_update_admin_or_self" ON public.users;
DROP POLICY IF EXISTS "users_delete_admin" ON public.users;

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

-- Products
DROP POLICY IF EXISTS "select_products_public" ON public.products;
DROP POLICY IF EXISTS "insert_products_authenticated" ON public.products;
DROP POLICY IF EXISTS "update_products_authenticated" ON public.products;
DROP POLICY IF EXISTS "delete_products_authenticated" ON public.products;
DROP POLICY IF EXISTS "select_products" ON public.products;
DROP POLICY IF EXISTS "insert_products" ON public.products;
DROP POLICY IF EXISTS "update_products" ON public.products;
DROP POLICY IF EXISTS "delete_products" ON public.products;
DROP POLICY IF EXISTS "products_select_pos" ON public.products;
DROP POLICY IF EXISTS "products_insert_pos" ON public.products;
DROP POLICY IF EXISTS "products_update_pos" ON public.products;
DROP POLICY IF EXISTS "products_delete_admin" ON public.products;

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

-- Customers
DROP POLICY IF EXISTS "select_customers_public" ON public.customers;
DROP POLICY IF EXISTS "insert_customers_public" ON public.customers;
DROP POLICY IF EXISTS "update_customers_public" ON public.customers;
DROP POLICY IF EXISTS "delete_customers" ON public.customers;
DROP POLICY IF EXISTS "select_customers" ON public.customers;
DROP POLICY IF EXISTS "insert_customers" ON public.customers;
DROP POLICY IF EXISTS "update_customers" ON public.customers;
DROP POLICY IF EXISTS "delete_customers" ON public.customers;
DROP POLICY IF EXISTS "customers_select_pos" ON public.customers;
DROP POLICY IF EXISTS "customers_insert_pos" ON public.customers;
DROP POLICY IF EXISTS "customers_update_pos" ON public.customers;
DROP POLICY IF EXISTS "customers_delete_admin" ON public.customers;

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

-- Transactions
DROP POLICY IF EXISTS "select_transactions_public" ON public.transactions;
DROP POLICY IF EXISTS "insert_transactions_public" ON public.transactions;
DROP POLICY IF EXISTS "update_transactions_public" ON public.transactions;
DROP POLICY IF EXISTS "delete_transactions" ON public.transactions;
DROP POLICY IF EXISTS "select_transactions" ON public.transactions;
DROP POLICY IF EXISTS "insert_transactions" ON public.transactions;
DROP POLICY IF EXISTS "update_transactions" ON public.transactions;
DROP POLICY IF EXISTS "delete_transactions" ON public.transactions;
DROP POLICY IF EXISTS "transactions_select_pos" ON public.transactions;
DROP POLICY IF EXISTS "transactions_insert_pos" ON public.transactions;
DROP POLICY IF EXISTS "transactions_update_pos" ON public.transactions;

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

-- Transaction Items
DROP POLICY IF EXISTS "select_transaction_items_public" ON public.transaction_items;
DROP POLICY IF EXISTS "insert_transaction_items_public" ON public.transaction_items;
DROP POLICY IF EXISTS "update_transaction_items" ON public.transaction_items;
DROP POLICY IF EXISTS "delete_transaction_items" ON public.transaction_items;
DROP POLICY IF EXISTS "select_transaction_items" ON public.transaction_items;
DROP POLICY IF EXISTS "insert_transaction_items" ON public.transaction_items;
DROP POLICY IF EXISTS "update_transaction_items" ON public.transaction_items;
DROP POLICY IF EXISTS "delete_transaction_items" ON public.transaction_items;
DROP POLICY IF EXISTS "transaction_items_select_pos" ON public.transaction_items;
DROP POLICY IF EXISTS "transaction_items_insert_pos" ON public.transaction_items;
DROP POLICY IF EXISTS "transaction_items_update_pos" ON public.transaction_items;

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

-- Audit Logs
DROP POLICY IF EXISTS "audit_logs_read" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_insert" ON public.audit_logs;
DROP POLICY IF EXISTS "select_audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "insert_audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_select_manager" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_insert_pos" ON public.audit_logs;

CREATE POLICY "audit_logs_select_manager" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (is_pos_manager_or_admin());

CREATE POLICY "audit_logs_insert_pos" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (is_active_pos_user());

-- KCB Settings
DROP POLICY IF EXISTS "kcb_settings_all" ON public.kcb_settings;
DROP POLICY IF EXISTS "select_kcb_settings" ON public.kcb_settings;
DROP POLICY IF EXISTS "insert_kcb_settings" ON public.kcb_settings;
DROP POLICY IF EXISTS "update_kcb_settings" ON public.kcb_settings;
DROP POLICY IF EXISTS "delete_kcb_settings" ON public.kcb_settings;
DROP POLICY IF EXISTS "kcb_settings_select_admin" ON public.kcb_settings;
DROP POLICY IF EXISTS "kcb_settings_insert_admin" ON public.kcb_settings;
DROP POLICY IF EXISTS "kcb_settings_update_admin" ON public.kcb_settings;
DROP POLICY IF EXISTS "kcb_settings_delete_admin" ON public.kcb_settings;

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

-- KCB Payments
DROP POLICY IF EXISTS "select_kcb_payments" ON public.kcb_payments;
DROP POLICY IF EXISTS "kcb_payments_select_authenticated" ON public.kcb_payments;
DROP POLICY IF EXISTS "kcb_payments_select_pos" ON public.kcb_payments;
DROP POLICY IF EXISTS "kcb_payments_insert_pos" ON public.kcb_payments;
DROP POLICY IF EXISTS "kcb_payments_update_pos" ON public.kcb_payments;

CREATE POLICY "kcb_payments_select_pos" ON public.kcb_payments
  FOR SELECT TO authenticated
  USING (is_active_pos_user());

CREATE POLICY "kcb_payments_insert_pos" ON public.kcb_payments
  FOR INSERT TO authenticated
  WITH CHECK (is_active_pos_user());

CREATE POLICY "kcb_payments_update_pos" ON public.kcb_payments
  FOR UPDATE TO authenticated
  USING (is_active_pos_user())
  WITH CHECK (is_active_pos_user());

-- General Settings & Operations Tables RLS
DROP POLICY IF EXISTS "business_settings_pos_select" ON public.business_settings;
DROP POLICY IF EXISTS "business_settings_admin_write" ON public.business_settings;
CREATE POLICY "business_settings_pos_select" ON public.business_settings FOR SELECT TO authenticated USING (is_active_pos_user());
CREATE POLICY "business_settings_admin_write" ON public.business_settings FOR ALL TO authenticated USING (is_pos_admin()) WITH CHECK (is_pos_admin());

DROP POLICY IF EXISTS "payment_methods_pos_select" ON public.payment_methods;
DROP POLICY IF EXISTS "payment_methods_admin_write" ON public.payment_methods;
CREATE POLICY "payment_methods_pos_select" ON public.payment_methods FOR SELECT TO authenticated USING (is_active_pos_user());
CREATE POLICY "payment_methods_admin_write" ON public.payment_methods FOR ALL TO authenticated USING (is_pos_admin()) WITH CHECK (is_pos_admin());

DROP POLICY IF EXISTS "payment_accounts_pos_select" ON public.payment_accounts;
DROP POLICY IF EXISTS "payment_accounts_admin_write" ON public.payment_accounts;
CREATE POLICY "payment_accounts_pos_select" ON public.payment_accounts FOR SELECT TO authenticated USING (is_active_pos_user());
CREATE POLICY "payment_accounts_admin_write" ON public.payment_accounts FOR ALL TO authenticated USING (is_pos_admin()) WITH CHECK (is_pos_admin());

DROP POLICY IF EXISTS "loyalty_settings_pos_select" ON public.loyalty_settings;
DROP POLICY IF EXISTS "loyalty_settings_admin_write" ON public.loyalty_settings;
CREATE POLICY "loyalty_settings_pos_select" ON public.loyalty_settings FOR SELECT TO authenticated USING (is_active_pos_user());
CREATE POLICY "loyalty_settings_admin_write" ON public.loyalty_settings FOR ALL TO authenticated USING (is_pos_admin()) WITH CHECK (is_pos_admin());

DROP POLICY IF EXISTS "receipt_settings_pos_select" ON public.receipt_settings;
DROP POLICY IF EXISTS "receipt_settings_admin_write" ON public.receipt_settings;
CREATE POLICY "receipt_settings_pos_select" ON public.receipt_settings FOR SELECT TO authenticated USING (is_active_pos_user());
CREATE POLICY "receipt_settings_admin_write" ON public.receipt_settings FOR ALL TO authenticated USING (is_pos_admin()) WITH CHECK (is_pos_admin());

DROP POLICY IF EXISTS "expense_categories_pos_select" ON public.expense_categories;
DROP POLICY IF EXISTS "expense_categories_admin_write" ON public.expense_categories;
CREATE POLICY "expense_categories_pos_select" ON public.expense_categories FOR SELECT TO authenticated USING (is_active_pos_user());
CREATE POLICY "expense_categories_admin_write" ON public.expense_categories FOR ALL TO authenticated USING (is_pos_admin()) WITH CHECK (is_pos_admin());

DROP POLICY IF EXISTS "ledger_entries_pos_select" ON public.ledger_entries;
DROP POLICY IF EXISTS "ledger_entries_pos_write" ON public.ledger_entries;
CREATE POLICY "ledger_entries_pos_select" ON public.ledger_entries FOR SELECT TO authenticated USING (is_active_pos_user());
CREATE POLICY "ledger_entries_pos_write" ON public.ledger_entries FOR ALL TO authenticated USING (is_active_pos_user()) WITH CHECK (is_active_pos_user());

DROP POLICY IF EXISTS "shifts_pos_all" ON public.shifts;
CREATE POLICY "shifts_pos_all" ON public.shifts FOR ALL TO authenticated USING (is_active_pos_user()) WITH CHECK (is_active_pos_user());

DROP POLICY IF EXISTS "reconciliations_pos_all" ON public.reconciliations;
CREATE POLICY "reconciliations_pos_all" ON public.reconciliations FOR ALL TO authenticated USING (is_active_pos_user()) WITH CHECK (is_active_pos_user());

DROP POLICY IF EXISTS "outbound_deliveries_pos_all" ON public.outbound_deliveries;
CREATE POLICY "outbound_deliveries_pos_all" ON public.outbound_deliveries FOR ALL TO authenticated USING (is_active_pos_user()) WITH CHECK (is_active_pos_user());

DROP POLICY IF EXISTS "offers_pos_all" ON public.offers;
CREATE POLICY "offers_pos_all" ON public.offers FOR ALL TO authenticated USING (is_active_pos_user()) WITH CHECK (is_active_pos_user());

DROP POLICY IF EXISTS "supplier_fulfillments_pos_all" ON public.supplier_fulfillments;
CREATE POLICY "supplier_fulfillments_pos_all" ON public.supplier_fulfillments FOR ALL TO authenticated USING (is_active_pos_user()) WITH CHECK (is_active_pos_user());

DROP POLICY IF EXISTS "report_schedules_pos_all" ON public.report_schedules;
CREATE POLICY "report_schedules_pos_all" ON public.report_schedules FOR ALL TO authenticated USING (is_pos_manager_or_admin()) WITH CHECK (is_pos_manager_or_admin());

DROP POLICY IF EXISTS "safe_drops_pos_all" ON public.safe_drops;
CREATE POLICY "safe_drops_pos_all" ON public.safe_drops FOR ALL TO authenticated USING (is_active_pos_user()) WITH CHECK (is_active_pos_user());
