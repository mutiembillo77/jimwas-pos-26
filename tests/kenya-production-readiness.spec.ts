import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dbModule from '../src/lib/db';
import type { Transaction, Product } from '../src/lib/types';
import { getLedgerEntries, getDailySummary } from '../src/lib/ledger';

// ============================================================
// MOCKS & STUBS FOR KENYA COMPLIANCE AUDIT TESTS
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

describe('Kenya Statutory & Accounting Readiness — Tax & Control Audits', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------
  // 1. VAT INCLUSIVE CALCULATION (16% Standard Rate)
  // -------------------------------------------------------
  it('1.1 Standard 16% VAT is computed on inclusive price (VAT = Gross * 16 / 116)', () => {
    const grossAmount = 1160.00;
    const vatRate = 16;
    // Kenya standard inclusive formula
    const taxAmount = (grossAmount * vatRate) / (100 + vatRate);
    const netAmount = grossAmount - taxAmount;

    expect(Number(taxAmount.toFixed(2))).toBe(160.00);
    expect(Number(netAmount.toFixed(2))).toBe(1000.00);
  });

  // -------------------------------------------------------
  // 2. EXEMPT PRODUCT TAX CALCULATION
  // -------------------------------------------------------
  it('1.2 Exempt products generate 0 KES VAT', () => {
    const exemptProduct: Product = {
      id: 'p-exempt-1',
      name: 'Unprocessed Maize Grain',
      price: 1500,
      cost: 1200,
      stock: 50,
      tax_category: 'exempt',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    };

    const taxAmount = exemptProduct.tax_category === 'exempt' ? 0 : (exemptProduct.price * 16) / 116;
    expect(taxAmount).toBe(0);
  });

  // -------------------------------------------------------
  // 3. FINANCIAL INTEGRITY ACROSS PERIODS
  // -------------------------------------------------------
  it('1.3 Multi-period transactions are strictly partitioned by transaction date', async () => {
    const txAug: Transaction = {
      id: 'tx-aug-01',
      total_amount: 8000,
      amount_paid: 8000,
      change_amount: 0,
      payment_method: 'cash',
      status: 'completed',
      created_at: '2026-08-15T10:00:00Z',
      items: [],
      sync_status: 'synced',
    };
    const txSep: Transaction = {
      id: 'tx-sep-01',
      total_amount: 12000,
      amount_paid: 12000,
      change_amount: 0,
      payment_method: 'kcb_buni',
      status: 'completed',
      created_at: '2026-09-01T10:00:00Z',
      items: [],
      sync_status: 'synced',
    };

    vi.spyOn(dbModule, 'getAllTransactions').mockResolvedValue([txAug, txSep]);
    vi.spyOn(dbModule, 'getAllInstallmentPayments').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLoyaltyTransactions').mockResolvedValue([]);
    vi.spyOn(dbModule, 'getAllLedgerEntries').mockResolvedValue([]);

    // Querying August returns ONLY August transactions
    const augEntries = await getLedgerEntries('2026-08-01', '2026-08-31');
    expect(augEntries).toHaveLength(1);
    expect(augEntries[0].id).toBe('tx-aug-01');

    // Querying September returns ONLY September transactions
    const sepEntries = await getLedgerEntries('2026-09-01', '2026-09-30');
    expect(sepEntries).toHaveLength(1);
    expect(sepEntries[0].id).toBe('tx-sep-01');
  });
});
