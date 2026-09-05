import { getAllCustomers, getAllProducts, getAllTransactions, getAllUsers } from './db';
import { getDB } from './db';
import type {
  Customer,
  OutboundDelivery,
  Product,
  Transaction,
  CustomerSource,
  FastMovingProduct,
  ProductCategoryPerformance,
  CustomerIntelligenceSummary,
  CustomerSourceSummary,
  AuthoritativeAnalyticsSummary,
} from './types';
import type { User } from './security-types';

export type ReportKind = 'sales' | 'financial' | 'inventory' | 'delivery' | 'customer' | 'user';

export interface ReportData {
  transactions: Transaction[];
  customers: Customer[];
  products: Product[];
  deliveries: OutboundDelivery[];
  users: User[];
}

export async function loadReportData(): Promise<ReportData> {
  const db = await getDB();
  const [transactions, customers, products, deliveries, users] = await Promise.all([
    getAllTransactions(),
    getAllCustomers(),
    getAllProducts(),
    db.getAll('outbound_deliveries') as Promise<OutboundDelivery[]>,
    getAllUsers(),
  ]);
  return { transactions, customers, products, deliveries, users };
}

export function inRange(date: string, from: string, to: string) {
  const value = new Date(date).getTime();
  return value >= new Date(`${from}T00:00:00`).getTime() && value <= new Date(`${to}T23:59:59`).getTime();
}

export function currency(value: number) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(value);
}

export function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export type PaymentAccountCategory = 'KCB' | 'NCBA' | 'CASH' | 'MPESA' | 'UNASSIGNED';

export interface PaymentAccountSummary {
  account: PaymentAccountCategory;
  label: string;
  amount: number;
  count: number;
  percentage: number;
}

export interface DeliverySummary {
  noneCount: number;
  noneAmount: number;
  toCbdCount: number;
  toCbdAmount: number;
  fromCbd300Count: number;
  fromCbd300Amount: number;
  fromCbd500Count: number;
  fromCbd500Amount: number;
  totalDeliveryFees: number;
}

export interface AuthoritativeDashboardKPIs {
  totalSales: number;
  subtotal: number;
  totalDiscounts: number;
  totalDeliveryFees: number;
  totalTransactions: number;
  averageTransactionValue: number;
  totalPaid: number;
  uniqueCustomers: number;
  paymentAccounts: {
    KCB: PaymentAccountSummary;
    NCBA: PaymentAccountSummary;
    CASH: PaymentAccountSummary;
    MPESA: PaymentAccountSummary;
    UNASSIGNED: PaymentAccountSummary;
    totalAmount: number;
    totalCount: number;
  };
  deliverySummary: DeliverySummary;
}

export interface DailyTransactionSummary {
  date: string; // YYYY-MM-DD
  dayLabel: string; // e.g. "Sat, Sep 5, 2026"
  shortDayName: string; // e.g. "Sat"
  transactionCount: number;
  totalSales: number;
  subtotal: number;
  discounts: number;
  deliveryFees: number;
  paidAmount: number;
  paymentAccounts: Record<PaymentAccountCategory, number>;
  transactions: Transaction[];
}

/**
 * Authoritative resolver for transaction payment account.
 * Prioritizes Stage 2 persisted payment_account field.
 * Safely resolves historical transactions based on explicit metadata or method.
 */
export function resolveTransactionPaymentAccount(tx: Transaction): PaymentAccountCategory {
  if (tx.payment_account) {
    if (['KCB', 'NCBA', 'CASH', 'MPESA'].includes(tx.payment_account)) {
      return tx.payment_account as PaymentAccountCategory;
    }
  }

  const accountId = (tx.payment_account_id || '').toLowerCase();
  const accountName = (tx.payment_account_name || '').toLowerCase();
  const method = (tx.payment_method || '').toLowerCase();

  if (accountId.includes('kcb') || accountName.includes('kcb') || accountName.includes('7941675')) {
    return 'KCB';
  }
  if (accountId.includes('ncba') || accountName.includes('ncba') || accountName.includes('166294')) {
    return 'NCBA';
  }
  if (method === 'cash') {
    return 'CASH';
  }
  if (method === 'kcb_buni' || method.includes('mpesa') || method.includes('mobile')) {
    return 'MPESA';
  }
  if (method === 'ncba') {
    return 'NCBA';
  }

  return 'UNASSIGNED';
}

/**
 * Filter valid completed/active sales transactions.
 * Voided, failed, and cancelled transactions are excluded.
 */
export function isValidSalesTransaction(tx: Transaction): boolean {
  if (!tx || !tx.id) return false;
  if (tx.status === 'voided' || tx.status === 'cancelled' || tx.status === 'failed') {
    return false;
  }
  return true;
}

/**
 * Calculate Authoritative Dashboard KPIs from transactions.
 * This is the SINGLE authoritative calculation engine shared across
 * on-screen Dashboard KPIs, Daily Detailed Reports, and Combined Printing.
 */
export function calculateAuthoritativeDashboardKPIs(transactions: Transaction[]): AuthoritativeDashboardKPIs {
  const validTxs = transactions.filter(isValidSalesTransaction);

  let totalSales = 0;
  let totalSubtotal = 0;
  let totalDiscounts = 0;
  let totalDeliveryFees = 0;
  let totalPaid = 0;

  const paymentAccountTotals: Record<PaymentAccountCategory, { amount: number; count: number }> = {
    KCB: { amount: 0, count: 0 },
    NCBA: { amount: 0, count: 0 },
    CASH: { amount: 0, count: 0 },
    MPESA: { amount: 0, count: 0 },
    UNASSIGNED: { amount: 0, count: 0 },
  };

  const deliverySummary: DeliverySummary = {
    noneCount: 0,
    noneAmount: 0,
    toCbdCount: 0,
    toCbdAmount: 0,
    fromCbd300Count: 0,
    fromCbd300Amount: 0,
    fromCbd500Count: 0,
    fromCbd500Amount: 0,
    totalDeliveryFees: 0,
  };

  const customerIds = new Set<string>();

  for (const tx of validTxs) {
    const saleAmount = Number(tx.total_amount || 0);
    const paid = Number(tx.amount_paid || 0);
    const fee = Number(tx.delivery_fee !== undefined ? tx.delivery_fee : 0);
    const disc = Number(tx.discount !== undefined ? tx.discount : 0);
    const sub = Number(tx.subtotal !== undefined ? tx.subtotal : Math.max(0, saleAmount - fee + disc));

    totalSales += saleAmount;
    totalPaid += paid;
    totalSubtotal += sub;
    totalDiscounts += disc;
    totalDeliveryFees += fee;

    if (tx.customer_id) {
      customerIds.add(tx.customer_id);
    }

    // Payment account aggregation
    const account = resolveTransactionPaymentAccount(tx);
    paymentAccountTotals[account].amount += saleAmount;
    paymentAccountTotals[account].count += 1;

    // Delivery fee categorization
    const dType = tx.delivery_type;
    if (dType === 'to_cbd' || fee === 100) {
      deliverySummary.toCbdCount += 1;
      deliverySummary.toCbdAmount += fee;
    } else if (dType === 'from_cbd_300' || fee === 300) {
      deliverySummary.fromCbd300Count += 1;
      deliverySummary.fromCbd300Amount += fee;
    } else if (dType === 'from_cbd_500' || fee === 500) {
      deliverySummary.fromCbd500Count += 1;
      deliverySummary.fromCbd500Amount += fee;
    } else {
      deliverySummary.noneCount += 1;
      deliverySummary.noneAmount += fee;
    }
  }

  deliverySummary.totalDeliveryFees = totalDeliveryFees;

  const totalValidCount = validTxs.length;
  const averageTransactionValue = totalValidCount > 0 ? totalSales / totalValidCount : 0;

  const buildSummary = (acc: PaymentAccountCategory, label: string): PaymentAccountSummary => {
    const data = paymentAccountTotals[acc];
    const percentage = totalSales > 0 ? (data.amount / totalSales) * 100 : 0;
    return {
      account: acc,
      label,
      amount: data.amount,
      count: data.count,
      percentage: Math.round(percentage * 10) / 10,
    };
  };

  return {
    totalSales,
    subtotal: totalSubtotal,
    totalDiscounts,
    totalDeliveryFees,
    totalTransactions: totalValidCount,
    averageTransactionValue,
    totalPaid,
    uniqueCustomers: customerIds.size,
    paymentAccounts: {
      KCB: buildSummary('KCB', 'KCB Bank'),
      NCBA: buildSummary('NCBA', 'NCBA Bank'),
      CASH: buildSummary('CASH', 'Physical Cash'),
      MPESA: buildSummary('MPESA', 'M-Pesa (KCB BUNI)'),
      UNASSIGNED: buildSummary('UNASSIGNED', 'Unassigned / Historical'),
      totalAmount: totalSales,
      totalCount: totalValidCount,
    },
    deliverySummary,
  };
}

/**
 * Generate daily transaction summaries for every day in dateRange.
 * Guarantees that ALL days in the reporting period are represented
 * without silent omission.
 */
export function calculateDailyTransactions(
  transactions: Transaction[],
  dateRange: { start: Date; end: Date }
): DailyTransactionSummary[] {
  const validTxs = transactions.filter(isValidSalesTransaction);

  // Group valid transactions by YYYY-MM-DD
  const txByDate = new Map<string, Transaction[]>();
  for (const tx of validTxs) {
    if (!tx.created_at) continue;
    const dateStr = tx.created_at.slice(0, 10);
    const list = txByDate.get(dateStr) || [];
    list.push(tx);
    txByDate.set(dateStr, list);
  }

  const result: DailyTransactionSummary[] = [];
  const startMs = new Date(dateRange.start.getFullYear(), dateRange.start.getMonth(), dateRange.start.getDate()).getTime();
  const endMs = new Date(dateRange.end.getFullYear(), dateRange.end.getMonth(), dateRange.end.getDate()).getTime();

  for (let currentMs = startMs; currentMs <= endMs; currentMs += 86400000) {
    const d = new Date(currentMs);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dayTxs = txByDate.get(dateStr) || [];

    let totalSales = 0;
    let subtotal = 0;
    let discounts = 0;
    let deliveryFees = 0;
    let paidAmount = 0;

    const paymentAccounts: Record<PaymentAccountCategory, number> = {
      KCB: 0,
      NCBA: 0,
      CASH: 0,
      MPESA: 0,
      UNASSIGNED: 0,
    };

    for (const tx of dayTxs) {
      const amount = Number(tx.total_amount || 0);
      const fee = Number(tx.delivery_fee !== undefined ? tx.delivery_fee : 0);
      const disc = Number(tx.discount !== undefined ? tx.discount : 0);
      const sub = Number(tx.subtotal !== undefined ? tx.subtotal : Math.max(0, amount - fee + disc));

      totalSales += amount;
      subtotal += sub;
      discounts += disc;
      deliveryFees += fee;
      paidAmount += Number(tx.amount_paid || 0);

      const acc = resolveTransactionPaymentAccount(tx);
      paymentAccounts[acc] += amount;
    }

    result.push({
      date: dateStr,
      dayLabel: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
      shortDayName: d.toLocaleDateString('en-US', { weekday: 'short' }),
      transactionCount: dayTxs.length,
      totalSales,
      subtotal,
      discounts,
      deliveryFees,
      paidAmount,
      paymentAccounts,
      transactions: dayTxs,
    });
  }

  return result;
}

/**
 * Authoritative Analytics Derivation Engine.
 * Downstream consumer of authoritative transaction ledger and dashboard KPIs.
 * 
 * Reconciles 100% with calculateAuthoritativeDashboardKPIs:
 * - Net Sales, Subtotal, Discounts, Delivery Fees, Transactions, ATV
 * 
 * Controls:
 * - Delivery fees and non-merchandise lines are strictly excluded from product metrics.
 * - Missing product categories fall back to 'Uncategorized'.
 * - Product velocity has two explicit definitions:
 *     1. velocity_period_days: Units Sold / Total Days in Selected Period
 *     2. velocity_active_days: Units Sold / Active Selling Days
 * - Repeat customer = customer with >= 2 qualifying completed sales in period.
 * - Customer source attribution supports 7 channels (FACEBOOK, WHATSAPP, INSTAGRAM, WALK_IN, REFERRAL, OTHER, UNKNOWN).
 * - Zero fabrication: Missing source defaults to UNKNOWN.
 */
export function calculateAuthoritativeAnalytics(
  transactions: Transaction[],
  customers: Customer[] = [],
  products: Product[] = [],
  dateRange: { start: Date; end: Date }
): AuthoritativeAnalyticsSummary {
  // 1. Authoritative financial reconciliation:
  // Must use EXACT same definitions as calculateAuthoritativeDashboardKPIs
  const dashboardKpis = calculateAuthoritativeDashboardKPIs(transactions);
  const validTxs = transactions.filter(isValidSalesTransaction);

  // Period duration in days
  const startMs = dateRange.start.getTime();
  const endMs = dateRange.end.getTime();
  const totalDays = Math.max(1, Math.ceil((endMs - startMs) / 86400000));

  // Lookup map for products by ID
  const productCatalogMap = new Map<string, Product>();
  for (const p of products) {
    if (p.id) productCatalogMap.set(p.id, p);
  }

  // Lookup map for customers by ID and phone
  const customerMap = new Map<string, Customer>();
  const customerPhoneMap = new Map<string, Customer>();
  for (const c of customers) {
    if (c.id) customerMap.set(c.id, c);
    if (c.phone) customerPhoneMap.set(c.phone, c);
  }

  // 2. Fast-Moving Products & Product / Category Aggregation
  // CRITICAL RULE: Delivery fees and payment adjustments are strictly excluded.
  // Delivery must never appear as a product.
  interface ProductAgg {
    product_id: string;
    product_name: string;
    category: string;
    units_sold: number;
    revenue: number;
    transaction_ids: Set<string>;
    selling_dates: Set<string>;
  }

  const productMap = new Map<string, ProductAgg>();
  const categoryMap = new Map<string, { category: string; units_sold: number; revenue: number; tx_ids: Set<string> }>();

  for (const tx of validTxs) {
    const txDateStr = tx.created_at ? tx.created_at.slice(0, 10) : '';
    const items = tx.items || [];
    for (const item of items) {
      if (!item) continue;
      const pId = item.product_id || item.product_name;
      if (!pId) continue;

      // Exclude delivery line items if any ever exist in items
      const pNameLower = (item.product_name || '').toLowerCase();
      if (pNameLower.includes('delivery fee') || pNameLower === 'delivery' || pId === 'delivery') {
        continue;
      }

      const catalogProduct = productCatalogMap.get(item.product_id);
      const categoryName = (catalogProduct?.category?.trim() || '').length > 0
        ? catalogProduct!.category!.trim()
        : 'Uncategorized';

      const qty = Number(item.quantity || 0);
      const sub = Number(item.subtotal !== undefined ? item.subtotal : (item.unit_price || 0) * qty);

      // Product Aggregation
      let pEntry = productMap.get(pId);
      if (!pEntry) {
        pEntry = {
          product_id: item.product_id || pId,
          product_name: item.product_name || catalogProduct?.name || 'Unknown Product',
          category: categoryName,
          units_sold: 0,
          revenue: 0,
          transaction_ids: new Set<string>(),
          selling_dates: new Set<string>(),
        };
        productMap.set(pId, pEntry);
      }
      pEntry.units_sold += qty;
      pEntry.revenue += sub;
      if (tx.id) pEntry.transaction_ids.add(tx.id);
      if (txDateStr) pEntry.selling_dates.add(txDateStr);

      // Category Aggregation
      let catEntry = categoryMap.get(categoryName);
      if (!catEntry) {
        catEntry = {
          category: categoryName,
          units_sold: 0,
          revenue: 0,
          tx_ids: new Set<string>(),
        };
        categoryMap.set(categoryName, catEntry);
      }
      catEntry.units_sold += qty;
      catEntry.revenue += sub;
      if (tx.id) catEntry.tx_ids.add(tx.id);
    }
  }

  // Calculate Product Velocity and Rankings
  // Velocity Definition 1: Units Sold / Total Period Days (accounts for zero-sales days across the selected period)
  // Velocity Definition 2: Units Sold / Active Selling Days (rate on days where sales actually occurred)
  const merchandiseSubtotal = dashboardKpis.subtotal;

  const rawProducts = Array.from(productMap.values()).map((p) => {
    const activeDays = Math.max(1, p.selling_dates.size);
    const velocityPeriodDays = Math.round((p.units_sold / totalDays) * 100) / 100;
    const velocityActiveDays = Math.round((p.units_sold / activeDays) * 100) / 100;
    const salesShare = merchandiseSubtotal > 0 ? Math.round((p.revenue / merchandiseSubtotal) * 1000) / 10 : 0;

    return {
      product_id: p.product_id,
      product_name: p.product_name,
      category: p.category,
      units_sold: p.units_sold,
      revenue: p.revenue,
      transaction_count: p.transaction_ids.size,
      velocity_period_days: velocityPeriodDays,
      velocity_active_days: velocityActiveDays,
      sales_share: salesShare,
    };
  });

  // Compute rank by units
  const sortedByUnits = [...rawProducts].sort((a, b) => b.units_sold - a.units_sold || b.revenue - a.revenue);
  const unitsRankMap = new Map<string, number>();
  sortedByUnits.forEach((p, idx) => unitsRankMap.set(p.product_id, idx + 1));

  // Compute rank by revenue
  const sortedByRevenue = [...rawProducts].sort((a, b) => b.revenue - a.revenue || b.units_sold - a.units_sold);
  const revenueRankMap = new Map<string, number>();
  sortedByRevenue.forEach((p, idx) => revenueRankMap.set(p.product_id, idx + 1));

  const fastMovingProducts: FastMovingProduct[] = rawProducts.map((p) => ({
    ...p,
    rank_by_units: unitsRankMap.get(p.product_id) || 1,
    rank_by_revenue: revenueRankMap.get(p.product_id) || 1,
  }));

  // Category Performance
  const categoryPerformance: ProductCategoryPerformance[] = Array.from(categoryMap.values()).map((c) => {
    const salesShare = merchandiseSubtotal > 0 ? Math.round((c.revenue / merchandiseSubtotal) * 1000) / 10 : 0;
    return {
      category: c.category,
      units_sold: c.units_sold,
      revenue: c.revenue,
      transaction_count: c.tx_ids.size,
      sales_share: salesShare,
    };
  }).sort((a, b) => b.revenue - a.revenue);

  // 3. Customer Intelligence
  interface CustomerTxAgg {
    customer_id: string;
    customer_name: string;
    customer_phone?: string;
    customer_source?: CustomerSource;
    transaction_count: number;
    total_spent: number;
  }

  const activeCustomerMap = new Map<string, CustomerTxAgg>();

  for (const tx of validTxs) {
    const cId = tx.customer_id;
    const phone = tx.customer_phone;
    const registeredCust = cId ? customerMap.get(cId) : (phone ? customerPhoneMap.get(phone) : undefined);
    
    // Stable identifier: registered customer ID if available, otherwise tx.customer_id or phone
    const stableId = registeredCust?.id || cId || (phone ? `phone-${phone}` : null);
    if (!stableId) continue; // anonymous sale

    const name = registeredCust?.name || tx.customer_name || 'Customer';
    const cPhone = registeredCust?.phone || phone;
    const source = registeredCust?.customer_source || 'UNKNOWN';

    let entry = activeCustomerMap.get(stableId);
    if (!entry) {
      entry = {
        customer_id: stableId,
        customer_name: name,
        customer_phone: cPhone,
        customer_source: source,
        transaction_count: 0,
        total_spent: 0,
      };
      activeCustomerMap.set(stableId, entry);
    }
    entry.transaction_count += 1;
    entry.total_spent += Number(tx.total_amount || 0);
  }

  const uniqueCustomerCount = activeCustomerMap.size;
  // Repeat customer = customer with >= 2 qualifying completed transactions during the selected analysis period
  const repeatCustomers = Array.from(activeCustomerMap.values()).filter((c) => c.transaction_count >= 2);
  const repeatCustomerCount = repeatCustomers.length;
  const repeatPurchaseRate = uniqueCustomerCount > 0 ? Math.round((repeatCustomerCount / uniqueCustomerCount) * 1000) / 10 : 0;

  // New customers: customers created within this period
  let newCustomerCount = 0;
  for (const c of customers) {
    if (c.created_at) {
      const cDate = new Date(c.created_at).getTime();
      if (cDate >= startMs && cDate <= endMs) {
        newCustomerCount += 1;
      }
    }
  }

  // Returning customers = active transacting customers whose registration date was before period start
  let returningCustomerCount = 0;
  for (const [stableId] of activeCustomerMap.entries()) {
    const cust = customerMap.get(stableId);
    if (cust && cust.created_at) {
      const cDate = new Date(cust.created_at).getTime();
      if (cDate < startMs) {
        returningCustomerCount += 1;
      }
    } else {
      returningCustomerCount += 1;
    }
  }

  const averageCustomerSpend = uniqueCustomerCount > 0 ? Math.round(dashboardKpis.totalSales / uniqueCustomerCount) : 0;
  const purchaseFrequency = uniqueCustomerCount > 0 ? Math.round((dashboardKpis.totalTransactions / uniqueCustomerCount) * 10) / 10 : 0;

  const topCustomers = Array.from(activeCustomerMap.values())
    .sort((a, b) => b.total_spent - a.total_spent)
    .slice(0, 10);

  // 4. Customer Acquisition / Source Intelligence
  // Channels: FACEBOOK, WHATSAPP, INSTAGRAM, WALK_IN, REFERRAL, OTHER, UNKNOWN
  const ALL_SOURCES: Array<{ source: CustomerSource; label: string }> = [
    { source: 'WALK_IN', label: 'Walk-in' },
    { source: 'WHATSAPP', label: 'WhatsApp' },
    { source: 'FACEBOOK', label: 'Facebook' },
    { source: 'INSTAGRAM', label: 'Instagram' },
    { source: 'REFERRAL', label: 'Referral' },
    { source: 'OTHER', label: 'Other' },
    { source: 'UNKNOWN', label: 'Unknown / Unrecorded' },
  ];

  const sourceDataMap = new Map<CustomerSource, { customers: Set<string>; tx_count: number; sales: number }>();
  for (const s of ALL_SOURCES) {
    sourceDataMap.set(s.source, { customers: new Set<string>(), tx_count: 0, sales: 0 });
  }

  for (const tx of validTxs) {
    const cId = tx.customer_id;
    const phone = tx.customer_phone;
    const registeredCust = cId ? customerMap.get(cId) : (phone ? customerPhoneMap.get(phone) : undefined);
    
    // Explicit recorded source; never fabricated or guessed
    const source: CustomerSource = registeredCust?.customer_source && ALL_SOURCES.some(s => s.source === registeredCust.customer_source)
      ? registeredCust.customer_source
      : 'UNKNOWN';

    const sourceEntry = sourceDataMap.get(source) || sourceDataMap.get('UNKNOWN')!;
    sourceEntry.tx_count += 1;
    sourceEntry.sales += Number(tx.total_amount || 0);

    const stableId = registeredCust?.id || cId || phone || null;
    if (stableId) {
      sourceEntry.customers.add(stableId);
    }
  }

  const customerSources: CustomerSourceSummary[] = ALL_SOURCES.map(({ source, label }) => {
    const data = sourceDataMap.get(source)!;
    const salesShare = dashboardKpis.totalSales > 0 ? Math.round((data.sales / dashboardKpis.totalSales) * 1000) / 10 : 0;
    return {
      source,
      label,
      customer_count: data.customers.size,
      transaction_count: data.tx_count,
      sales: data.sales,
      sales_share: salesShare,
    };
  });

  return {
    period: {
      start: dateRange.start.toISOString().slice(0, 10),
      end: dateRange.end.toISOString().slice(0, 10),
      total_days: totalDays,
    },
    kpis: {
      total_sales: dashboardKpis.totalSales,
      merchandise_subtotal: dashboardKpis.subtotal,
      total_discounts: dashboardKpis.totalDiscounts,
      total_delivery_fees: dashboardKpis.totalDeliveryFees,
      completed_transactions: dashboardKpis.totalTransactions,
      average_transaction_value: dashboardKpis.averageTransactionValue,
      total_paid: dashboardKpis.totalPaid,
      unique_customers: dashboardKpis.uniqueCustomers,
    },
    fast_moving_products: fastMovingProducts,
    category_performance: categoryPerformance,
    customer_intelligence: {
      total_customers: customers.length,
      unique_customers: uniqueCustomerCount,
      new_customers: newCustomerCount,
      returning_customers: returningCustomerCount,
      repeat_customers: repeatCustomerCount,
      repeat_purchase_rate: repeatPurchaseRate,
      average_customer_spend: averageCustomerSpend,
      purchase_frequency: purchaseFrequency,
      top_customers: topCustomers,
    },
    customer_sources: customerSources,
  };
}
