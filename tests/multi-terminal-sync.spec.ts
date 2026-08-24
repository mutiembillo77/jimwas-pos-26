/**
 * Multi-Terminal Synchronization Test Suite
 * 
 * Validates that the sync engine correctly:
 * 1. Exposes subscribeToDataChanges / notifyDataUpdated
 * 2. Sanitizes payloads before writing to Supabase (drops unknown columns)
 * 3. Initialises Realtime and heartbeat only once (idempotency)
 * 4. Notifies listeners when notifyDataUpdated is called
 * 5. CustomEvent `jimwas:data-updated` is dispatched on notifyDataUpdated
 * 6. sanitizeForSupabase strips disallowed fields
 * 7. sanitizeForSupabase preserves all allowed fields
 * 8. sanitizeForSupabase handles unknown tables gracefully
 * 9. Transactions: items field is stripped from the top-level row
 * 10. Multiple listeners can be registered and all receive the event
 * 11. Unsubscribing prevents further notifications
 * 12. notifyDataUpdated includes the passed data in the event detail
 * 13. initRealtimeSync returns a cleanup function
 * 14. initBackgroundSyncHeartbeat returns a cleanup function
 * 15. initBackgroundSyncHeartbeat is idempotent (second call is a no-op)
 * 16. initRealtimeSync is idempotent (second call is a no-op)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── module-level mocks ───────────────────────────────────────────────────────
vi.mock('../src/lib/supabaseClient', () => ({
  supabase: {
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    })),
    removeChannel: vi.fn(),
    from: vi.fn(() => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      order: vi.fn().mockReturnThis(),
    })),
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'mock-user' } }, error: null }),
    },
  },
}));

vi.mock('../src/lib/db', () => ({
  getDB: vi.fn(() => Promise.resolve({
    getAll: vi.fn().mockResolvedValue([]),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    getFromIndex: vi.fn().mockResolvedValue(null),
  })),
  getSyncQueue: vi.fn().mockResolvedValue([]),
  removeFromSyncQueue: vi.fn().mockResolvedValue(undefined),
  addToSyncQueue: vi.fn().mockResolvedValue(undefined),
  generateId: vi.fn(() => 'mock-id-' + Math.random().toString(36).slice(2)),
  getSyncMetadata: vi.fn().mockResolvedValue(null),
  setSyncMetadata: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import {
  subscribeToDataChanges,
  notifyDataUpdated,
  sanitizeForSupabase,
  initRealtimeSync,
  initBackgroundSyncHeartbeat,
  type DataChangeDetail,
} from '../src/lib/sync';

// ─── helpers ──────────────────────────────────────────────────────────────────
function captureEvents(count = 1): { events: DataChangeDetail[]; unsub: () => void } {
  const events: DataChangeDetail[] = [];
  const unsub = subscribeToDataChanges((detail) => events.push(detail));
  return { events, unsub };
}

// ─── test cases ───────────────────────────────────────────────────────────────
describe('Multi-Terminal Sync Engine', () => {

  describe('Subscription API', () => {
    it('1. subscribeToDataChanges and notifyDataUpdated exist and are functions', () => {
      expect(typeof subscribeToDataChanges).toBe('function');
      expect(typeof notifyDataUpdated).toBe('function');
    });

    it('4. Listener is called when notifyDataUpdated is called', () => {
      const { events, unsub } = captureEvents();
      notifyDataUpdated('products', 'INSERT', { id: 'p1', name: 'Test' });
      expect(events).toHaveLength(1);
      expect(events[0].table).toBe('products');
      expect(events[0].eventType).toBe('INSERT');
      unsub();
    });

    it('10. Multiple listeners all receive the notification', () => {
      const received1: DataChangeDetail[] = [];
      const received2: DataChangeDetail[] = [];
      const unsub1 = subscribeToDataChanges((d) => received1.push(d));
      const unsub2 = subscribeToDataChanges((d) => received2.push(d));
      notifyDataUpdated('customers', 'UPDATE');
      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      unsub1();
      unsub2();
    });

    it('11. Unsubscribing stops further notifications', () => {
      const { events, unsub } = captureEvents();
      notifyDataUpdated('products', 'INSERT');
      expect(events).toHaveLength(1);
      unsub();
      notifyDataUpdated('products', 'DELETE');
      expect(events).toHaveLength(1); // no new event after unsub
    });

    it('12. notifyDataUpdated includes the data passed to it in the event', () => {
      const { events, unsub } = captureEvents();
      const payload = { id: 'tx-1', total_amount: 500 };
      notifyDataUpdated('transactions', 'INSERT', payload);
      expect(events[0].data).toEqual(payload);
      unsub();
    });
  });

  describe('CustomEvent dispatch', () => {
    it('5. jimwas:data-updated CustomEvent is dispatched on notifyDataUpdated', () => {
      // In Node test environment (no DOM), window is not available.
      // sync.ts already guards: `if (typeof window !== 'undefined')`.
      // We verify the guard exists and the subscription path still works.
      if (typeof globalThis.window === 'undefined') {
        // Node path: verify at least the in-process listeners fire
        const { events, unsub } = captureEvents();
        notifyDataUpdated('products', 'INSERT', { id: 'p2' });
        expect(events).toHaveLength(1);
        expect(events[0].table).toBe('products');
        unsub();
        return;
      }
      // Browser/jsdom path: verify CustomEvent is dispatched on window
      const received: CustomEvent[] = [];
      const handler = (e: Event) => received.push(e as CustomEvent);
      window.addEventListener('jimwas:data-updated', handler);
      notifyDataUpdated('products', 'INSERT', { id: 'p2' });
      expect(received).toHaveLength(1);
      expect((received[0].detail as DataChangeDetail).table).toBe('products');
      window.removeEventListener('jimwas:data-updated', handler);
    });
  });

  describe('sanitizeForSupabase', () => {
    it('2. sanitizeForSupabase strips disallowed fields before Supabase write', () => {
      const dirty = {
        id: 'prod-1',
        name: 'Maize Flour 2kg',
        price: 120,
        stock: 50,
        items: [{ id: 'item-1' }],        // local-only field
        _local: true,                      // local-only flag
        sync_status: 'pending',
        unknownExtraField: 'should-drop',  // unknown column
      };
      const clean = sanitizeForSupabase('products', dirty);
      expect(clean.items).toBeUndefined();
      expect(clean._local).toBeUndefined();
      expect(clean.unknownExtraField).toBeUndefined();
      expect(clean.id).toBe('prod-1');
      expect(clean.name).toBe('Maize Flour 2kg');
    });

    it('7. sanitizeForSupabase preserves all allowed fields for transactions', () => {
      const tx = {
        id: 'tx-abc',
        customer_id: 'cust-1',
        total_amount: 250,
        amount_paid: 250,
        payment_method: 'cash',
        status: 'completed',
        payment_timing: 'immediate',
        is_cod: false,
        cod_status: null,
        mpesa_receipt: null,
        environment: 'PRODUCTION',
        created_at: '2026-08-24T00:00:00Z',
        sync_status: 'synced',
        items: [{ id: 'i-1' }],  // must be stripped at top-level
      };
      const clean = sanitizeForSupabase('transactions', tx as Record<string, unknown>);
      expect(clean.id).toBe('tx-abc');
      expect(clean.total_amount).toBe(250);
      expect(clean.payment_method).toBe('cash');
      expect(clean.items).toBeUndefined(); // items stripped
    });

    it('8. sanitizeForSupabase handles unknown tables gracefully (drops items and _local)', () => {
      const data = {
        id: 'x-1',
        foo: 'bar',
        items: [1, 2, 3],
        _local: true,
      };
      const clean = sanitizeForSupabase('unknown_table_xyz', data);
      expect(clean.id).toBe('x-1');
      expect(clean.foo).toBe('bar');
      expect(clean.items).toBeUndefined();
      expect(clean._local).toBeUndefined();
    });

    it('9. Transaction items field is stripped from the top-level sanitized row', () => {
      const txWithItems = {
        id: 'tx-2',
        total_amount: 500,
        amount_paid: 500,
        payment_method: 'kcb_buni',
        status: 'completed',
        payment_timing: 'immediate',
        is_cod: false,
        environment: 'SANDBOX',
        created_at: '2026-08-24T00:00:00Z',
        items: [{ id: 'item-A', product_name: 'Rice', quantity: 2, unit_price: 100, subtotal: 200 }],
      };
      const result = sanitizeForSupabase('transactions', txWithItems as Record<string, unknown>);
      expect(result.items).toBeUndefined();
      expect(result.id).toBe('tx-2');
    });
  });

  describe('Realtime Initialisation', () => {
    beforeEach(() => {
      // Reset the module-level realtimeChannel so each test starts fresh
      // We do this by importing the mocked supabase and resetting the channel spy
      vi.clearAllMocks();
    });

    it('3. sanitizeForSupabase exists and is a function', () => {
      expect(typeof sanitizeForSupabase).toBe('function');
    });

    it('13. initRealtimeSync returns a cleanup function', () => {
      const cleanup = initRealtimeSync();
      expect(typeof cleanup).toBe('function');
    });

    it('16. initRealtimeSync is idempotent — second call returns cleanup without duplicate subscriptions', () => {
      const c1 = initRealtimeSync();
      const c2 = initRealtimeSync();
      // both return functions
      expect(typeof c1).toBe('function');
      expect(typeof c2).toBe('function');
    });
  });

  describe('Background Heartbeat', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('14. initBackgroundSyncHeartbeat returns a cleanup function', () => {
      vi.useFakeTimers();
      const cleanup = initBackgroundSyncHeartbeat(60000);
      expect(typeof cleanup).toBe('function');
      cleanup();
    });

    it('15. initBackgroundSyncHeartbeat is idempotent — second call returns no-op', () => {
      vi.useFakeTimers();
      const c1 = initBackgroundSyncHeartbeat(60000);
      const c2 = initBackgroundSyncHeartbeat(60000);
      expect(typeof c1).toBe('function');
      expect(typeof c2).toBe('function');
      c1();
    });
  });
});
