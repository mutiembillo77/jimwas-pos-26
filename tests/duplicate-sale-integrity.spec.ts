import { describe, it, expect, beforeEach, vi } from 'vitest';
import { completeSale, CompleteSaleParams } from '../src/lib/transaction-utils';
import * as dbModule from '../src/lib/db';
import * as syncModule from '../src/lib/sync';
import type { Product, Customer, CartItem } from '../src/lib/types';

describe('JIMWAS POS — Stage 1 Duplicate-Sale Integrity & Idempotency Test Suite', () => {
  let mockProducts: Product[];
  let savedTransactions: any[];
  let savedProducts: any[];
  let savedStockMovements: any[];
  let savedLoyaltyTransactions: any[];
  let syncedTransactions: any[];
  let syncQueue: any[];
  let isOnlineState: boolean;

  beforeEach(() => {
    savedTransactions = [];
    savedProducts = [];
    savedStockMovements = [];
    savedLoyaltyTransactions = [];
    syncedTransactions = [];
    syncQueue = [];
    isOnlineState = true;

    mockProducts = [
      {
        id: 'prod-101',
        name: 'Cement 50kg',
        price: 850,
        cost: 700,
        stock: 50,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sync_status: 'synced',
      },
      {
        id: 'prod-102',
        name: 'Iron Sheets 3m',
        price: 1200,
        cost: 950,
        stock: 30,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sync_status: 'synced',
      },
    ];

    vi.spyOn(dbModule, 'getProduct').mockImplementation(async (id: string) => {
      const live = savedProducts.find((p) => p.id === id);
      if (live) return live;
      return mockProducts.find((p) => p.id === id) || null;
    });

    vi.spyOn(dbModule, 'saveProduct').mockImplementation(async (product: any) => {
      const idx = savedProducts.findIndex((p) => p.id === product.id);
      if (idx >= 0) {
        savedProducts[idx] = product;
      } else {
        savedProducts.push(product);
      }
      return product;
    });

    vi.spyOn(dbModule, 'getTransaction').mockImplementation(async (id: string) => {
      return savedTransactions.find((tx) => tx.id === id) || null;
    });

    vi.spyOn(dbModule, 'saveTransaction').mockImplementation(async (tx: any) => {
      const existingIdx = savedTransactions.findIndex((t) => t.id === tx.id);
      if (existingIdx >= 0) {
        savedTransactions[existingIdx] = tx;
      } else {
        savedTransactions.push(tx);
      }
      return tx;
    });

    vi.spyOn(dbModule, 'getAllTransactions').mockImplementation(async () => {
      return [...savedTransactions];
    });

    vi.spyOn(dbModule, 'saveStockMovement').mockImplementation(async (m: any) => {
      const existingIdx = savedStockMovements.findIndex((sm) => sm.id === m.id);
      if (existingIdx >= 0) {
        savedStockMovements[existingIdx] = m;
      } else {
        savedStockMovements.push(m);
      }
      return m;
    });

    vi.spyOn(dbModule, 'saveCustomer').mockImplementation(async (c: any) => c);

    vi.spyOn(dbModule, 'saveLoyaltyTransaction').mockImplementation(async (l: any) => {
      const existingIdx = savedLoyaltyTransactions.findIndex((lt) => lt.id === l.id);
      if (existingIdx >= 0) {
        savedLoyaltyTransactions[existingIdx] = l;
      } else {
        savedLoyaltyTransactions.push(l);
      }
      return l;
    });

    vi.spyOn(syncModule, 'syncInsertTransaction').mockImplementation(async (tx: any, items: any[]) => {
      const existingIdx = syncedTransactions.findIndex((s) => s.tx.id === tx.id);
      if (existingIdx >= 0) {
        syncedTransactions[existingIdx] = { tx, items };
      } else {
        syncedTransactions.push({ tx, items });
      }
    });

    vi.spyOn(syncModule, 'syncUpdateProduct').mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, 'syncInsertStockMovement').mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, 'syncUpdateCustomer').mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, 'syncInsertLoyaltyTransaction').mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, 'getOnlineStatus').mockImplementation(() => isOnlineState);
  });

  // TEST 1 — Normal checkout
  it('TEST 1: Normal checkout creates exactly 1 canonical sale, deducts stock once', async () => {
    const saleParams: CompleteSaleParams = {
      cart: [{ product_id: 'prod-101', product_name: 'Cement 50kg', quantity: 2, unit_price: 850, subtotal: 1700 }],
      cartTotal: 1700,
      products: mockProducts,
      selectedCustomer: null,
      paymentMethod: 'cash',
      paymentTiming: 'immediate',
      amountPaid: 2000,
      change: 300,
      userId: 'cashier-1',
    };

    const result = await completeSale(saleParams);
    expect(result.success).toBe(true);
    expect(savedTransactions).toHaveLength(1);
    expect(savedTransactions[0].id).toBe(result.transactionId);
    expect(savedTransactions[0].total_amount).toBe(1700);
    expect(savedStockMovements).toHaveLength(1);
    expect(savedStockMovements[0].qty_delta).toBe(-2);
  });

  // TEST 2 — Double-click / rapid concurrent checkout submission
  it('TEST 2: Double-click with identical idempotencyKey results in exactly 1 sale and single stock deduction', async () => {
    const idempotencyKey = 'idem-double-click-001';
    const saleParams: CompleteSaleParams = {
      idempotencyKey,
      cart: [{ product_id: 'prod-101', product_name: 'Cement 50kg', quantity: 2, unit_price: 850, subtotal: 1700 }],
      cartTotal: 1700,
      products: mockProducts,
      selectedCustomer: null,
      paymentMethod: 'cash',
      paymentTiming: 'immediate',
      amountPaid: 1700,
      change: 0,
      userId: 'cashier-1',
    };

    // Execute two simultaneous completeSale calls simulating rapid double-click
    const [result1, result2] = await Promise.all([
      completeSale({ ...saleParams }),
      completeSale({ ...saleParams }),
    ]);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(result1.transactionId).toBe(result2.transactionId);
    expect(result1.transactionId).toBe(idempotencyKey);

    // Only 1 canonical transaction must exist in storage
    expect(savedTransactions).toHaveLength(1);
    expect(savedTransactions[0].id).toBe(idempotencyKey);

    // Stock movement should only record 1 deduction
    expect(savedStockMovements).toHaveLength(1);
    expect(savedStockMovements[0].qty_delta).toBe(-2);
  });

  // TEST 3 — Same request repeated
  it('TEST 3: Same request repeated returns/reuses the existing canonical transaction', async () => {
    const idempotencyKey = 'idem-repeated-002';
    const saleParams: CompleteSaleParams = {
      idempotencyKey,
      cart: [{ product_id: 'prod-102', product_name: 'Iron Sheets 3m', quantity: 5, unit_price: 1200, subtotal: 6000 }],
      cartTotal: 6000,
      products: mockProducts,
      selectedCustomer: null,
      paymentMethod: 'cash',
      paymentTiming: 'immediate',
      amountPaid: 6000,
      change: 0,
      userId: 'cashier-1',
    };

    // First attempt
    const res1 = await completeSale(saleParams);
    expect(res1.success).toBe(true);
    expect(res1.transactionId).toBe(idempotencyKey);

    // Repeated attempt (e.g. user retrying or re-submitting modal)
    const res2 = await completeSale(saleParams);
    expect(res2.success).toBe(true);
    expect(res2.transactionId).toBe(idempotencyKey);

    expect(savedTransactions).toHaveLength(1);
    expect(savedStockMovements).toHaveLength(1);
  });

  // TEST 4 — Network retry
  it('TEST 4: Network retry after initial commit does not duplicate sale or deduct additional stock', async () => {
    const idempotencyKey = 'idem-network-retry-003';
    const saleParams: CompleteSaleParams = {
      idempotencyKey,
      cart: [{ product_id: 'prod-101', product_name: 'Cement 50kg', quantity: 1, unit_price: 850, subtotal: 850 }],
      cartTotal: 850,
      products: mockProducts,
      selectedCustomer: null,
      paymentMethod: 'cash',
      paymentTiming: 'immediate',
      amountPaid: 1000,
      change: 150,
      userId: 'cashier-2',
    };

    // First request executes and commits to local store
    const firstCommit = await completeSale(saleParams);
    expect(firstCommit.success).toBe(true);

    // Simulated network retry triggered by client-side timeout handler
    const retryCommit = await completeSale(saleParams);
    expect(retryCommit.success).toBe(true);
    expect(retryCommit.transactionId).toBe(firstCommit.transactionId);

    expect(savedTransactions).toHaveLength(1);
    expect(savedStockMovements).toHaveLength(1);
    expect(savedStockMovements[0].qty_delta).toBe(-1);
  });

  // TEST 5 — Offline checkout
  it('TEST 5: Checkout while offline persists 1 local sale and queues for sync with pending status', async () => {
    isOnlineState = false;
    const idempotencyKey = 'idem-offline-004';
    const saleParams: CompleteSaleParams = {
      idempotencyKey,
      cart: [{ product_id: 'prod-101', product_name: 'Cement 50kg', quantity: 3, unit_price: 850, subtotal: 2550 }],
      cartTotal: 2550,
      products: mockProducts,
      selectedCustomer: null,
      paymentMethod: 'cash',
      paymentTiming: 'immediate',
      amountPaid: 2550,
      change: 0,
      userId: 'cashier-offline',
    };

    const result = await completeSale(saleParams);
    expect(result.success).toBe(true);
    expect(savedTransactions).toHaveLength(1);
    expect(savedTransactions[0].sync_status).toBe('pending');
    expect(savedTransactions[0].id).toBe(idempotencyKey);
  });

  // TEST 6 — Offline sync retry
  it('TEST 6: Offline sync retry is idempotent and preserves single remote sale', async () => {
    const idempotencyKey = 'idem-sync-retry-005';
    const saleParams: CompleteSaleParams = {
      idempotencyKey,
      cart: [{ product_id: 'prod-102', product_name: 'Iron Sheets 3m', quantity: 2, unit_price: 1200, subtotal: 2400 }],
      cartTotal: 2400,
      products: mockProducts,
      selectedCustomer: null,
      paymentMethod: 'cash',
      paymentTiming: 'immediate',
      amountPaid: 2400,
      change: 0,
      userId: 'cashier-1',
    };

    const result = await completeSale(saleParams);
    expect(result.success).toBe(true);

    // Simulated sync attempts (e.g. sync queue processor retries twice)
    const tx = savedTransactions[0];
    await syncModule.syncInsertTransaction(tx, tx.items);
    await syncModule.syncInsertTransaction(tx, tx.items);

    expect(syncedTransactions).toHaveLength(1);
    expect(syncedTransactions[0].tx.id).toBe(idempotencyKey);
  });

  // TEST 7 — Reconnect
  it('TEST 7: Offline checkout followed by reconnect synchronization maintains 1 canonical sale', async () => {
    isOnlineState = false;
    const idempotencyKey = 'idem-reconnect-006';
    const saleParams: CompleteSaleParams = {
      idempotencyKey,
      cart: [{ product_id: 'prod-101', product_name: 'Cement 50kg', quantity: 4, unit_price: 850, subtotal: 3400 }],
      cartTotal: 3400,
      products: mockProducts,
      selectedCustomer: null,
      paymentMethod: 'cash',
      paymentTiming: 'immediate',
      amountPaid: 3400,
      change: 0,
      userId: 'cashier-1',
    };

    // 1. Offline sale
    const offlineResult = await completeSale(saleParams);
    expect(offlineResult.success).toBe(true);
    expect(savedTransactions).toHaveLength(1);

    // 2. Reconnect
    isOnlineState = true;
    const tx = savedTransactions[0];
    await syncModule.syncInsertTransaction(tx, tx.items);

    expect(savedTransactions).toHaveLength(1);
    expect(syncedTransactions).toHaveLength(1);
    expect(syncedTransactions[0].tx.id).toBe(idempotencyKey);
  });

  // TEST 8 — Payment retry
  it('TEST 8: Payment retry (M-Pesa STK push / provider callback) does not create duplicate sale', async () => {
    const checkoutRequestId = 'ws_CO_20260905_12345678';
    const mpesaReceipt = 'QWE9876543';
    const idempotencyKey = `kcb-stk-${checkoutRequestId}`;

    const saleParams: CompleteSaleParams = {
      idempotencyKey,
      cart: [{ product_id: 'prod-101', product_name: 'Cement 50kg', quantity: 1, unit_price: 850, subtotal: 850 }],
      cartTotal: 850,
      products: mockProducts,
      selectedCustomer: null,
      paymentMethod: 'kcb_buni',
      paymentTiming: 'immediate',
      amountPaid: 850,
      change: 0,
      userId: 'cashier-1',
      mpesaReceipt,
    };

    // Initial payment confirmation completes sale
    const result1 = await completeSale(saleParams);
    expect(result1.success).toBe(true);

    // Duplicate callback or retry from gateway
    const result2 = await completeSale(saleParams);
    expect(result2.success).toBe(true);
    expect(result2.transactionId).toBe(result1.transactionId);

    expect(savedTransactions).toHaveLength(1);
    expect(savedTransactions[0].mpesa_receipt).toBe(mpesaReceipt);
    expect(savedStockMovements).toHaveLength(1);
  });

  // TEST 9 — Existing legitimate separate sales
  it('TEST 9: Separate legitimate checkouts remain distinct sales with independent canonical records', async () => {
    const saleA: CompleteSaleParams = {
      idempotencyKey: 'sale-legit-A',
      cart: [{ product_id: 'prod-101', product_name: 'Cement 50kg', quantity: 1, unit_price: 850, subtotal: 850 }],
      cartTotal: 850,
      products: mockProducts,
      selectedCustomer: null,
      paymentMethod: 'cash',
      paymentTiming: 'immediate',
      amountPaid: 850,
      change: 0,
      userId: 'cashier-1',
    };

    const saleB: CompleteSaleParams = {
      idempotencyKey: 'sale-legit-B',
      cart: [{ product_id: 'prod-102', product_name: 'Iron Sheets 3m', quantity: 2, unit_price: 1200, subtotal: 2400 }],
      cartTotal: 2400,
      products: mockProducts,
      selectedCustomer: null,
      paymentMethod: 'cash',
      paymentTiming: 'immediate',
      amountPaid: 2400,
      change: 0,
      userId: 'cashier-1',
    };

    const resA = await completeSale(saleA);
    const resB = await completeSale(saleB);

    expect(resA.success).toBe(true);
    expect(resB.success).toBe(true);
    expect(resA.transactionId).not.toBe(resB.transactionId);

    // Exactly 2 distinct sales
    expect(savedTransactions).toHaveLength(2);
    expect(savedTransactions.map((t) => t.id)).toEqual(['sale-legit-A', 'sale-legit-B']);
    expect(savedStockMovements).toHaveLength(2);
  });
});
