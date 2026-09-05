export type CustomerSource = 'FACEBOOK' | 'WHATSAPP' | 'INSTAGRAM' | 'WALK_IN' | 'REFERRAL' | 'OTHER' | 'UNKNOWN';

export interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  customer_source?: CustomerSource;
  loyalty_points: number;
  total_spent: number;
  created_at: string;
  updated_at: string;
  sync_status: 'pending' | 'synced';
}

export interface Product {
  id: string;
  name: string;
  sku?: string;
  price: number;
  cost: number;
  stock: number;
  category?: string;
  image_url?: string;
  low_stock_alert?: number;
  barcode?: string;
  tax_category?: 'exempt' | 'standard_16';
  is_active: boolean;
  created_at: string;
  updated_at: string;
  sync_status: 'pending' | 'synced';
  local_id?: string;
}

export interface TransactionItem {
  id: string;
  transaction_id?: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
}

export type CODStatus = 'PENDING' | 'CONFIRMED' | 'DISPATCHED' | 'DELIVERED' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED' | 'DELIVERY_FAILED' | 'RETURNED';

export interface CODPayment {
  id: string;
  transaction_id: string;
  amount: number;
  amount_applied: number;
  change_amount: number;
  payment_method: string;
  payment_account_id?: string | null;
  payment_account_name?: string | null;
  reference?: string;
  notes?: string;
  created_at: string;
  device_id: string;
  sync_status: EnterpriseSyncStatus;
}

export interface CODReceipt {
  id: string;
  receipt_number: string;
  transaction_id: string;
  payment_id: string;
  receipt_type: 'cod_order' | 'cod_payment' | 'delivery_note';
  amount: number;
  issued_at: string;
  sync_status: EnterpriseSyncStatus;
}

export interface Transaction {
  id: string;
  customer_id?: string;
  total_amount: number;
  amount_paid: number;
  change_amount: number;
  payment_method: string;
  payment_timing?: 'immediate' | 'cod';
  is_cod?: boolean;
  payment_account_id?: string | null;
  payment_account_name?: string | null;
  payment_account_paybill?: string | null;
  payment_account_number?: string | null;
  status: string;
  notes?: string;
  created_at: string;
  sync_status: 'pending' | 'synced';
  items: TransactionItem[];
  sale_type?: SaleType;
  deposit_amount?: number;
  balance_amount?: number;
  cod_status?: CODStatus;
  cod_order_id?: string;
  delivery_address?: string;
  delivery_contact?: string;
  consignment_number?: string;
  cod_payments?: CODPayment[];
  customer_name?: string;
  customer_phone?: string;
  cashier_name?: string;
  mpesa_receipt?: string;
  idempotency_key?: string;
  payment_account?: string;
  delivery_type?: string;
  delivery_fee?: number;
  discount?: number;
  subtotal?: number;
}

export interface InstallmentPlan {
  id: string;
  customer_id: string;
  product_id: string;
  product_name: string;
  total_amount: number;
  amount_paid: number;
  installment_count: number;
  status: 'active' | 'completed' | 'cancelled';
  product_released: boolean;
  release_date?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  sync_status: 'pending' | 'synced';
}

export interface InstallmentPayment {
  id: string;
  plan_id: string;
  amount: number;
  payment_method: string;
  notes?: string;
  created_at: string;
  sync_status: 'pending' | 'synced';
}

export interface LoyaltyTransaction {
  id: string;
  customer_id: string;
  points: number;
  transaction_type: 'earned' | 'redeemed';
  source: string;
  reference_id?: string;
  created_at: string;
  sync_status: 'pending' | 'synced';
}

export interface CartItem {
  id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
}

export interface StockMovement {
  id: string;
  product_id: string;
  qty_delta: number;
  reason: 'sale' | 'return' | 'restock' | 'adjustment' | 'initial' | 'transfer_in' | 'transfer_out';
  note?: string;
  balance_after: number;
  reference_type?: 'sale' | 'delivery' | 'adjustment' | 'transfer';
  reference_id?: string;
  branch_id?: string;
  created_at: string;
  created_by: string;
  sync_status: 'pending' | 'synced';
  local_id?: string;
}

export interface Supplier {
  id: string;
  name: string;
  contact_person?: string;
  phone?: string;
  email?: string;
  address?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  sync_status: 'pending' | 'synced';
}

export interface Delivery {
  id: string;
  supplier_id?: string;
  delivery_note_number?: string;
  status: 'pending' | 'received' | 'cancelled';
  total_items: number;
  total_value: number;
  notes?: string;
  received_by?: string;
  received_at?: string;
  created_at: string;
  updated_at: string;
  sync_status: 'pending' | 'synced';
}

export interface DeliveryItem {
  id: string;
  delivery_id: string;
  product_id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost: number;
  sync_status: 'pending' | 'synced';
}

export interface StockAdjustment {
  id: string;
  product_id: string;
  previous_stock: number;
  new_stock: number;
  reason: string;
  note?: string;
  created_by: string;
  created_at: string;
  sync_status: 'pending' | 'synced';
  local_id?: string;
}

export type EnterpriseSyncStatus = 'pending' | 'synced' | 'error';
export type SaleType = 'standard' | 'retail' | 'wholesale' | 'dropshipping' | 'lipa_mdogo' | 'kyama' | 'group_sale';

export interface ReportFilters {
  from: string;
  to: string;
  branch_id?: string;
  cashier_id?: string;
  shift_id?: string;
  terminal_id?: string;
  sale_type?: SaleType;
  payment_method?: string;
  customer_id?: string;
}

export interface ShiftRecord {
  id: string;
  cashier_id: string;
  branch_id?: string;
  terminal_id?: string;
  opened_at: string;
  closed_at?: string;
  opening_float: number;
  cash_count?: number;
  cash_sales: number;
  card_sales: number;
  mobile_money_sales: number;
  bank_sales: number;
  credit_sales: number;
  refunds: number;
  discounts: number;
  tax: number;
  gross_sales: number;
  net_sales: number;
  variance?: number;
  status: 'open' | 'closed' | 'archived';
  x_report_at?: string;
  y_report_at?: string;
  z_report_at?: string;
  sync_status: EnterpriseSyncStatus;
}

export interface ReconciliationRecord {
  id: string;
  payment_method: string;
  reference?: string;
  transaction_id?: string;
  customer_id?: string;
  expected_amount: number;
  received_amount: number;
  status: 'matched' | 'pending' | 'partial' | 'failed' | 'duplicate' | 'exception' | 'reversed';
  matched_at?: string;
  notes?: string;
  created_at: string;
  sync_status: EnterpriseSyncStatus;
}

export type OutboundDeliveryStatus = 'pending' | 'packed' | 'assigned' | 'dispatched' | 'in_transit' | 'delivered' | 'closed' | 'returned' | 'failed' | 'cancelled';
export type DeliveryFeeStatus = 'unpaid' | 'partial' | 'paid' | 'waived';
export type DeliveryPaymentMethod = 'cash' | 'kcb_buni' | 'ncba';

export interface OutboundDelivery {
  id: string;
  transaction_id: string;
  customer_id?: string;
  status: OutboundDeliveryStatus;
  address?: string;
  recipient_name?: string;
  recipient_phone?: string;
  delivery_instructions?: string;
  courier?: string;
  driver?: string;
  vehicle?: string;
  eta?: string;
  scheduled_at?: string;
  dispatched_at?: string;
  delivered_at?: string;
  delivery_fee?: number;
  delivery_fee_paid?: number;
  delivery_fee_status?: DeliveryFeeStatus;
  delivery_payment_method?: DeliveryPaymentMethod;
  delivery_payment_reference?: string;
  cod_amount?: number;
  cod_collected?: number;
  cod_status?: 'pending' | 'collected' | 'failed' | 'not_applicable';
  proof_type?: 'signature' | 'photo' | 'otp' | 'qr';
  proof_reference?: string;
  exception_reason?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  sync_status: EnterpriseSyncStatus;
}

export interface OfferRule {
  id: string;
  name: string;
  type: 'percentage' | 'fixed' | 'bogo' | 'bundle' | 'multi_buy' | 'coupon' | 'loyalty' | 'staff' | 'senior';
  value: number;
  priority: number;
  starts_at?: string;
  ends_at?: string;
  product_ids?: string[];
  customer_group?: string;
  stackable: boolean;
  is_active: boolean;
  sync_status: EnterpriseSyncStatus;
}

export interface SupplierFulfillment {
  id: string;
  transaction_id: string;
  supplier_id: string;
  status: 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';
  supplier_reference?: string;
  margin?: number;
  customer_tracking?: string;
  shipping_provider?: string;
  created_at: string;
  sync_status: EnterpriseSyncStatus;
}

export interface ReportSchedule {
  id: string;
  name: string;
  report_type: 'executive' | 'sales' | 'inventory' | 'financial' | 'delivery' | 'customer' | 'user' | 'x' | 'y' | 'z';
  frequency: 'daily' | 'weekly' | 'monthly';
  recipients: string[];
  filters: ReportFilters;
  next_run_at: string;
  is_active: boolean;
  created_at: string;
  sync_status: EnterpriseSyncStatus;
}

export interface SafeDropRecord {
  id: string;
  shift_id: string;
  amount: number;
  reason: string;
  approved_by?: string;
  created_at: string;
  sync_status: EnterpriseSyncStatus;
}

export type SalesDataSource = 'POS_TRANSACTION' | 'IMPORTED' | 'MANUAL_HISTORICAL' | 'RECOVERED' | 'ESTIMATED' | 'BUSINESS_PROVIDED_HISTORICAL';
export type DailyReconciliationStatus = 'COMPLETE' | 'PARTIAL' | 'MISSING' | 'RECONCILED' | 'UNRESOLVED' | 'VARIANCE_WARNING';
export type ApprovalStatus = 'PENDING_APPROVAL' | 'PENDING_REVIEW' | 'VERIFIED_MANUAL' | 'REJECTED';

export type DualSourceReconciliationStatus =
  | 'MATCH / CROSS_VALIDATED'
  | 'CONFLICTING / INVESTIGATION_REQUIRED'
  | 'HISTORICAL_PENDING_APPROVAL'
  | 'POS_RECOVERED_ONLY'
  | 'MISSING_DATA';

export type SourceAvailability =
  | 'POS_PRESENT'
  | 'HISTORICAL_PRESENT'
  | 'BOTH_PRESENT'
  | 'NEITHER_PRESENT';

export type ReconciliationStatusDimension =
  | 'EXACT_MATCH'
  | 'CONFLICTING'
  | 'HISTORICAL_ONLY'
  | 'POS_ONLY'
  | 'PARTIAL_POS'
  | 'UNRESOLVED';

export type EvidenceStrength =
  | 'PRIMARY_POS_COMPLETE'
  | 'PRIMARY_POS_PARTIAL'
  | 'INDEPENDENT_BUSINESS_RECORD'
  | 'BUSINESS_PROVIDED_HISTORICAL'
  | 'INSUFFICIENT_EVIDENCE';

export type AuditApprovalStatus =
  | 'PENDING_APPROVAL'
  | 'VERIFIED_MANUAL'
  | 'REJECTED';

export interface AuditTrailEntry {
  action: string;
  timestamp: string;
  actor: string;
  details?: string;
}

export interface HistoricalDailySales {
  id: string;
  business_date: string; // YYYY-MM-DD
  branch_id?: string;
  source: SalesDataSource;
  source_type?: SalesDataSource;
  status: DailyReconciliationStatus;
  approval_status?: ApprovalStatus;
  preparer?: string;
  reviewer?: string;
  approval_timestamp?: string;
  source_reference?: string;
  evidence_notes?: string;
  audit_trail?: AuditTrailEntry[];
  transaction_count: number;
  gross_sales: number;
  discounts: number;
  refunds: number;
  tax: number;
  net_sales: number;
  cash_sales: number;
  mpesa_sales: number;
  other_sales: number;
  eod_total: number;
  opening_float?: number;
  closing_cash_count?: number;
  cash_variance?: number;
  notes?: string;
  reference?: string;
  entered_by?: string;
  entered_by_name?: string;
  approved_by?: string;
  created_at: string;
  updated_at: string;
  sync_status: 'pending' | 'synced' | 'error';
  warnings?: string[];
  is_locked?: boolean;
}

export interface DualSourceReconciliationRow {
  date: string;          // YYYY-MM-DD
  day_name: string;      // Mon, Tue, etc.
  day_number: number;    // 1..31
  is_open: boolean;
  pos_recovered_amount: number | null;
  pos_transaction_count: number;
  historical_figure: number | null;
  difference: number | null;
  final_status: DualSourceReconciliationStatus;
  source_availability: SourceAvailability;
  reconciliation_status: ReconciliationStatusDimension;
  evidence_strength: EvidenceStrength;
  approval_status: AuditApprovalStatus;
  accepted_amount: number | null;
  evidence: string;
  is_sandbox_excluded?: boolean;
}

export interface DailySalesRow {
  date: string;          // YYYY-MM-DD
  day_name: string;      // Mon, Tue, etc.
  day_number: number;    // 1..31
  source: SalesDataSource;
  status: DailyReconciliationStatus;
  transaction_count: number;
  gross_sales: number;
  discounts: number;
  refunds: number;
  tax: number;
  net_sales: number;
  cash_sales: number;
  mpesa_sales: number;
  other_sales: number;
  eod_total: number;
  shift_record?: ShiftRecord;
  manual_record?: HistoricalDailySales;
  warnings: string[];
  is_editable: boolean;
}

export interface WeeklySalesSummary {
  week_number: number;
  date_range_label: string;
  start_date: string;
  end_date: string;
  trading_days: number;
  complete_days: number;
  missing_days: number;
  manual_days: number;
  recovered_days: number;
  transaction_count: number;
  gross_sales: number;
  discounts: number;
  refunds: number;
  tax: number;
  net_sales: number;
  cash_sales: number;
  mpesa_sales: number;
  other_sales: number;
  eod_total: number;
  days: DailySalesRow[];
}

export interface MonthEndSalesSummary {
  month_label: string;
  year: number;
  month: number;
  total_calendar_days: number;
  trading_days: number;
  pos_derived_days: number;
  recovered_days: number;
  manual_days: number;
  missing_days: number;
  total_transactions: number;
  gross_sales: number;
  discounts: number;
  refunds: number;
  tax: number;
  net_sales: number;
  cash_sales: number;
  mpesa_sales: number;
  other_sales: number;
  total_eod_sales: number;
  weeks: WeeklySalesSummary[];
  daily_rows: DailySalesRow[];
}

export interface FastMovingProduct {
  product_id: string;
  product_name: string;
  category: string;
  units_sold: number;
  revenue: number;
  transaction_count: number;
  velocity_period_days: number; // units_sold / total period days
  velocity_active_days: number; // units_sold / active selling days
  rank_by_units: number;
  rank_by_revenue: number;
  sales_share: number; // percentage of merchandise subtotal
}

export interface ProductCategoryPerformance {
  category: string;
  units_sold: number;
  revenue: number;
  transaction_count: number;
  sales_share: number; // percentage of merchandise subtotal
}

export interface CustomerIntelligenceSummary {
  total_customers: number;
  unique_customers: number;
  new_customers: number;
  returning_customers: number;
  repeat_customers: number;
  repeat_purchase_rate: number; // percentage (repeat_customers / unique_customers * 100)
  average_customer_spend: number;
  purchase_frequency: number; // completed transactions / unique customers
  top_customers: Array<{
    customer_id: string;
    customer_name: string;
    customer_phone?: string;
    customer_source?: CustomerSource;
    transaction_count: number;
    total_spent: number;
  }>;
}

export interface CustomerSourceSummary {
  source: CustomerSource;
  label: string;
  customer_count: number;
  transaction_count: number;
  sales: number;
  sales_share: number; // percentage of total sales
}

export interface AuthoritativeAnalyticsSummary {
  period: {
    start: string;
    end: string;
    total_days: number;
  };
  kpis: {
    total_sales: number;
    merchandise_subtotal: number;
    total_discounts: number;
    total_delivery_fees: number;
    completed_transactions: number;
    average_transaction_value: number;
    total_paid: number;
    unique_customers: number;
  };
  fast_moving_products: FastMovingProduct[];
  category_performance: ProductCategoryPerformance[];
  customer_intelligence: CustomerIntelligenceSummary;
  customer_sources: CustomerSourceSummary[];
}
