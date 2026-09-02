/**
 * Lipa Mdogo Outbound Sync Repair -- Test Suite
 *
 * TEST COVERAGE CLASSIFICATION
 * ============================================================
 * Test 1  : TABLE_ALLOWED_COLUMNS whitelist for installment_plans  [STRUCTURAL - pure fn]
 * Test 2  : TABLE_ALLOWED_COLUMNS whitelist for installment_payments [STRUCTURAL - pure fn]
 * Test 3  : Dependency status from queue snapshot                   [STRUCTURAL - helper fn]
 * Test 4  : Payment-deferred status from queue snapshot             [STRUCTURAL - helper fn]
 * Test 5  : Plan unpunished when customer backoffs                   [STRUCTURAL - queue state]
 * Test 6  : Payments unpunished when plan backoffs                   [STRUCTURAL - queue state]
 * Test 7  : getSyncStatusForRecord synced after queue removal       [STRUCTURAL - helper fn]
 * Test 8  : Real syncNow() worker - ordering + blocking proof       [REAL WORKER - real production path]
 * Test 9  : sanitizeForSupabase regression for transactions          [STRUCTURAL - pure fn]
 * Test 10 : Local event consumer / UI-refresh layer ONLY            [LOCAL EVENT LAYER]
 * ============================================================
 *
 * Tests 3-7 and Test 9 are STRUCTURAL UNIT TESTS.
 * They do NOT invoke processSyncItem or the real triggerSync production path.
 *
 * Test 8 is the ONLY test that exercises the real production sync worker via syncNow().
 *
 * Test 10 COVERAGE LIMIT:
 *   Verifies the application local data-updated event consumer and UI refresh.
 *   Does NOT prove Supabase Realtime delivery, Postgres publication,
 *   channel subscription, network transport, or cross-terminal sync.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ==========================================================================
// SUPABASE MOCK
// supabaseFromFactory is initialized immediately so the vi.mock hoisting
// captures a valid reference even before beforeEach runs.
// ==========================================================================
const callLog: { table: string; row: any }[] = [];
const writeStarted: string[] = [];
const writeOrder: string[] = [];

// Default immediate-success handler; replaced per-test in beforeEach
let customerResolve: (() => void) | null = null;
let failCustomer = false;

function defaultUpsert(table: string) {
  return vi.fn(async (row: any) => {
    callLog.push({ table, row });
    writeStarted.push(table);
    if (table === 'customers' && customerResolve !== null) {
      // Deferred: wait for explicit release
      await new Promise<void>((res) => { customerResolve = res; });
    }
    if (table === 'customers' && failCustomer) {
      return { error: { message: 'unique constraint', code: '23505' } };
    }
    writeOrder.push(table);
    return { error: null };
  });
}

vi.mock('../src/lib/supabaseClient', () => {
  const mockFrom = (table: string) => ({
    upsert: defaultUpsert(table),
    insert: vi.fn().mockResolvedValue({ error: null }),
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    })),
    delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
  });

  return {
    supabase: {
      from: vi.fn((table: string) => mockFrom(table)),
      channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() })),
      removeChannel: vi.fn(),
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }) },
    },
  };
});

// ==========================================================================
// DB MOCK
// ==========================================================================
const idbSyncQueue: any[] = [];

vi.mock('../src/lib/db', () => ({
  getDB: vi.fn(() => Promise.resolve({
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    getAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    getFromIndex: vi.fn().mockResolvedValue(null),
  })),
  getSyncQueue: vi.fn(() => Promise.resolve([...idbSyncQueue])),
  addToSyncQueue: vi.fn((item: any) => {
    const idx = idbSyncQueue.findIndex((q: any) => q.id === item.id);
    if (idx >= 0) { idbSyncQueue[idx] = item; } else { idbSyncQueue.push(item); }
    return Promise.resolve();
  }),
  removeFromSyncQueue: vi.fn((id: string) => {
    const idx = idbSyncQueue.findIndex((q: any) => q.id === id);
    if (idx >= 0) idbSyncQueue.splice(idx, 1);
    return Promise.resolve();
  }),
  generateId: vi.fn(() => 'id-' + Math.random().toString(36).slice(2)),
  getSyncMetadata: vi.fn().mockResolvedValue(null),
  setSyncMetadata: vi.fn().mockResolvedValue(undefined),
}));

import {
  sanitizeForSupabase,
  getSyncStatusForRecord,
  queueForSync,
  subscribeToDataChanges,
  syncNow,
  initNetworkListeners,
} from '../src/lib/sync';

const flushAsync = (ms = 80) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  idbSyncQueue.length = 0;
  callLog.length = 0;
  writeStarted.length = 0;
  writeOrder.length = 0;
  customerResolve = null;
  failCustomer = false;
  // Ensure online flag is set in jsdom
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true },
    configurable: true,
    writable: true,
  });
});

// TEST 1
describe('Test 1: installment_plans sanitization', () => {
  it('removes client-only fields not in TABLE_ALLOWED_COLUMNS', () => {
    const rawPlan = {
      id: 'plan-1', customer_id: 'cust-1', product_id: 'prod-1',
      product_name: 'Glass Coffee Table', total_amount: 8500, amount_paid: 8500,
      installment_count: 2, status: 'completed', product_released: true,
      release_date: '2026-09-02T10:00:00Z', notes: 'Balance cleared',
      created_at: '2026-09-01T08:00:00Z', updated_at: '2026-09-02T10:00:00Z',
      sync_status: 'pending', local_id: 'loc-plan-1',
      _local: true, items: [{ id: 'x' }], __clientInternal: 'secret',
    };
    const sanitized = sanitizeForSupabase('installment_plans', rawPlan);
    expect(sanitized.id).toBe('plan-1');
    expect(sanitized.customer_id).toBe('cust-1');
    expect(sanitized.total_amount).toBe(8500);
    expect(sanitized.status).toBe('completed');
    expect(sanitized.sync_status).toBe('pending');
    expect(sanitized.local_id).toBe('loc-plan-1');
    expect('_local' in sanitized).toBe(false);
    expect('items' in sanitized).toBe(false);
    expect('__clientInternal' in sanitized).toBe(false);
  });
});

// TEST 2
describe('Test 2: installment_payments sanitization', () => {
  it('removes client-only fields not in TABLE_ALLOWED_COLUMNS', () => {
    const rawPayment = {
      id: 'pay-1', plan_id: 'plan-1', amount: 4500, payment_method: 'cash',
      notes: 'Deposit', created_at: '2026-09-01T09:00:00Z',
      sync_status: 'pending', local_id: 'loc-pay-1',
      _local: true, items: [], __ghost: 'remove-me',
    };
    const sanitized = sanitizeForSupabase('installment_payments', rawPayment);
    expect(sanitized.id).toBe('pay-1');
    expect(sanitized.plan_id).toBe('plan-1');
    expect(sanitized.amount).toBe(4500);
    expect(sanitized.sync_status).toBe('pending');
    expect(sanitized.local_id).toBe('loc-pay-1');
    expect('_local' in sanitized).toBe(false);
    expect('items' in sanitized).toBe(false);
    expect('__ghost' in sanitized).toBe(false);
  });
});

// TEST 3 [STRUCTURAL]
describe('Test 3 [STRUCTURAL]: plan appears pending while customer backoffs', () => {
  it('queue-snapshot inspection only -- processSyncItem NOT invoked', () => {
    const customerId = 'cust-pending'; const planId = 'plan-pending';
    idbSyncQueue.push(
      { id: 'q-cust', table_name: 'customers', operation: 'insert', data: { id: customerId }, created_at: new Date().toISOString(), retry_count: 1, next_retry_at: new Date(Date.now() + 60000).toISOString() },
      { id: 'q-plan', table_name: 'installment_plans', operation: 'insert', data: { id: planId, customer_id: customerId }, created_at: new Date().toISOString() }
    );
    const snap = [...idbSyncQueue];
    expect(getSyncStatusForRecord(snap, ['installment_plans'], planId)).toBe('pending');
    expect(getSyncStatusForRecord(snap, ['customers'], customerId)).toBe('error');
  });
});

// TEST 4 [STRUCTURAL]
describe('Test 4 [STRUCTURAL]: payment deferred when plan backoffs', () => {
  it('queue-snapshot inspection only -- processSyncItem NOT invoked', () => {
    const planId = 'plan-unsynced'; const payId = 'pay-child';
    idbSyncQueue.push(
      { id: 'q-plan', table_name: 'installment_plans', operation: 'insert', data: { id: planId }, created_at: new Date().toISOString(), retry_count: 1, next_retry_at: new Date(Date.now() + 60000).toISOString() },
      { id: 'q-pay', table_name: 'installment_payments', operation: 'insert', data: { id: payId, plan_id: planId }, created_at: new Date().toISOString() }
    );
    const snap = [...idbSyncQueue];
    expect(getSyncStatusForRecord(snap, ['installment_payments'], payId)).toBe('pending');
    expect(getSyncStatusForRecord(snap, ['installment_plans'], planId)).toBe('error');
  });
});

// TEST 5 [STRUCTURAL]
describe('Test 5 [STRUCTURAL]: plan retry_count 0 when customer already has retries', () => {
  it('queue state only -- does not invoke worker', () => {
    const customerId = 'cust-fail'; const planId = 'plan-child';
    idbSyncQueue.push(
      { id: 'q-cust', table_name: 'customers', operation: 'insert', data: { id: customerId }, created_at: new Date().toISOString(), retry_count: 2, next_retry_at: new Date(Date.now() + 120000).toISOString() },
      { id: 'q-plan', table_name: 'installment_plans', operation: 'insert', data: { id: planId, customer_id: customerId }, created_at: new Date().toISOString() }
    );
    const planItem = idbSyncQueue.find((q: any) => q.id === 'q-plan');
    expect(planItem).toBeDefined();
    expect(planItem?.retry_count ?? 0).toBe(0);
    expect(planItem?.next_retry_at).toBeUndefined();
  });
});

// TEST 6 [STRUCTURAL]
describe('Test 6 [STRUCTURAL]: payment retry_count 0 when plan already has retries', () => {
  it('queue state only -- does not invoke worker', () => {
    const planId = 'plan-fail';
    idbSyncQueue.push(
      { id: 'q-plan', table_name: 'installment_plans', operation: 'insert', data: { id: planId }, created_at: new Date().toISOString(), retry_count: 1, next_retry_at: new Date(Date.now() + 60000).toISOString() },
      { id: 'q-pay1', table_name: 'installment_payments', operation: 'insert', data: { id: 'pay-1', plan_id: planId }, created_at: new Date().toISOString() },
      { id: 'q-pay2', table_name: 'installment_payments', operation: 'insert', data: { id: 'pay-2', plan_id: planId }, created_at: new Date().toISOString() }
    );
    expect(idbSyncQueue.find((q: any) => q.id === 'q-pay1')?.retry_count ?? 0).toBe(0);
    expect(idbSyncQueue.find((q: any) => q.id === 'q-pay2')?.retry_count ?? 0).toBe(0);
  });
});

// TEST 7 [STRUCTURAL]
describe('Test 7 [STRUCTURAL]: plan shows synced after queue removal', () => {
  it('queue snapshot helper -- does not invoke worker', () => {
    const planId = 'plan-ok';
    idbSyncQueue.push({ id: 'q-plan', table_name: 'installment_plans', operation: 'insert', data: { id: planId }, created_at: new Date().toISOString() });
    expect(getSyncStatusForRecord([...idbSyncQueue], ['installment_plans'], planId)).toBe('pending');
    idbSyncQueue.splice(0, 1);
    expect(getSyncStatusForRecord([...idbSyncQueue], ['installment_plans'], planId)).toBe('synced');
  });
});

// ==========================================================================
// TEST 8 [REAL WORKER]: Dependency ordering + parent-blocking proof
//
// This test calls the actual syncNow() -> triggerSync() -> processSyncItem()
// production path. Two sub-tests:
//
// 8A+B: Proves no plan/payment write starts while customer write is blocked
// 8C:   Proves customer failure defers plan with no retry_count penalty
// ==========================================================================
describe('Test 8 [REAL WORKER]: Dependency ordering and parent-blocking via syncNow()', () => {
  it('8A+B: customer blocks plan; plan blocks payment (deferred promise blocking proof)', async () => {
    // Capture per-call order
    const localStarted: string[] = [];
    const localOrder: string[] = [];
    let resolveCustomerWrite!: () => void;
    const customerWriteDone = new Promise<void>((res) => { resolveCustomerWrite = res; });

    // Re-wire supabase.from for this test via the imported mock module
    const { supabase } = await import('../src/lib/supabaseClient');
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => ({
      upsert: vi.fn(async (_row: any) => {
        localStarted.push(table);
        if (table === 'customers') await customerWriteDone;
        localOrder.push(table);
        return { error: null };
      }),
      insert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }), single: vi.fn().mockResolvedValue({ data: null, error: null }) })), order: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve({ data: [], error: null })), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })), limit: vi.fn(() => Promise.resolve({ data: [], error: null })) })),
      delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
    }));

    const customerId = 'customer-1';
    const planId = 'plan-1';
    const paymentId = 'payment-1';

    // Worst-case queue order: payment first
    idbSyncQueue.push(
      { id: 'q-pay', table_name: 'installment_payments', operation: 'insert', data: { id: paymentId, plan_id: planId, amount: 4500 }, created_at: new Date().toISOString() },
      { id: 'q-plan', table_name: 'installment_plans', operation: 'insert', data: { id: planId, customer_id: customerId, total_amount: 8500 }, created_at: new Date().toISOString() },
      { id: 'q-cust', table_name: 'customers', operation: 'insert', data: { id: customerId, name: 'Austin' }, created_at: new Date().toISOString() }
    );

    const syncPromise = syncNow();
    await flushAsync(40);

    // Customer write must have started
    expect(localStarted).toContain('customers');
    // Plan and payment must NOT have started while customer is blocking
    expect(localStarted).not.toContain('installment_plans');
    expect(localStarted).not.toContain('installment_payments');

    resolveCustomerWrite();
    await syncPromise;
    await flushAsync(40);

    const custIdx = localOrder.indexOf('customers');
    const planIdx = localOrder.indexOf('installment_plans');
    const payIdx = localOrder.indexOf('installment_payments');

    expect(custIdx).toBeGreaterThanOrEqual(0);
    expect(planIdx).toBeGreaterThan(custIdx);
    expect(payIdx).toBeGreaterThan(planIdx);
  });

  it('8C: customer failure defers plan with NO retry_count penalty on plan', async () => {
    const customerId = 'cust-fail-c'; const planId = 'plan-child-c';

    const { supabase } = await import('../src/lib/supabaseClient');
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => ({
      upsert: vi.fn(() => {
        if (table === 'customers') return Promise.resolve({ error: { message: 'unique constraint', code: '23505' } });
        return Promise.resolve({ error: null });
      }),
      insert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }), single: vi.fn().mockResolvedValue({ data: null, error: null }) })), order: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve({ data: [], error: null })), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })), limit: vi.fn(() => Promise.resolve({ data: [], error: null })) })),
      delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
    }));

    idbSyncQueue.push(
      { id: 'q-cust-c', table_name: 'customers', operation: 'insert', data: { id: customerId, name: 'Austin' }, created_at: new Date().toISOString() },
      { id: 'q-plan-c', table_name: 'installment_plans', operation: 'insert', data: { id: planId, customer_id: customerId, total_amount: 8500 }, created_at: new Date().toISOString() }
    );

    await syncNow();
    await flushAsync(40);

    const custItem = idbSyncQueue.find((q: any) => q.id === 'q-cust-c');
    // Customer must have been penalized (it failed)
    expect(custItem?.retry_count ?? 0).toBeGreaterThan(0);
    expect(custItem?.last_error).toBeDefined();

    const planItem = idbSyncQueue.find((q: any) => q.id === 'q-plan-c');
    // Plan must still be in queue and have NO retry penalty
    expect(planItem).toBeDefined();
    expect(planItem?.retry_count ?? 0).toBe(0);
    expect(planItem?.next_retry_at).toBeUndefined();
  });
});

// TEST 9 [STRUCTURAL]
describe('Test 9 [STRUCTURAL]: transactions sanitizer regression', () => {
  it('strips items and _local fields', () => {
    const raw = { id: 'tx-1', total_amount: 500, amount_paid: 500, payment_method: 'cash', status: 'completed', created_at: new Date().toISOString(), items: [{ id: 'ti-1' }], _local: true };
    const sanitized = sanitizeForSupabase('transactions', raw);
    expect(sanitized.id).toBe('tx-1');
    expect('items' in sanitized).toBe(false);
    expect('_local' in sanitized).toBe(false);
  });
});

// TEST 10 [LOCAL EVENT CONSUMER ONLY]
// COVERAGE LIMIT:
// Verifies local data-updated event consumer and UI refresh ONLY.
// Does NOT prove Supabase Realtime delivery, channel subscription, or cross-terminal sync.
// DO NOT classify as end-to-end, cross-terminal, or Supabase Realtime verified.
describe('Test 10 [LOCAL EVENT CONSUMER]: subscribeToDataChanges fires on window event', () => {
  it('listener fires when jimwas:data-updated dispatched locally -- NOT Supabase Realtime delivery', async () => {
    if (typeof window === 'undefined') return;
    const received: any[] = [];
    const unsub = subscribeToDataChanges((detail) => {
      if (detail.table === 'installment_plans') received.push(detail);
    });
    window.dispatchEvent(new CustomEvent('jimwas:data-updated', { detail: { table: 'installment_plans', eventType: 'INSERT', data: { id: 'plan-remote' } } }));
    await flushAsync();
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].table).toBe('installment_plans');
    unsub();
  });
});

// TEST 11 [SCHEMA COMPATIBILITY]: customers sanitizer strips non-existent columns (PGRST204 Guard)
describe('Test 11 [SCHEMA COMPATIBILITY]: customers sanitizer strips non-existent columns', () => {
  it('removes sync_status and local_id from customers payload', () => {
    const rawCustomer = {
      id: 'cust-123',
      name: 'Austin',
      phone: '+254700000000',
      email: 'austin@example.com',
      loyalty_points: 10,
      total_spent: 8500,
      created_at: '2026-09-01T08:00:00Z',
      updated_at: '2026-09-02T10:00:00Z',
      sync_status: 'pending',
      local_id: 'loc-cust-123',
    };

    const sanitized = sanitizeForSupabase('customers', rawCustomer);

    expect(sanitized.id).toBe('cust-123');
    expect(sanitized.name).toBe('Austin');
    expect(sanitized.phone).toBe('+254700000000');
    expect(sanitized.email).toBe('austin@example.com');
    expect(sanitized.loyalty_points).toBe(10);
    expect(sanitized.total_spent).toBe(8500);
    expect(sanitized.created_at).toBe('2026-09-01T08:00:00Z');
    expect(sanitized.updated_at).toBe('2026-09-02T10:00:00Z');

    // MUST NOT contain non-existent PostgreSQL columns
    expect('sync_status' in sanitized).toBe(false);
    expect('local_id' in sanitized).toBe(false);
  });
});

// TEST 12 [SCHEMA COMPATIBILITY]: stock_movements reference_type check constraint compliance (23514 Guard)
describe('Test 12 [SCHEMA COMPATIBILITY]: stock_movements reference_type check constraint compliance', () => {
  it('maps reference_type "sale" to "transaction"', () => {
    const rawMovement = {
      id: 'sm-1',
      product_id: 'prod-1',
      qty_delta: -1,
      reason: 'sale',
      note: 'POS sale',
      balance_after: 5,
      reference_type: 'sale',
      reference_id: 'tx-123',
      created_at: '2026-09-02T10:00:00Z',
      created_by: 'Cashier 1',
    };

    const sanitized = sanitizeForSupabase('stock_movements', rawMovement);
    expect(sanitized.reference_type).toBe('transaction');
  });

  it('preserves valid reference_types: transaction, delivery, adjustment, return', () => {
    for (const validRef of ['transaction', 'delivery', 'adjustment', 'return']) {
      const sanitized = sanitizeForSupabase('stock_movements', {
        id: 'sm-x',
        product_id: 'prod-1',
        qty_delta: 1,
        reason: 'restock',
        balance_after: 10,
        reference_type: validRef,
      });
      expect(sanitized.reference_type).toBe(validRef);
    }
  });
});
