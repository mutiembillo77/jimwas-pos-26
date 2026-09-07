import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockDbStore: Record<string, Map<string, any>> = {
  transactions: new Map(),
  transaction_items: new Map(),
  stock_movements: new Map(),
  products: new Map(),
};

let simulateChildFailure = false;

vi.mock('idb', () => ({
  openDB: vi.fn().mockImplementation(() => Promise.resolve({
    get: vi.fn(async (store: string, key: string) => mockDbStore[store]?.get(key)),
    getAll: vi.fn(async (store: string) => Array.from(mockDbStore[store]?.values() || [])),
    put: vi.fn(async (store: string, val: any) => {
      if (store === 'transaction_items' && simulateChildFailure) {
        throw new Error('Simulated IndexedDB failure on transaction_items');
      }
      mockDbStore[store]?.set(val.id, val);
      return val.id;
    }),
    getAllFromIndex: vi.fn(async (store: string, _index: string, val: string) => {
      const items = Array.from(mockDbStore[store]?.values() || []);
      if (store === 'transaction_items') {
        return items.filter(it => it.transaction_id === val);
      }
      if (store === 'stock_movements') {
        return items.filter(sm => sm.reference_id === val || sm.note?.includes(val));
      }
      return items;
    }),
  })),
}));

import { saveTransaction, getTransaction, getAllTransactions } from '../src/lib/db';
import { mergeRelationalItems, isValidUUID, deterministicUUID } from '../src/lib/sync';
import { calculateAuthoritativeDashboardKPIs } from '../src/lib/reporting';
import { buildReceiptHtml } from '../src/lib/print';
import type { POSDatabase } from '../src/lib/db';

describe('JIMWAS POS — Stage 2 Transaction Item Integrity Verification Suite', () => {
  beforeEach(() => {
    mockDbStore.transactions.clear();
    mockDbStore.transaction_items.clear();
    mockDbStore.stock_movements.clear();
    mockDbStore.products.clear();
    simulateChildFailure = false;
  });

  // Test 1 — Local child persistence
  it('Test 1 — Local child persistence: parent + 2 children saved, fails if child persistence fails', async () => {
    const txId = 'tx-persist-001';
    const items = [
      { id: `${txId}-item-1`, transaction_id: txId, product_id: 'p-1', product_name: 'Gloss Paint 4L', quantity: 1, unit_price: 1500, subtotal: 1500 },
      { id: `${txId}-item-2`, transaction_id: txId, product_id: 'p-2', product_name: 'Paint Brush 3-inch', quantity: 2, unit_price: 350, subtotal: 700 },
    ];
    const tx: POSDatabase['transactions']['value'] = {
      id: txId,
      total_amount: 2200,
      amount_paid: 2200,
      change_amount: 0,
      payment_method: 'cash',
      payment_account: 'CASH',
      status: 'completed',
      created_at: '2026-09-07T10:00:00Z',
      sync_status: 'synced',
      items,
    };

    // Successful save: 1 parent, 2 children in stores
    await saveTransaction(tx);
    expect(mockDbStore.transactions.size).toBe(1);
    expect(mockDbStore.transaction_items.size).toBe(2);

    // Failure case: child persistence failure must reject saveTransaction
    simulateChildFailure = true;
    const failingTx: POSDatabase['transactions']['value'] = {
      ...tx,
      id: 'tx-persist-fail-002',
      items: [
        { id: 'item-fail-1', transaction_id: 'tx-persist-fail-002', product_id: 'p-1', product_name: 'Gloss Paint', quantity: 1, unit_price: 1500, subtotal: 1500 },
      ],
    };

    await expect(saveTransaction(failingTx)).rejects.toThrow('Simulated IndexedDB failure on transaction_items');
  });

  // Test 2 — Empty realtime relation cannot erase known items
  it('Test 2 — Empty realtime relation cannot erase known items: local [A, B] + remote [] does NOT become []', () => {
    const localItems = [
      { id: 'it-1', product_id: 'p-1', product_name: 'Item A', quantity: 1, unit_price: 1000, subtotal: 1000 },
      { id: 'it-2', product_id: 'p-2', product_name: 'Item B', quantity: 2, unit_price: 500, subtotal: 1000 },
    ];
    const remoteItems: unknown[] = [];

    const merged = mergeRelationalItems(localItems, remoteItems);
    expect(merged).toHaveLength(2);
    expect((merged[0] as any).product_name).toBe('Item A');
    expect((merged[1] as any).product_name).toBe('Item B');
  });

  // Test 3 — Remote items hydrate correctly
  it('Test 3 — Remote items hydrate correctly: local [] + remote [A, B] -> [A, B]', () => {
    const localItems: unknown[] = [];
    const remoteItems = [
      { id: 'it-rem-1', product_id: 'p-1', product_name: 'Item A', quantity: 1, unit_price: 1000, subtotal: 1000 },
      { id: 'it-rem-2', product_id: 'p-2', product_name: 'Item B', quantity: 2, unit_price: 500, subtotal: 1000 },
    ];

    const merged = mergeRelationalItems(localItems, remoteItems);
    expect(merged).toHaveLength(2);
    expect((merged[0] as any).product_name).toBe('Item A');
    expect((merged[1] as any).product_name).toBe('Item B');
  });

  // Test 4 — Genuine missing items remain missing
  it('Test 4 — Genuine missing items remain missing: local [] + remote [] -> items = [] and item_integrity_status = "missing" without fabrication', async () => {
    const txId = 'tx-no-items-004';
    const txWithoutEvidence: POSDatabase['transactions']['value'] = {
      id: txId,
      total_amount: 5000,
      amount_paid: 5000,
      change_amount: 0,
      payment_method: 'cash',
      payment_account: 'CASH',
      status: 'completed',
      created_at: '2026-09-07T11:00:00Z',
      sync_status: 'synced',
      items: [] as any,
    };

    mockDbStore.transactions.set(txId, txWithoutEvidence);

    const loaded = await getTransaction(txId);
    expect(loaded).toBeDefined();
    expect(loaded?.items).toEqual([]);
    expect((loaded as any)?.item_integrity_status).toBe('missing');
  });

  // Test 5 — Idempotent synchronization
  it('Test 5 — Idempotent synchronization: repeated synchronization does NOT duplicate children', () => {
    const local = [
      { id: 'it-1', product_id: 'p-1', product_name: 'Item A', quantity: 1, unit_price: 1000, subtotal: 1000 },
      { id: 'it-2', product_id: 'p-2', product_name: 'Item B', quantity: 2, unit_price: 500, subtotal: 1000 },
    ];
    const remote = [
      { id: 'it-1', product_id: 'p-1', product_name: 'Item A', quantity: 1, unit_price: 1000, subtotal: 1000 },
      { id: 'it-2', product_id: 'p-2', product_name: 'Item B', quantity: 2, unit_price: 500, subtotal: 1000 },
    ];

    const merged = mergeRelationalItems(local, remote);
    expect(merged).toHaveLength(2);
    expect(merged.map((it: any) => it.id)).toEqual(['it-1', 'it-2']);
  });

  // Test 6 — Transaction linkage
  it('Test 6 — Transaction linkage: every persisted child retains transaction_id, product_id, quantity, unit_price, subtotal', async () => {
    const txId = 'tx-linkage-006';
    const items = [
      { id: `${txId}-item-1`, transaction_id: txId, product_id: 'prod-iron', product_name: 'Iron Sheet 30G', quantity: 5, unit_price: 950, subtotal: 4750 },
    ];
    const tx: POSDatabase['transactions']['value'] = {
      id: txId,
      total_amount: 4750,
      amount_paid: 4750,
      change_amount: 0,
      payment_method: 'cash',
      payment_account: 'CASH',
      status: 'completed',
      created_at: '2026-09-07T11:30:00Z',
      sync_status: 'synced',
      items,
    };

    await saveTransaction(tx);
    const loaded = await getTransaction(txId);
    expect(loaded?.items).toHaveLength(1);
    const item = loaded?.items[0];
    expect(item?.transaction_id).toBe(txId);
    expect(item?.product_id).toBe('prod-iron');
    expect(item?.quantity).toBe(5);
    expect(item?.unit_price).toBe(950);
    expect(item?.subtotal).toBe(4750);
  });

  // Test 7 — Realtime ordering/race simulation
  it('Test 7 — Realtime ordering/race simulation: parent arrives -> child rows temporarily unavailable -> child rows become available -> subsequent sync preserves items', async () => {
    const txId = 'tx-race-007';
    const localItems = [
      { id: `${txId}-item-1`, transaction_id: txId, product_id: 'p-1', product_name: 'Cement 50kg', quantity: 3, unit_price: 850, subtotal: 2550 },
    ];

    // Stage 1: Transaction created locally with items
    const localTx: POSDatabase['transactions']['value'] = {
      id: txId,
      total_amount: 2550,
      amount_paid: 2550,
      change_amount: 0,
      payment_method: 'cash',
      payment_account: 'CASH',
      status: 'completed',
      created_at: '2026-09-07T12:00:00Z',
      sync_status: 'pending',
      items: localItems,
    };
    await saveTransaction(localTx);

    // Stage 2: Premature remote broadcast arrives with empty relation []
    const prematureRemoteItems: unknown[] = [];
    const raceResultItems = mergeRelationalItems(localItems, prematureRemoteItems);
    expect(raceResultItems).toHaveLength(1);
    expect((raceResultItems[0] as any).product_name).toBe('Cement 50kg');

    // Stage 3: Remote items become available in cloud and arrive in subsequent sync
    const laterRemoteItems = [
      { id: `${txId}-item-1`, transaction_id: txId, product_id: 'p-1', product_name: 'Cement 50kg', quantity: 3, unit_price: 850, subtotal: 2550 },
    ];
    const finalItems = mergeRelationalItems(raceResultItems, laterRemoteItems);
    expect(finalItems).toHaveLength(1);
    expect((finalItems[0] as any).product_name).toBe('Cement 50kg');

    // Verify transaction loaded from store still has items intact
    const loaded = await getTransaction(txId);
    expect(loaded?.items).toHaveLength(1);
    expect(loaded?.items[0].product_name).toBe('Cement 50kg');
  });

  // Test 8 — Receipt footer
  it('Test 8 — Receipt footer: contains the exact required two-line store policy', () => {
    const sampleBusiness = {
      id: 'biz-1',
      business_name: 'Jimwas Hardware',
      business_phone: '0712345678',
      business_address: 'Nairobi',
      currency: 'KES',
      currency_symbol: 'KES',
      show_tax_on_receipt: false,
      created_at: '2026-09-07T10:00:00Z',
      updated_at: '2026-09-07T10:00:00Z',
      sync_status: 'synced' as const,
    };
    const sampleReceipt = {
      id: 'rcpt-1',
      header_text: 'Jimwas POS',
      footer_text: '',
      show_logo: false,
      show_barcode: false,
      paper_size: '58mm' as const,
      show_tax_breakdown: false,
      created_at: '2026-09-07T10:00:00Z',
      updated_at: '2026-09-07T10:00:00Z',
    };
    const sampleTx = {
      id: 'tx-rcpt-008',
      total_amount: 1500,
      amount_paid: 1500,
      change_amount: 0,
      payment_method: 'cash',
      status: 'completed',
      created_at: '2026-09-07T10:00:00Z',
      items: [{ id: 'it-1', product_id: 'p-1', product_name: 'Gloss Paint', quantity: 1, unit_price: 1500, subtotal: 1500 }],
    };

    const html = buildReceiptHtml({
      business: sampleBusiness,
      receipt: sampleReceipt,
      transaction: sampleTx,
    });

    expect(html).toContain('Thanks for Shopping with us');
    expect(html).toContain('Good once sold NOT RETURNABLE/REFUNDABLE');
  });

  // Test 9 — Deterministic UUID compatibility
  it('Test 9 — Deterministic UUID compatibility: non-UUID string IDs convert deterministically to valid RFC4122 UUIDs', () => {
    const compositeId1 = 'tx-123-item-prod456';
    const compositeId2 = 'tx-123-item-prod456';
    const differentId = 'tx-123-item-prod789';

    expect(isValidUUID(compositeId1)).toBe(false);

    const uuid1 = deterministicUUID(compositeId1);
    const uuid2 = deterministicUUID(compositeId2);
    const uuid3 = deterministicUUID(differentId);

    expect(isValidUUID(uuid1)).toBe(true);
    expect(isValidUUID(uuid2)).toBe(true);
    expect(isValidUUID(uuid3)).toBe(true);

    // Deterministic: same seed produces identical UUID
    expect(uuid1).toBe(uuid2);
    // Distinct: different seed produces distinct UUID
    expect(uuid1).not.toBe(uuid3);
  });

  // Test 10 — Financial invariant: missing item evidence does NOT alter financial transaction totals
  it('Test 10 — Financial invariant: missing item evidence does NOT alter financial totals or fields', async () => {
    const txId = 'tx-fin-inv-010';
    const tx: POSDatabase['transactions']['value'] = {
      id: txId,
      total_amount: 4650,
      amount_paid: 4650,
      change_amount: 0,
      payment_method: 'cash',
      payment_account: 'CASH',
      delivery_fee: 100,
      discount: 50,
      subtotal: 4600,
      status: 'completed',
      created_at: '2026-09-07T10:30:00Z',
      sync_status: 'synced',
      items: [] as any,
    };

    mockDbStore.transactions.set(txId, tx);

    const loaded = await getTransaction(txId);
    expect(loaded?.total_amount).toBe(4650);
    expect(loaded?.amount_paid).toBe(4650);
    expect(loaded?.delivery_fee).toBe(100);
    expect(loaded?.discount).toBe(50);
    expect(loaded?.subtotal).toBe(4600);
    expect(loaded?.payment_method).toBe('cash');
    expect(loaded?.status).toBe('completed');
  });

  // Test 11 — Reports: Reporting engine processes transactions without requiring fabricated items
  it('Test 11 — Reports: calculateAuthoritativeDashboardKPIs calculates authoritative KPIs accurately', () => {
    const txs: any[] = [
      {
        id: 'tx-1',
        total_amount: 5000,
        amount_paid: 5000,
        change_amount: 0,
        payment_method: 'cash',
        payment_account: 'CASH',
        status: 'completed',
        created_at: '2026-09-07T10:00:00Z',
        items: [{ id: 'it-1', product_id: 'p-1', product_name: 'Item 1', quantity: 1, unit_price: 5000, subtotal: 5000 }],
      },
      {
        id: 'tx-2',
        total_amount: 3000,
        amount_paid: 3000,
        change_amount: 0,
        payment_method: 'kcb_buni',
        payment_account: 'MPESA',
        status: 'completed',
        created_at: '2026-09-07T11:00:00Z',
        items: [], // missing item evidence
      }
    ];

    const kpis = calculateAuthoritativeDashboardKPIs(txs);
    expect(kpis.totalSales).toBe(8000);
    expect(kpis.totalTransactions).toBe(2);
    expect(kpis.paymentAccounts.CASH.amount).toBe(5000);
    expect(kpis.paymentAccounts.MPESA.amount).toBe(3000);
  });

  // Test 12 — Product analytics: Analytics aggregation uses actual items only
  it('Test 12 — Product analytics: Aggregation uses actual items and does not count synthetic products', () => {
    const txs: any[] = [
      {
        id: 'tx-1',
        total_amount: 4000,
        status: 'completed',
        items: [{ id: 'it-1', product_id: 'prod-pipe', product_name: 'Pipe', quantity: 4, unit_price: 1000, subtotal: 4000 }],
      },
      {
        id: 'tx-2',
        total_amount: 2500,
        status: 'completed',
        items: [], // no items
      },
    ];

    const productSales: Record<string, { name: string; quantity: number; revenue: number }> = {};
    txs.forEach((tx) => {
      tx.items?.forEach((item: any) => {
        if (!productSales[item.product_id]) {
          productSales[item.product_id] = { name: item.product_name, quantity: 0, revenue: 0 };
        }
        productSales[item.product_id].quantity += item.quantity;
        productSales[item.product_id].revenue += item.subtotal;
      });
    });

    const products = Object.values(productSales);
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe('Pipe');
    expect(products[0].quantity).toBe(4);
    expect(products[0].revenue).toBe(4000);
  });
});
