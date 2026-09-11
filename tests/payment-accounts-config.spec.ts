import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_PAYMENT_ACCOUNTS, type PaymentAccount } from '../src/lib/settings-types';
import { ensurePaymentAccounts } from '../src/lib/init';

// In-memory mock for IndexedDB store
let mockStore = new Map<string, PaymentAccount>();

vi.mock('../src/lib/db', () => ({
  getDB: vi.fn().mockResolvedValue({
    get: vi.fn(async (storeName: string, id: string) => {
      if (storeName === 'payment_accounts') {
        return mockStore.get(id);
      }
      return undefined;
    }),
    put: vi.fn(async (storeName: string, value: PaymentAccount) => {
      if (storeName === 'payment_accounts') {
        mockStore.set(value.id, { ...value });
      }
      return value.id;
    }),
    getAll: vi.fn(async (storeName: string) => {
      if (storeName === 'payment_accounts') {
        return Array.from(mockStore.values());
      }
      return [];
    }),
    getFromIndex: vi.fn(async (storeName: string, indexName: string, key: string) => {
      if (storeName === 'payment_accounts' && indexName === 'by-code') {
        return Array.from(mockStore.values()).find(a => a.code === key);
      }
      return undefined;
    }),
  }),
  getAllProducts: vi.fn().mockResolvedValue([]),
  getAllCustomers: vi.fn().mockResolvedValue([]),
  getLastRestorePoint: vi.fn().mockResolvedValue(null),
}));

vi.mock('../src/lib/sync', () => ({
  queueForSync: vi.fn(),
  getSupabase: vi.fn().mockReturnValue(null),
}));

describe('Scope A — Payment Accounts Configuration & Seeding', () => {
  beforeEach(() => {
    mockStore.clear();
  });

  it('contains exactly 4 default accounts: CASH, KCB, NCBA, MPESA', () => {
    expect(DEFAULT_PAYMENT_ACCOUNTS).toHaveLength(4);
    const ids = DEFAULT_PAYMENT_ACCOUNTS.map(a => a.id);
    expect(ids).toContain('payment-account-cash');
    expect(ids).toContain('payment-account-kcb');
    expect(ids).toContain('payment-account-ncba');
    expect(ids).toContain('payment-account-mpesa');
  });

  it('configures CASH correctly with ID, code, and display name', () => {
    const cash = DEFAULT_PAYMENT_ACCOUNTS.find(a => a.id === 'payment-account-cash');
    expect(cash).toBeDefined();
    expect(cash?.id).toBe('payment-account-cash');
    expect(cash?.code).toBe('CASH-PRIMARY');
    expect(cash?.name).toBe('Cash (Physical)');
    expect(cash?.institution).toBe('Cash');
    expect(cash?.account_type).toBe('CASH');
    expect(cash?.status).toBe('ACTIVE');
  });

  it('configures MPESA with EXACT display name "Jimwas Mpesa A/C"', () => {
    const mpesa = DEFAULT_PAYMENT_ACCOUNTS.find(a => a.id === 'payment-account-mpesa');
    expect(mpesa).toBeDefined();
    expect(mpesa?.id).toBe('payment-account-mpesa');
    expect(mpesa?.code).toBe('MPESA-JIMWAS');
    expect(mpesa?.name).toBe('Jimwas Mpesa A/C');
    expect(mpesa?.institution).toBe('M-Pesa');
    expect(mpesa?.account_type).toBe('MOBILE_MONEY');
    expect(mpesa?.status).toBe('ACTIVE');

    // Strict assertions against prohibited variations
    expect(mpesa?.name).not.toBe('Mpesa Float');
    expect(mpesa?.name).not.toBe('M-Pesa Float');
    expect(mpesa?.name).not.toBe('MPESA Float');
    expect(mpesa?.name).not.toBe('Jimwas M-Pesa');
  });

  it('preserves existing KCB configuration unchanged', () => {
    const kcb = DEFAULT_PAYMENT_ACCOUNTS.find(a => a.id === 'payment-account-kcb');
    expect(kcb).toBeDefined();
    expect(kcb?.id).toBe('payment-account-kcb');
    expect(kcb?.code).toBe('KCB-PAYBILL-522522');
    expect(kcb?.name).toBe('KCB A/C 7941675');
    expect(kcb?.institution).toBe('KCB');
    expect(kcb?.account_type).toBe('MOBILE_MONEY');
    expect(kcb?.paybill_number).toBe('522522');
    expect(kcb?.account_number).toBe('7941675');
    expect(kcb?.account_number_masked).toBe('••••675');
    expect(kcb?.is_default).toBe(true);
    expect(kcb?.status).toBe('ACTIVE');
  });

  it('preserves existing NCBA configuration unchanged', () => {
    const ncba = DEFAULT_PAYMENT_ACCOUNTS.find(a => a.id === 'payment-account-ncba');
    expect(ncba).toBeDefined();
    expect(ncba?.id).toBe('payment-account-ncba');
    expect(ncba?.code).toBe('NCBA-PAYBILL-880100');
    expect(ncba?.name).toBe('NCBA A/C 166294');
    expect(ncba?.institution).toBe('NCBA');
    expect(ncba?.account_type).toBe('MOBILE_MONEY');
    expect(ncba?.paybill_number).toBe('880100');
    expect(ncba?.account_number).toBe('166294');
    expect(ncba?.account_number_masked).toBe('••••294');
    expect(ncba?.is_default).toBe(false);
    expect(ncba?.status).toBe('ACTIVE');
  });

  it('seeds all 4 accounts into empty database idempotently', async () => {
    expect(mockStore.size).toBe(0);

    const firstRun = await ensurePaymentAccounts();
    expect(firstRun).toHaveLength(4);
    expect(mockStore.size).toBe(4);

    expect(mockStore.has('payment-account-cash')).toBe(true);
    expect(mockStore.has('payment-account-kcb')).toBe(true);
    expect(mockStore.has('payment-account-ncba')).toBe(true);
    expect(mockStore.has('payment-account-mpesa')).toBe(true);

    // Run a second time
    const secondRun = await ensurePaymentAccounts();
    expect(secondRun).toHaveLength(4);
    expect(mockStore.size).toBe(4); // No duplicates!

    // Run a third time
    const thirdRun = await ensurePaymentAccounts();
    expect(thirdRun).toHaveLength(4);
    expect(mockStore.size).toBe(4); // Still exactly 4 records
  });

  it('preserves pre-existing KCB and NCBA records and adds missing CASH and MPESA', async () => {
    // Simulate pre-existing database with only KCB and NCBA
    const existingKcb = DEFAULT_PAYMENT_ACCOUNTS.find(a => a.id === 'payment-account-kcb')!;
    const existingNcba = DEFAULT_PAYMENT_ACCOUNTS.find(a => a.id === 'payment-account-ncba')!;
    mockStore.set('payment-account-kcb', { ...existingKcb, updated_at: '2026-08-12T00:00:00Z' });
    mockStore.set('payment-account-ncba', { ...existingNcba, updated_at: '2026-08-12T00:00:00Z' });

    expect(mockStore.size).toBe(2);

    // Run seeding
    const results = await ensurePaymentAccounts();
    expect(results).toHaveLength(4);
    expect(mockStore.size).toBe(4);

    // KCB and NCBA timestamps should remain preserved
    expect(mockStore.get('payment-account-kcb')?.updated_at).toBe('2026-08-12T00:00:00Z');
    expect(mockStore.get('payment-account-ncba')?.updated_at).toBe('2026-08-12T00:00:00Z');

    // CASH and MPESA should be newly inserted
    expect(mockStore.get('payment-account-cash')?.name).toBe('Cash (Physical)');
    expect(mockStore.get('payment-account-mpesa')?.name).toBe('Jimwas Mpesa A/C');
  });

  it('provides all 4 accounts for Checkout Payment Account selector', async () => {
    await ensurePaymentAccounts();
    const activeAccounts = Array.from(mockStore.values()).filter(a => a.status === 'ACTIVE');

    expect(activeAccounts).toHaveLength(4);
    const names = activeAccounts.map(a => a.name);
    expect(names).toEqual(expect.arrayContaining([
      'Cash (Physical)',
      'KCB A/C 7941675',
      'NCBA A/C 166294',
      'Jimwas Mpesa A/C',
    ]));
  });
});
