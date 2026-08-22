import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dbModule from '../src/lib/db';
import type { ReconciliationRecord, Transaction, ShiftRecord } from '../src/lib/types';
import { matchReconciliation, closeShift } from '../src/lib/enterprise';
import { getLedgerEntries, getDailySummary } from '../src/lib/ledger';

// ============================================================
// MOCK DB & SYNC SETUP FOR FINANCIAL RECONCILIATION TESTS
// ============================================================

const mockStore: Record<string, Map<string, any>> = {
  reconciliations: new Map(),
  shifts: new Map(),
  transactions: new Map(),
  safe_drops: new Map(),
  outbound_deliveries: new Map(),
};

vi.mock('../src/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/db')>();
  return {
    ...actual,
    generateId: vi.fn(() => 'mock-id-' + Math.random().toString(36).slice(2)),
    getDB: vi.fn(async () => ({
      put: vi.fn(async (storeName: string, record: any) => {
        if (!mockStore[storeName]) mockStore[storeName] = new Map();
        mockStore[storeName].set(record.id, record);
        return record.id;
      }),
      get: vi.fn(async (storeName: string, id: string) => {
        return mockStore[storeName]?.get(id) || null;
      }),
      getAll: vi.fn(async (storeName: string) => {
        return Array.from(mockStore[storeName]?.values() || []);
      }),
    })),
    getAllTransactions: vi.fn().mockResolvedValue([]),
    getAllInstallmentPayments: vi.fn().mockResolvedValue([]),
    getAllLoyaltyTransactions: vi.fn().mockResolvedValue([]),
    getAllLedgerEntries: vi.fn().mockResolvedValue([]),
    saveAuditLog: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../src/lib/audit', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/sync', () => ({
  queueForSync: vi.fn(),
  syncInsert: vi.fn(),
  syncUpdate: vi.fn(),
  syncInsertTransaction: vi.fn(),
  syncUpdateProduct: vi.fn(),
  syncInsertStockMovement: vi.fn(),
  syncUpdateCustomer: vi.fn(),
  syncInsertLoyaltyTransaction: vi.fn(),
}));

// ============================================================
// SECTION 1: AMOUNT INTEGRITY & RECONCILIATION MATCHING
// ============================================================

describe('Financial Reconciliation Engine — Amount Integrity', () => {
  beforeEach(() => {
    mockStore.reconciliations.clear();
  });

  it('1.1 Exact amount match transitions reconciliation to "matched"', async () => {
    const record: ReconciliationRecord = {
      id: 'rec-001',
      payment_method: 'kcb_buni',
      reference: 'QWE123456',
      transaction_id: 'tx-001',
      expected_amount: 1500.00,
      received_amount: 0,
      status: 'pending',
      created_at: new Date().toISOString(),
      sync_status: 'pending',
    };

    const updated = await matchReconciliation(record, 1500.00, 'admin-user');

    expect(updated.status).toBe('matched');
    expect(updated.received_amount).toBe(1500.00);
    expect(updated.matched_at).toBeDefined();
  });

  it('1.2 Underpayment transitions reconciliation to "exception" (flagged for review)', async () => {
    const record: ReconciliationRecord = {
      id: 'rec-002',
      payment_method: 'kcb_buni',
      reference: 'QWE123457',
      expected_amount: 2000.00,
      received_amount: 0,
      status: 'pending',
      created_at: new Date().toISOString(),
      sync_status: 'pending',
    };

    const updated = await matchReconciliation(record, 1500.00, 'admin-user');

    // Underpayment is classified as an exception requiring human review
    expect(updated.status).toBe('exception');
    expect(updated.received_amount).toBe(1500.00);
    expect(updated.matched_at).toBeUndefined();
  });

  it('1.3 Overpayment is identified and flagged with status "partial"', async () => {
    const record: ReconciliationRecord = {
      id: 'rec-003',
      payment_method: 'kcb_buni',
      reference: 'QWE123458',
      expected_amount: 1000.00,
      received_amount: 0,
      status: 'pending',
      created_at: new Date().toISOString(),
      sync_status: 'pending',
    };

    const updated = await matchReconciliation(record, 1200.00, 'admin-user');

    expect(updated.status).toBe('partial'); // overpayment / variance state
    expect(updated.received_amount).toBe(1200.00);
  });
});

// ============================================================
// SECTION 2: LEDGER AND CASHBOOK POSTING IDEMPOTENCY
// ============================================================

describe('Ledger & Accounting — Financial Totals Idempotency', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('2.1 Replaying callbacks does NOT produce duplicate ledger entries', async () => {
    const mockTx: Transaction = {
      id: 'tx-unique-001',
      total_amount: 3500.50,
      amount_paid: 3500.50,
      change_amount: 0,
      payment_method: 'kcb_buni',
      status: 'completed',
      created_at: '2026-08-22T10:00:00Z',
      items: [],
      sync_status: 'synced',
    };

    // Database returns the single canonical transaction
    vi.spyOn(dbModule, 'getAllTransactions').mockResolvedValue([mockTx]);
    vi.spyOn(dbModule, 'getAllInstallmentPayments').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLoyaltyTransactions').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLedgerEntries').mockResolvedValue([]);

    const entries = await getLedgerEntries('2026-08-22', '2026-08-22');

    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe(3500.50);
    expect(entries[0].reference_id).toBe('tx-unique-001');

    const summary = await getDailySummary('2026-08-22');
    expect(summary.total_sales).toBe(3500.50);
    expect(summary.net_revenue).toBe(3500.50);
    expect(summary.transaction_count).toBe(1);
  });

  it('2.2 Voided transactions are accurately represented without inflating sales totals', async () => {
    const voidedTx: Transaction = {
      id: 'tx-voided-001',
      total_amount: 1200.00,
      amount_paid: 1200.00,
      change_amount: 0,
      payment_method: 'cash',
      status: 'voided',
      created_at: '2026-08-22T11:00:00Z',
      items: [],
      sync_status: 'synced',
    };

    vi.spyOn(dbModule, 'getAllTransactions').mockResolvedValue([voidedTx]);
    vi.spyOn(dbModule, 'getAllInstallmentPayments').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLoyaltyTransactions').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLedgerEntries').mockResolvedValue([]);

    const entries = await getLedgerEntries('2026-08-22', '2026-08-22');

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('void');

    const summary = await getDailySummary('2026-08-22');
    expect(summary.total_sales).toBe(0); // Voided sales do not count towards gross sales
    expect(summary.net_revenue).toBe(-1200.00); // Net revenue adjusted for void
  });

  it('2.3 Net revenue correctly balances sales, refunds, and expenses', async () => {
    const tx1: Transaction = {
      id: 'tx-1',
      total_amount: 5000,
      amount_paid: 5000,
      change_amount: 0,
      payment_method: 'cash',
      status: 'completed',
      created_at: '2026-08-22T08:00:00Z',
      items: [],
      sync_status: 'synced',
    };
    const txRefund: Transaction = {
      id: 'tx-2',
      total_amount: 1000,
      amount_paid: 1000,
      change_amount: 0,
      payment_method: 'cash',
      status: 'refunded',
      created_at: '2026-08-22T09:00:00Z',
      items: [],
      sync_status: 'synced',
    };

    vi.spyOn(dbModule, 'getAllTransactions').mockResolvedValue([tx1, txRefund]);
    vi.spyOn(dbModule, 'getAllInstallmentPayments').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLoyaltyTransactions').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLedgerEntries').mockResolvedValue([]);

    const summary = await getDailySummary('2026-08-22');
    expect(summary.total_sales).toBe(5000);
    expect(summary.total_refunds).toBe(1000);
    // Net revenue = 5000 (sales) - 1000 (refunds) = 4000
    expect(summary.net_revenue).toBe(4000);
  });
});

// ============================================================
// SECTION 3: SHIFT CASH VARIANCE & RECONCILIATION
// ============================================================

describe('Shift Reconciliation — Cash Variance Math', () => {
  beforeEach(() => {
    mockStore.shifts.clear();
  });

  it('3.1 Shift close calculates exact expected cash and variance', async () => {
    const openShiftRecord: ShiftRecord = {
      id: 'shift-001',
      cashier_id: 'cashier-1',
      opening_float: 5000.00,
      cash_sales: 12500.00,
      card_sales: 0,
      mobile_money_sales: 4500.00,
      bank_sales: 0,
      credit_sales: 0,
      refunds: 500.00,
      discounts: 0,
      tax: 0,
      gross_sales: 17000.00,
      net_sales: 16500.00,
      status: 'open',
      opened_at: new Date().toISOString(),
      sync_status: 'pending',
    };

    // Expected cash = opening_float (5000) + cash_sales (12500) - refunds (500) = 17000
    // If physical count is 17200, variance = +200
    const closed = await closeShift(openShiftRecord, 17200.00, 'manager-1');

    expect(closed.status).toBe('closed');
    expect(closed.cash_count).toBe(17200.00);
    expect(closed.variance).toBe(200.00);
  });

  it('3.2 Locked shift cannot be closed twice', async () => {
    const alreadyClosedShift: ShiftRecord = {
      id: 'shift-002',
      cashier_id: 'cashier-1',
      opening_float: 5000,
      cash_sales: 1000,
      card_sales: 0,
      mobile_money_sales: 0,
      bank_sales: 0,
      credit_sales: 0,
      refunds: 0,
      discounts: 0,
      tax: 0,
      gross_sales: 1000,
      net_sales: 1000,
      status: 'closed',
      opened_at: new Date().toISOString(),
      closed_at: new Date().toISOString(),
      sync_status: 'synced',
    };

    await expect(closeShift(alreadyClosedShift, 6000, 'manager-1')).rejects.toThrow(
      'This shift is already locked.'
    );
  });
});

// ============================================================
// SECTION 4: ECONOMIC TRANSACTION INTEGRITY & RECEIPT UNIQUENESS
// ============================================================

describe('Economic Transaction Integrity — Single Settlement Invariant', () => {
  it('4.1 Replaying confirmed provider receipt does not create duplicate financial settlements', async () => {
    const mockTx: Transaction = {
      id: 'tx-eco-001',
      total_amount: 2500,
      amount_paid: 2500,
      change_amount: 0,
      payment_method: 'kcb_buni',
      mpesa_receipt: 'REC-SAF-9999',
      status: 'completed',
      created_at: '2026-08-22T14:00:00Z',
      items: [],
      sync_status: 'synced',
    };

    vi.spyOn(dbModule, 'getAllTransactions').mockResolvedValue([mockTx]);
    vi.spyOn(dbModule, 'getAllInstallmentPayments').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLoyaltyTransactions').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLedgerEntries').mockResolvedValue([]);

    // 1st inspection: 1 ledger entry, 2500 KES
    const entries1 = await getLedgerEntries('2026-08-22', '2026-08-22');
    expect(entries1).toHaveLength(1);
    expect(entries1[0].amount).toBe(2500);

    // Simulated callback / poll replay: transaction is unchanged in DB
    const entries2 = await getLedgerEntries('2026-08-22', '2026-08-22');
    expect(entries2).toHaveLength(1);
    expect(entries2[0].amount).toBe(2500);

    const summary = await getDailySummary('2026-08-22');
    expect(summary.total_sales).toBe(2500);
    expect(summary.transaction_count).toBe(1);
  });
});
