import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateAuthoritativeDashboardKPIs,
  calculateDailyTransactions,
  resolveTransactionPaymentAccount,
  isValidSalesTransaction,
  AuthoritativeDashboardKPIs,
} from '../src/lib/reporting';
import { buildCombinedDashboardReportHtml, buildReceiptHtml } from '../src/lib/print';
import type { Transaction, Customer, Product } from '../src/lib/types';
import type { BusinessSettings, ReceiptSettings } from '../src/lib/settings-types';

describe('JIMWAS POS — Stage 3 Dashboard KPIs, Daily Breakdown & Combined Printing Suite', () => {
  const sampleBusiness: BusinessSettings = {
    id: 'business-default',
    business_name: 'Jimwas Hardware & Electricals',
    business_phone: '+254712345678',
    business_address: 'Nairobi CBD, Kenya',
    currency: 'KES',
    currency_symbol: 'KES',
    show_tax_on_receipt: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sync_status: 'synced',
  };

  const sampleReceipt: ReceiptSettings = {
    id: 'receipt-default',
    header_text: 'Thank you for shopping with Jimwas POS',
    footer_text: 'Goods once sold cannot be returned',
    show_logo: false,
    show_barcode: false,
    paper_size: '58mm',
    show_tax_breakdown: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const mockCustomers: Customer[] = [
    {
      id: 'cust-1',
      name: 'Alice Wambui',
      phone: '0711111111',
      loyalty_points: 10,
      total_spent: 15000,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    },
    {
      id: 'cust-2',
      name: 'Bob Mwangi',
      phone: '0722222222',
      loyalty_points: 25,
      total_spent: 40000,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    },
  ];

  const mockProducts: Product[] = [
    {
      id: 'prod-paint',
      name: 'Crown Matt Emulsion 20L',
      price: 8500,
      cost: 6500,
      stock: 30,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    },
    {
      id: 'prod-brush',
      name: 'Paint Brush 4-inch',
      price: 350,
      cost: 200,
      stock: 50,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    },
  ];

  describe('1. Authoritative KPI Calculations & Payment Accounts', () => {
    it('calculates single completed sale with subtotal, discount, delivery fee and payment account', () => {
      const txs: Transaction[] = [
        {
          id: 'tx-1',
          customer_id: 'cust-1',
          items: [{ id: 'i-1', product_id: 'prod-paint', product_name: 'Crown Matt Emulsion 20L', quantity: 1, unit_price: 8500, subtotal: 8500 }],
          subtotal: 8500,
          discount: 200,
          delivery_type: 'to_cbd',
          delivery_fee: 100,
          total_amount: 8400, // 8500 - 200 + 100
          amount_paid: 8400,
          change_amount: 0,
          payment_method: 'cash',
          payment_account: 'CASH',
          status: 'completed',
          created_at: '2026-09-05T10:00:00Z',
        },
      ];

      const kpis = calculateAuthoritativeDashboardKPIs(txs);
      expect(kpis.totalSales).toBe(8400);
      expect(kpis.subtotal).toBe(8500);
      expect(kpis.totalDiscounts).toBe(200);
      expect(kpis.totalDeliveryFees).toBe(100);
      expect(kpis.totalTransactions).toBe(1);
      expect(kpis.averageTransactionValue).toBe(8400);
      expect(kpis.paymentAccounts.CASH.amount).toBe(8400);
      expect(kpis.paymentAccounts.CASH.count).toBe(1);
      expect(kpis.paymentAccounts.totalAmount).toBe(kpis.totalSales);
    });

    it('calculates multiple completed sales across all 4 payment accounts (KCB, NCBA, CASH, MPESA)', () => {
      const txs: Transaction[] = [
        {
          id: 'tx-cash',
          customer_id: 'cust-1',
          items: [{ id: 'i-1', product_id: 'prod-brush', product_name: 'Paint Brush 4-inch', quantity: 2, unit_price: 350, subtotal: 700 }],
          subtotal: 700,
          discount: 0,
          delivery_type: 'none',
          delivery_fee: 0,
          total_amount: 700,
          amount_paid: 700,
          change_amount: 0,
          payment_method: 'cash',
          payment_account: 'CASH',
          status: 'completed',
          created_at: '2026-09-05T09:00:00Z',
        },
        {
          id: 'tx-mpesa',
          customer_id: 'cust-2',
          items: [{ id: 'i-2', product_id: 'prod-paint', product_name: 'Crown Matt Emulsion 20L', quantity: 1, unit_price: 8500, subtotal: 8500 }],
          subtotal: 8500,
          discount: 0,
          delivery_type: 'from_cbd_300',
          delivery_fee: 300,
          total_amount: 8800,
          amount_paid: 8800,
          change_amount: 0,
          payment_method: 'kcb_buni',
          payment_account: 'MPESA',
          status: 'completed',
          created_at: '2026-09-05T11:00:00Z',
        },
        {
          id: 'tx-kcb',
          customer_id: 'cust-1',
          items: [{ id: 'i-3', product_id: 'prod-paint', product_name: 'Crown Matt Emulsion 20L', quantity: 2, unit_price: 8500, subtotal: 17000 }],
          subtotal: 17000,
          discount: 500,
          delivery_type: 'from_cbd_500',
          delivery_fee: 500,
          total_amount: 17000, // 17000 - 500 + 500
          amount_paid: 17000,
          change_amount: 0,
          payment_method: 'kcb_buni',
          payment_account: 'KCB',
          status: 'completed',
          created_at: '2026-09-05T14:00:00Z',
        },
        {
          id: 'tx-ncba',
          customer_id: 'cust-2',
          items: [{ id: 'i-4', product_id: 'prod-brush', product_name: 'Paint Brush 4-inch', quantity: 10, unit_price: 350, subtotal: 3500 }],
          subtotal: 3500,
          discount: 100,
          delivery_type: 'none',
          delivery_fee: 0,
          total_amount: 3400,
          amount_paid: 3400,
          change_amount: 0,
          payment_method: 'ncba',
          payment_account: 'NCBA',
          status: 'completed',
          created_at: '2026-09-05T16:00:00Z',
        },
      ];

      const kpis = calculateAuthoritativeDashboardKPIs(txs);
      expect(kpis.totalTransactions).toBe(4);
      // Total Sales = 700 + 8800 + 17000 + 3400 = 29900
      expect(kpis.totalSales).toBe(29900);
      expect(kpis.subtotal).toBe(700 + 8500 + 17000 + 3500); // 29700
      expect(kpis.totalDiscounts).toBe(600); // 0 + 0 + 500 + 100
      expect(kpis.totalDeliveryFees).toBe(800); // 0 + 300 + 500 + 0
      expect(kpis.averageTransactionValue).toBe(29900 / 4);

      // Payment Accounts breakdown
      expect(kpis.paymentAccounts.CASH.amount).toBe(700);
      expect(kpis.paymentAccounts.CASH.count).toBe(1);
      expect(kpis.paymentAccounts.MPESA.amount).toBe(8800);
      expect(kpis.paymentAccounts.MPESA.count).toBe(1);
      expect(kpis.paymentAccounts.KCB.amount).toBe(17000);
      expect(kpis.paymentAccounts.KCB.count).toBe(1);
      expect(kpis.paymentAccounts.NCBA.amount).toBe(3400);
      expect(kpis.paymentAccounts.NCBA.count).toBe(1);

      // 100% reconciliation check
      const sumAccounts =
        kpis.paymentAccounts.CASH.amount +
        kpis.paymentAccounts.MPESA.amount +
        kpis.paymentAccounts.KCB.amount +
        kpis.paymentAccounts.NCBA.amount;
      expect(sumAccounts).toBe(kpis.totalSales);
      expect(kpis.paymentAccounts.totalAmount).toBe(kpis.totalSales);
    });

    it('verifies all 4 delivery fee tiers are mapped and reported', () => {
      const txs: Transaction[] = [
        { id: 't-none', items: [], total_amount: 1000, subtotal: 1000, delivery_type: 'none', delivery_fee: 0, amount_paid: 1000, change_amount: 0, payment_method: 'cash', payment_account: 'CASH', status: 'completed', created_at: '2026-09-05T10:00:00Z' },
        { id: 't-cbd', items: [], total_amount: 1100, subtotal: 1000, delivery_type: 'to_cbd', delivery_fee: 100, amount_paid: 1100, change_amount: 0, payment_method: 'cash', payment_account: 'CASH', status: 'completed', created_at: '2026-09-05T10:00:00Z' },
        { id: 't-300', items: [], total_amount: 1300, subtotal: 1000, delivery_type: 'from_cbd_300', delivery_fee: 300, amount_paid: 1300, change_amount: 0, payment_method: 'cash', payment_account: 'CASH', status: 'completed', created_at: '2026-09-05T10:00:00Z' },
        { id: 't-500', items: [], total_amount: 1500, subtotal: 1000, delivery_type: 'from_cbd_500', delivery_fee: 500, amount_paid: 1500, change_amount: 0, payment_method: 'cash', payment_account: 'CASH', status: 'completed', created_at: '2026-09-05T10:00:00Z' },
      ];

      const kpis = calculateAuthoritativeDashboardKPIs(txs);
      expect(kpis.deliverySummary.noneCount).toBe(1);
      expect(kpis.deliverySummary.toCbdCount).toBe(1);
      expect(kpis.deliverySummary.toCbdAmount).toBe(100);
      expect(kpis.deliverySummary.fromCbd300Count).toBe(1);
      expect(kpis.deliverySummary.fromCbd300Amount).toBe(300);
      expect(kpis.deliverySummary.fromCbd500Count).toBe(1);
      expect(kpis.deliverySummary.fromCbd500Amount).toBe(500);
      expect(kpis.deliverySummary.totalDeliveryFees).toBe(900);
    });
  });

  describe('2. Transaction State & Historical Handling', () => {
    it('strictly excludes voided, cancelled, and failed transactions from sales KPIs', () => {
      const txs: Transaction[] = [
        {
          id: 'tx-valid',
          items: [],
          total_amount: 5000,
          subtotal: 5000,
          amount_paid: 5000,
          change_amount: 0,
          payment_method: 'cash',
          payment_account: 'CASH',
          status: 'completed',
          created_at: '2026-09-05T10:00:00Z',
        },
        {
          id: 'tx-voided',
          items: [],
          total_amount: 8000,
          subtotal: 8000,
          amount_paid: 8000,
          change_amount: 0,
          payment_method: 'cash',
          payment_account: 'CASH',
          status: 'voided',
          created_at: '2026-09-05T10:30:00Z',
        },
        {
          id: 'tx-cancelled',
          items: [],
          total_amount: 4000,
          subtotal: 4000,
          amount_paid: 0,
          change_amount: 0,
          payment_method: 'kcb_buni',
          payment_account: 'MPESA',
          status: 'cancelled',
          created_at: '2026-09-05T11:00:00Z',
        },
        {
          id: 'tx-failed',
          items: [],
          total_amount: 2500,
          subtotal: 2500,
          amount_paid: 0,
          change_amount: 0,
          payment_method: 'kcb_buni',
          payment_account: 'MPESA',
          status: 'failed',
          created_at: '2026-09-05T11:30:00Z',
        },
      ];

      const kpis = calculateAuthoritativeDashboardKPIs(txs);
      expect(kpis.totalTransactions).toBe(1);
      expect(kpis.totalSales).toBe(5000);
      expect(kpis.paymentAccounts.CASH.amount).toBe(5000);
    });

    it('safely resolves historical records with missing payment_account and delivery fields', () => {
      const historicalTxs: Transaction[] = [
        {
          id: 'hist-1',
          items: [{ id: 'i-1', product_id: 'prod-brush', product_name: 'Paint Brush 4-inch', quantity: 1, unit_price: 350, subtotal: 350 }],
          total_amount: 350,
          amount_paid: 350,
          change_amount: 0,
          payment_method: 'cash',
          status: 'completed',
          created_at: '2026-08-10T12:00:00Z',
        },
        {
          id: 'hist-2',
          items: [{ id: 'i-2', product_id: 'prod-paint', product_name: 'Crown Matt Emulsion 20L', quantity: 1, unit_price: 8500, subtotal: 8500 }],
          total_amount: 8500,
          amount_paid: 8500,
          change_amount: 0,
          payment_method: 'kcb_buni',
          status: 'completed',
          created_at: '2026-08-11T14:00:00Z',
        },
      ];

      const kpis = calculateAuthoritativeDashboardKPIs(historicalTxs);
      expect(kpis.totalSales).toBe(8850);
      expect(kpis.totalDeliveryFees).toBe(0);
      expect(kpis.totalDiscounts).toBe(0);
      // Cash mapped to CASH, kcb_buni mapped to MPESA
      expect(kpis.paymentAccounts.CASH.amount).toBe(350);
      expect(kpis.paymentAccounts.MPESA.amount).toBe(8500);
    });
  });

  describe('3. Scrollable Daily Sales Breakdown', () => {
    it('generates all calendar days without silent truncation for a full 31-day month', () => {
      const augustStart = new Date(2026, 7, 1); // Aug 1, 2026
      const augustEnd = new Date(2026, 7, 31); // Aug 31, 2026

      const txs: Transaction[] = [
        {
          id: 'aug-1',
          items: [],
          total_amount: 1500,
          subtotal: 1500,
          delivery_fee: 0,
          discount: 0,
          amount_paid: 1500,
          change_amount: 0,
          payment_method: 'cash',
          payment_account: 'CASH',
          status: 'completed',
          created_at: '2026-08-01T10:00:00Z',
        },
        {
          id: 'aug-31',
          items: [],
          total_amount: 4200,
          subtotal: 4200,
          delivery_fee: 0,
          discount: 0,
          amount_paid: 4200,
          change_amount: 0,
          payment_method: 'kcb_buni',
          payment_account: 'MPESA',
          status: 'completed',
          created_at: '2026-08-31T18:00:00Z',
        },
      ];

      const daily = calculateDailyTransactions(txs, { start: augustStart, end: augustEnd });
      // Full 31 days must be present
      expect(daily.length).toBe(31);
      expect(daily[0].date).toBe('2026-08-01');
      expect(daily[0].totalSales).toBe(1500);
      expect(daily[0].transactionCount).toBe(1);

      expect(daily[30].date).toBe('2026-08-31');
      expect(daily[30].totalSales).toBe(4200);
      expect(daily[30].transactionCount).toBe(1);

      // Days with zero sales must still exist and clearly report 0
      expect(daily[15].totalSales).toBe(0);
      expect(daily[15].transactionCount).toBe(0);

      const totalDaysSum = daily.reduce((sum, d) => sum + d.totalSales, 0);
      expect(totalDaysSum).toBe(1500 + 4200);
    });
  });

  describe('4. Combined Printing & Financial Reconciliation', () => {
    it('builds combined report containing Section A (KPIs) and Section B (Daily Detailed line items)', () => {
      const txs: Transaction[] = [
        {
          id: 'tx-rep-1',
          customer_id: 'cust-1',
          customer_name: 'Alice Wambui',
          items: [{ id: 'i-1', product_id: 'prod-paint', product_name: 'Crown Matt Emulsion 20L', quantity: 2, unit_price: 8500, subtotal: 17000 }],
          subtotal: 17000,
          discount: 200,
          delivery_type: 'from_cbd_300',
          delivery_fee: 300,
          total_amount: 17100, // 17000 - 200 + 300
          amount_paid: 17100,
          change_amount: 0,
          payment_method: 'kcb_buni',
          payment_account: 'MPESA',
          status: 'completed',
          created_at: '2026-09-05T11:00:00Z',
        },
      ];

      const kpis = calculateAuthoritativeDashboardKPIs(txs);
      const daily = calculateDailyTransactions(txs, { start: new Date(2026, 8, 5), end: new Date(2026, 8, 5) });

      const html = buildCombinedDashboardReportHtml({
        business: sampleBusiness,
        receipt: sampleReceipt,
        periodLabel: 'Today (Sep 5, 2026)',
        cashierName: 'Jane Mwangi',
        kpis,
        dailySummaries: daily,
        detailedTransactions: txs,
        customers: mockCustomers,
        products: mockProducts,
      });

      // SECTION A verification
      expect(html).toContain('SECTION A &mdash; DASHBOARD KPI SUMMARY');
      expect(html).toContain('KES 17,100'); // Total sales
      expect(html).toContain('KES 17,000'); // Merchandise subtotal
      expect(html).toContain('KES 300'); // Delivery
      expect(html).toContain('KES 200'); // Discount
      expect(html).toContain('MPESA (KCB BUNI)');
      expect(html).toContain('KES 17,100');

      // SECTION B verification
      expect(html).toContain('SECTION B &mdash; DAILY DETAILED REPORT (LINE ITEMS)');
      expect(html).toContain('Crown Matt Emulsion 20L');
      expect(html).toContain('Alice Wambui');
      expect(html).toContain('Jane Mwangi');
    });

    it('SECTION 17 RECONCILIATION CHAIN: Authoritative Reporting = Dashboard = Printed Report = Detailed Report', () => {
      const representativeTxs: Transaction[] = [
        {
          id: 'tx-rec-1',
          items: [{ id: 'it-1', product_id: 'prod-paint', product_name: 'Crown Matt Emulsion 20L', quantity: 1, unit_price: 8500, subtotal: 8500 }],
          subtotal: 8500,
          discount: 100,
          delivery_type: 'to_cbd',
          delivery_fee: 100,
          total_amount: 8500,
          amount_paid: 8500,
          change_amount: 0,
          payment_method: 'cash',
          payment_account: 'CASH',
          status: 'completed',
          created_at: '2026-09-05T09:30:00Z',
        },
        {
          id: 'tx-rec-2',
          items: [{ id: 'it-2', product_id: 'prod-brush', product_name: 'Paint Brush 4-inch', quantity: 4, unit_price: 350, subtotal: 1400 }],
          subtotal: 1400,
          discount: 0,
          delivery_type: 'from_cbd_300',
          delivery_fee: 300,
          total_amount: 1700,
          amount_paid: 1700,
          change_amount: 0,
          payment_method: 'kcb_buni',
          payment_account: 'MPESA',
          status: 'completed',
          created_at: '2026-09-05T14:15:00Z',
        },
      ];

      // 1. Authoritative reporting layer calculation
      const authKpis = calculateAuthoritativeDashboardKPIs(representativeTxs);
      const authoritativeTotal = authKpis.totalSales; // 8500 + 1700 = 10200

      // 2. Dashboard screen aggregation
      const dashboardTotal = authKpis.totalSales;

      // 3. Daily breakdown sum
      const daily = calculateDailyTransactions(representativeTxs, { start: new Date(2026, 8, 5), end: new Date(2026, 8, 5) });
      const dailyDetailedReportTotal = daily.reduce((sum, d) => sum + d.totalSales, 0);

      // 4. Printed Dashboard Report HTML
      const printedHtml = buildCombinedDashboardReportHtml({
        business: sampleBusiness,
        periodLabel: 'Today (Sep 5, 2026)',
        kpis: authKpis,
        dailySummaries: daily,
        detailedTransactions: representativeTxs,
        customers: mockCustomers,
        products: mockProducts,
      });

      // Assert complete equality across all 4 surfaces
      expect(authoritativeTotal).toBe(10200);
      expect(dashboardTotal).toBe(authoritativeTotal);
      expect(dailyDetailedReportTotal).toBe(authoritativeTotal);
      expect(printedHtml).toContain('KES 10,200');

      // Payment account totals reconciliation chain
      const authPaymentAccountTotal = authKpis.paymentAccounts.totalAmount;
      const paymentAccountsSum = authKpis.paymentAccounts.CASH.amount + authKpis.paymentAccounts.MPESA.amount;
      expect(authPaymentAccountTotal).toBe(10200);
      expect(paymentAccountsSum).toBe(authoritativeTotal);
      expect(printedHtml).toContain('CASH');
      expect(printedHtml).toContain('KES 8,500');
      expect(printedHtml).toContain('MPESA (KCB BUNI)');
      expect(printedHtml).toContain('KES 1,700');
    });

    it('preserves existing checkout receipt printing without regression', () => {
      const printTx = {
        id: 'tx-regress-print',
        items: [{ product_name: 'Paint Brush 4-inch', quantity: 2, unit_price: 350, subtotal: 700 }],
        total_amount: 700,
        amount_paid: 1000,
        change_amount: 300,
        payment_method: 'cash',
        payment_account: 'CASH',
        created_at: '2026-09-05T12:00:00Z',
      };

      const receiptHtml = buildReceiptHtml({
        business: sampleBusiness,
        receipt: sampleReceipt,
        transaction: printTx,
      });

      expect(receiptHtml).toContain('TOTAL:');
      expect(receiptHtml).toContain('KES 700');
      expect(receiptHtml).toContain('PAID:');
      expect(receiptHtml).toContain('KES 1,000');
      expect(receiptHtml).toContain('Payment Account:');
      expect(receiptHtml).toContain('CASH');
    });
  });
});
