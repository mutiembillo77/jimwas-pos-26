import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supabase spy/mock
const upsertCalls: { table: string; payload: any }[] = [];
const insertCalls: { table: string; payload: any }[] = [];

vi.mock('../src/lib/supabaseClient', () => {
  return {
    supabase: {
      from: vi.fn((table: string) => ({
        upsert: vi.fn(async (payload: any) => {
          upsertCalls.push({ table, payload });
          return { data: null, error: null };
        }),
        insert: vi.fn(async (payload: any) => {
          insertCalls.push({ table, payload });
          return { data: null, error: null };
        }),
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          })),
        })),
        delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
      })),
      channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() })),
      removeChannel: vi.fn(),
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }) },
    },
  };
});

// Mock IndexedDB and DB stores for completeSale test
const mockDbStore: Record<string, Map<string, any>> = {
  transactions: new Map(),
  transaction_items: new Map(),
  stock_movements: new Map(),
  products: new Map(),
  sync_queue: new Map(),
};

vi.mock('idb', () => ({
  openDB: vi.fn().mockImplementation(() => Promise.resolve({
    get: vi.fn(async (store: string, key: string) => mockDbStore[store]?.get(key)),
    getAll: vi.fn(async (store: string) => Array.from(mockDbStore[store]?.values() || [])),
    put: vi.fn(async (store: string, val: any) => {
      mockDbStore[store]?.set(val.id, val);
      return val.id;
    }),
    delete: vi.fn(async (store: string, key: string) => {
      mockDbStore[store]?.delete(key);
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

import { completeSale } from '../src/lib/transaction-utils';
import {
  isValidUUID,
  deterministicUUID,
  sanitizeForSupabase,
  processSyncItem,
  mergeRelationalItems,
} from '../src/lib/sync';
import type { Product, CartItem } from '../src/lib/types';
import { PaymentMethod } from '../src/types/payment';

describe('Stock Movement UUID Normalization & Retry Persistence', () => {
  beforeEach(() => {
    upsertCalls.length = 0;
    insertCalls.length = 0;
    mockDbStore.transactions.clear();
    mockDbStore.transaction_items.clear();
    mockDbStore.stock_movements.clear();
    mockDbStore.products.clear();
    mockDbStore.sync_queue.clear();
  });

  // Test 1 — Stock movement creation ID
  it('Test 1 — Stock movement creation ID: generates valid, deterministic UUID not raw composite string', async () => {
    const txId = '426da753-1111-4000-8000-000000000001';
    const product: Product = {
      id: '8ef50f4a-2222-4000-8000-000000000002',
      name: 'Test Paint 4L',
      sku: 'TP4L',
      price: 1500,
      cost: 1000,
      stock: 10,
      category: 'Paint',
      is_active: true,
      sync_status: 'synced',
    };
    mockDbStore.products.set(product.id, product);

    const cart: CartItem[] = [
      {
        product_id: product.id,
        product_name: product.name,
        quantity: 2,
        unit_price: product.price,
        subtotal: 3000,
      },
    ];

    const result = await completeSale({
      cart,
      cartTotal: 3000,
      products: [product],
      selectedCustomer: null,
      paymentMethod: 'cash',
      amountPaid: 3000,
      change: 0,
      userId: 'test-cashier',
      transactionId: txId,
    });

    expect(result.success).toBe(true);

    // Verify stock movement saved locally in IndexedDB store
    const movements = Array.from(mockDbStore.stock_movements.values());
    expect(movements.length).toBe(1);
    const savedMovement = movements[0];

    const rawCompositeSeed = `${txId}-sm-${product.id}`;
    const expectedCanonicalUUID = deterministicUUID(rawCompositeSeed);

    // Invariant checks
    expect(savedMovement.id).not.toBe(rawCompositeSeed);
    expect(savedMovement.id).toBe(expectedCanonicalUUID);
    expect(isValidUUID(savedMovement.id)).toBe(true);

    // Deterministic: running with same seed produces identical UUID
    const duplicateMovementId = isValidUUID(rawCompositeSeed)
      ? rawCompositeSeed
      : deterministicUUID(rawCompositeSeed);
    expect(savedMovement.id).toBe(duplicateMovementId);
  });

  // Test 2 — Valid UUID preservation
  it('Test 2 — Valid UUID preservation: already-valid UUID returns the exact same UUID unchanged', () => {
    const validUUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    expect(isValidUUID(validUUID)).toBe(true);

    const normalized = isValidUUID(validUUID) ? validUUID : deterministicUUID(validUUID);
    expect(normalized).toBe(validUUID);

    // Verify sanitizeForSupabase preserves it
    const sanitized = sanitizeForSupabase('stock_movements', {
      id: validUUID,
      product_id: 'prod-1',
      qty_delta: -1,
      reason: 'sale',
    });
    expect(sanitized.id).toBe(validUUID);
  });

  // Test 3 — Legacy composite ID normalization
  it('Test 3 — Legacy composite ID normalization: converts legacy composite ID deterministically to valid UUID', () => {
    const txId = 'tx-12345';
    const productId = 'prod-67890';
    const legacyCompositeId = `${txId}-sm-${productId}`;

    expect(isValidUUID(legacyCompositeId)).toBe(false);

    const normalized = isValidUUID(legacyCompositeId)
      ? legacyCompositeId
      : deterministicUUID(legacyCompositeId);

    expect(isValidUUID(normalized)).toBe(true);
    expect(normalized).toBe(deterministicUUID(`${txId}-sm-${productId}`));
  });

  // Test 4 — Direct stock movement persistence payload
  it('Test 4 — Direct stock movement persistence payload: payload contains valid UUID after sanitization', () => {
    const legacyCompositeId = 'tx-direct-001-sm-prod-abc';
    const payload = {
      id: legacyCompositeId,
      product_id: 'prod-abc',
      qty_delta: -3,
      reason: 'sale',
      note: 'Sale tx-direct-001',
      balance_after: 7,
      reference_type: 'sale',
      reference_id: 'tx-direct-001',
      created_at: new Date().toISOString(),
      created_by: 'cashier-1',
      sync_status: 'pending',
    };

    const sanitized = sanitizeForSupabase('stock_movements', payload);

    expect(isValidUUID(String(sanitized.id))).toBe(true);
    expect(sanitized.id).toBe(deterministicUUID(legacyCompositeId));
    expect(sanitized.reference_type).toBe('transaction'); // confirms 'sale' -> 'transaction' alignment
  });

  // Test 5 — Queue retry
  it('Test 5 — Queue retry: queued movement with legacy composite ID is normalized to canonical UUID before upsert', async () => {
    const txId = 'tx-queue-005';
    const productId = 'prod-def-999';
    const legacyId = `${txId}-sm-${productId}`;

    const queueItem = {
      table_name: 'stock_movements',
      operation: 'insert',
      data: {
        id: legacyId,
        product_id: productId,
        qty_delta: -1,
        reason: 'sale',
        note: `Sale ${txId}`,
        balance_after: 4,
        reference_type: 'sale',
        reference_id: txId,
        created_at: '2026-09-08T10:00:00.000Z',
        created_by: 'system',
      },
    };

    await processSyncItem(queueItem);

    // Verify upsert call to Supabase
    expect(upsertCalls.length).toBe(1);
    const call = upsertCalls[0];
    expect(call.table).toBe('stock_movements');
    expect(isValidUUID(call.payload.id)).toBe(true);
    expect(call.payload.id).toBe(deterministicUUID(legacyId));
    expect(call.payload.id).not.toBe(legacyId);
  });

  // Test 6 — Retry idempotency
  it('Test 6 — Retry idempotency: processing same logical movement twice resolves to exact same UUID primary key', async () => {
    const txId = 'tx-idempotent-006';
    const productId = 'prod-xyz-123';
    const legacyId = `${txId}-sm-${productId}`;

    const queueItem = {
      table_name: 'stock_movements',
      operation: 'insert',
      data: {
        id: legacyId,
        product_id: productId,
        qty_delta: -5,
        reason: 'sale',
        note: `Sale ${txId}`,
        balance_after: 15,
        reference_type: 'sale',
        reference_id: txId,
        created_at: '2026-09-08T11:00:00.000Z',
        created_by: 'system',
      },
    };

    // Attempt 1
    await processSyncItem(queueItem);
    const firstCallUUID = upsertCalls[0].payload.id;

    // Attempt 2
    await processSyncItem(queueItem);
    const secondCallUUID = upsertCalls[1].payload.id;

    expect(firstCallUUID).toBe(secondCallUUID);
    expect(isValidUUID(firstCallUUID)).toBe(true);
    expect(firstCallUUID).toBe(deterministicUUID(legacyId));
  });

  // Test 7 — Existing transaction-item behavior preserved
  it('Test 7 — Existing transaction-item behavior: mergeRelationalItems preserves 241cc81 rules', () => {
    const txId = 'tx-compat-007';
    const productId1 = 'prod-1';
    const productId2 = 'prod-2';

    const legacyItemId = `${txId}-item-${productId1}`;
    const canonicalItemUUID = deterministicUUID(legacyItemId);

    // 1. Legacy non-UUID + remote UUID: keep only the UUID representation
    const localWithLegacy = [
      { id: legacyItemId, transaction_id: txId, product_id: productId1, quantity: 1, unit_price: 500, subtotal: 500 },
    ];
    const remoteWithUUID = [
      { id: canonicalItemUUID, transaction_id: txId, product_id: productId1, quantity: 1, unit_price: 500, subtotal: 500 },
    ];
    const mergedSingle = mergeRelationalItems(localWithLegacy, remoteWithUUID);
    expect(mergedSingle).toHaveLength(1);
    expect((mergedSingle[0] as any).id).toBe(canonicalItemUUID);

    // 2. Two legitimate UUID records for the same product: keep both
    const uuidItemA = '11111111-1111-4111-8111-111111111111';
    const uuidItemB = '22222222-2222-4222-8222-222222222222';
    const localMultiUUID = [
      { id: uuidItemA, transaction_id: txId, product_id: productId1, quantity: 1, unit_price: 500, subtotal: 500 },
      { id: uuidItemB, transaction_id: txId, product_id: productId1, quantity: 2, unit_price: 500, subtotal: 1000 },
    ];
    const mergedMulti = mergeRelationalItems(localMultiUUID, []);
    expect(mergedMulti).toHaveLength(2);
    expect(mergedMulti.map((it: any) => it.id)).toEqual([uuidItemA, uuidItemB]);

    // 3. Different products: keep each item
    const uuidItemC = '33333333-3333-4333-8333-333333333333';
    const localDistinct = [
      { id: uuidItemA, transaction_id: txId, product_id: productId1, quantity: 1, unit_price: 500, subtotal: 500 },
      { id: uuidItemC, transaction_id: txId, product_id: productId2, quantity: 3, unit_price: 100, subtotal: 300 },
    ];
    const mergedDistinct = mergeRelationalItems(localDistinct, []);
    expect(mergedDistinct).toHaveLength(2);
    expect(mergedDistinct.map((it: any) => it.product_id)).toEqual([productId1, productId2]);
  });
});
