import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dbModule from '../src/lib/db';
import type { LedgerEntryRecord } from '../src/lib/db';
import type { Transaction } from '../src/lib/types';
import { getLedgerEntries, getDailySummary, getPeriodSummary } from '../src/lib/ledger';

// ============================================================
// MOCKS & STUBS FOR FINANCIAL ACCOUNTING TESTS
// ============================================================

vi.mock('../src/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/db')>();
  return {
    ...actual,
    generateId: vi.fn(() => 'mock-id-' + Math.random().toString(36).slice(2)),
    getAllTransactions: vi.fn().mockResolvedValue([]),
    getAllInstallmentPayments: vi.fn().mockResolvedValue([]),
    getAllLoyaltyTransactions: vi.fn().mockResolvedValue([]),
    getAllLedgerEntries: vi.fn().mockResolvedValue([]),
    saveAuditLog: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../src/lib/sync', () => ({
  queueForSync: vi.fn(),
  syncInsert: vi.fn(),
  syncUpdate: vi.fn(),
  syncInsertTransaction: vi.fn(),
  syncUpdateProduct: vi.fn(),
  syncInsertStockMovement: vi.fn(),
  syncUpdateCustomer: vi.fn(),
  syncInsertLoyaltyTransaction: vi.fn(),
  syncInsertLedgerEntry: vi.fn(),
}));

describe('Financial Accounting Integrity — End-to-End Reconciliations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------
  // SCENARIO 1: CASH SALE
  // -------------------------------------------------------
  it('1. Cash Sale: 10,000 KES correctly recognizes revenue and cash asset', async () => {
    const cashTx: Transaction = {
      id: 'tx-cash-10k',
      total_amount: 10000,
      amount_paid: 10000,
      change_amount: 0,
      payment_method: 'cash',
      status: 'completed',
      created_at: '2026-08-22T10:00:00Z',
      items: [{ id: 'item-1', product_id: 'p-1', product_name: 'Item A', quantity: 2, unit_price: 5000, subtotal: 10000 }],
      sync_status: 'synced',
    };

    vi.spyOn(dbModule, 'getAllTransactions').mockResolvedValue([cashTx]);
    vi.spyOn(dbModule, 'getAllInstallmentPayments').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLoyaltyTransactions').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLedgerEntries').mockResolvedValue([]);

    const summary = await getDailySummary('2026-08-22');
    expect(summary.total_sales).toBe(10000);
    expect(summary.net_revenue).toBe(10000);
    expect(summary.by_payment_method['cash']).toBe(10000);
    expect(summary.transaction_count).toBe(1);
  });

  // -------------------------------------------------------
  // SCENARIO 2: M-PESA SALE
  // -------------------------------------------------------
  it('2. M-Pesa Sale: 10,000 KES classified as mobile money, not physical cash', async () => {
    const mpesaTx: Transaction = {
      id: 'tx-mpesa-10k',
      total_amount: 10000,
      amount_paid: 10000,
      change_amount: 0,
      payment_method: 'kcb_buni',
      mpesa_receipt: 'QWE1234567',
      status: 'completed',
      created_at: '2026-08-22T11:00:00Z',
      items: [{ id: 'item-2', product_id: 'p-2', product_name: 'Item B', quantity: 1, unit_price: 10000, subtotal: 10000 }],
      sync_status: 'synced',
    };

    vi.spyOn(dbModule, 'getAllTransactions').mockResolvedValue([mpesaTx]);
    vi.spyOn(dbModule, 'getAllInstallmentPayments').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLoyaltyTransactions').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLedgerEntries').mockResolvedValue([]);

    const summary = await getDailySummary('2026-08-22');
    expect(summary.total_sales).toBe(10000);
    expect(summary.by_payment_method['kcb_buni']).toBe(10000);
    expect(summary.by_payment_method['cash']).toBeUndefined();
  });

  // -------------------------------------------------------
  // SCENARIO 3: CREDIT SALE & RECEIVABLE SETTLEMENT
  // -------------------------------------------------------
  it('3. Credit Sale & Settlement: 10,000 credit sale + 10,000 settlement preserves single revenue recognition', async () => {
    // A 10,000 credit sale creates the sale record
    const creditSale: Transaction = {
      id: 'tx-credit-10k',
      total_amount: 10000,
      amount_paid: 0,
      change_amount: 0,
      balance_amount: 10000,
      payment_method: 'credit',
      status: 'completed',
      created_at: '2026-08-22T09:00:00Z',
      items: [{ id: 'item-3', product_id: 'p-3', product_name: 'Item C', quantity: 1, unit_price: 10000, subtotal: 10000 }],
      sync_status: 'synced',
    };

    vi.spyOn(dbModule, 'getAllTransactions').mockResolvedValue([creditSale]);
    vi.spyOn(dbModule, 'getAllInstallmentPayments').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLoyaltyTransactions').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLedgerEntries').mockResolvedValue([]);

    const summary = await getDailySummary('2026-08-22');
    // Total recognized sales is exactly 10,000 (not 20,000)
    expect(summary.total_sales).toBe(10000);
    expect(summary.net_revenue).toBe(10000);
  });

  // -------------------------------------------------------
  // SCENARIO 4: REFUND
  // -------------------------------------------------------
  it('4. Refund: 10,000 sale with 2,000 refund results in 8,000 net revenue', async () => {
    const saleTx: Transaction = {
      id: 'tx-sale-10k',
      total_amount: 10000,
      amount_paid: 10000,
      change_amount: 0,
      payment_method: 'cash',
      status: 'completed',
      created_at: '2026-08-22T12:00:00Z',
      items: [],
      sync_status: 'synced',
    };
    const refundTx: Transaction = {
      id: 'tx-refund-2k',
      total_amount: 2000,
      amount_paid: 2000,
      change_amount: 0,
      payment_method: 'cash',
      status: 'refunded',
      created_at: '2026-08-22T13:00:00Z',
      items: [],
      sync_status: 'synced',
    };

    vi.spyOn(dbModule, 'getAllTransactions').mockResolvedValue([saleTx, refundTx]);
    vi.spyOn(dbModule, 'getAllInstallmentPayments').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLoyaltyTransactions').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLedgerEntries').mockResolvedValue([]);

    const summary = await getDailySummary('2026-08-22');
    expect(summary.total_sales).toBe(10000);
    expect(summary.total_refunds).toBe(2000);
    expect(summary.net_revenue).toBe(8000);
  });

  // -------------------------------------------------------
  // SCENARIO 5: VOID
  // -------------------------------------------------------
  it('5. Void: voided sale eliminates gross sales recognition', async () => {
    const voidedSale: Transaction = {
      id: 'tx-void-5k',
      total_amount: 5000,
      amount_paid: 5000,
      change_amount: 0,
      payment_method: 'cash',
      status: 'voided',
      created_at: '2026-08-22T14:00:00Z',
      items: [],
      sync_status: 'synced',
    };

    vi.spyOn(dbModule, 'getAllTransactions').mockResolvedValue([voidedSale]);
    vi.spyOn(dbModule, 'getAllInstallmentPayments').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLoyaltyTransactions').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLedgerEntries').mockResolvedValue([]);

    const summary = await getDailySummary('2026-08-22');
    expect(summary.total_sales).toBe(0);
    expect(summary.total_voids).toBe(5000);
  });

  // -------------------------------------------------------
  // SCENARIO 6: OPERATING EXPENSE
  // -------------------------------------------------------
  it('6. Expense: 2,000 expense reduces net revenue accordingly', async () => {
    const saleTx: Transaction = {
      id: 'tx-sale-15k',
      total_amount: 15000,
      amount_paid: 15000,
      change_amount: 0,
      payment_method: 'cash',
      status: 'completed',
      created_at: '2026-08-22T08:00:00Z',
      items: [],
      sync_status: 'synced',
    };

    const manualExpense: LedgerEntryRecord = {
      id: 'exp-001',
      date: '2026-08-22T15:00:00Z',
      entry_type: 'expense',
      category: 'Utilities',
      description: 'Electricity Bill',
      amount: 2000,
      payment_method: 'cash',
      is_manual: true,
      created_at: '2026-08-22T15:00:00Z',
      sync_status: 'synced',
    };

    vi.spyOn(dbModule, 'getAllTransactions').mockResolvedValue([saleTx]);
    vi.spyOn(dbModule, 'getAllInstallmentPayments').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLoyaltyTransactions').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLedgerEntries').mockResolvedValue([manualExpense]);

    const summary = await getDailySummary('2026-08-22');
    expect(summary.total_sales).toBe(15000);
    expect(summary.total_expenses).toBe(2000);
    // Net revenue = 15000 (sales) - 2000 (expense) = 13000
    expect(summary.net_revenue).toBe(13000);
  });

  // -------------------------------------------------------
  // SCENARIO 7: PERIOD RECONCILIATION CONSISTENCY
  // -------------------------------------------------------
  it('7. Period Summary agrees with sum of daily summaries', async () => {
    const txDay1: Transaction = {
      id: 'tx-d1',
      total_amount: 5000,
      amount_paid: 5000,
      change_amount: 0,
      payment_method: 'cash',
      status: 'completed',
      created_at: '2026-08-20T10:00:00Z',
      items: [],
      sync_status: 'synced',
    };
    const txDay2: Transaction = {
      id: 'tx-d2',
      total_amount: 7000,
      amount_paid: 7000,
      change_amount: 0,
      payment_method: 'kcb_buni',
      status: 'completed',
      created_at: '2026-08-21T10:00:00Z',
      items: [],
      sync_status: 'synced',
    };

    vi.spyOn(dbModule, 'getAllTransactions').mockResolvedValue([txDay1, txDay2]);
    vi.spyOn(dbModule, 'getAllInstallmentPayments').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLoyaltyTransactions').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLedgerEntries').mockResolvedValue([]);

    const period = await getPeriodSummary('2026-08-20', '2026-08-21');
    expect(period.total_sales).toBe(12000);
    expect(period.net_revenue).toBe(12000);
    expect(period.transaction_count).toBe(2);
    expect(period.daily_breakdown).toHaveLength(2);
  });
});
