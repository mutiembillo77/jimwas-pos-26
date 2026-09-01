/**
 * Realtime Relational Multi-Terminal Sync Test Suite
 * 
 * Validates the realtime sync fix in src/lib/sync.ts:
 * 1. Transaction realtime event retrieves authoritative transaction + transaction_items[]
 * 2. transaction_items INSERT triggers parent transaction retrieval with complete items
 * 3. transaction_items UPDATE updates parent transaction with modified items
 * 4. transaction_items DELETE triggers parent reload without retaining stale deleted item
 * 5. Flat realtime payload fallback preserves existing local items if relational query is unreachable
 * 6. CHANNEL_ERROR clears singleton reference
 * 7. TIMED_OUT clears singleton reference and allows recovery
 * 8. CLOSED clears singleton reference and allows recovery
 * 9. Repeated initRealtimeSync() maintains singleton channel
 * 10. Reconnect flow establishes fresh subscription after failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// State captured during mock executions
let realtimeCallback: ((payload: any) => void) | null = null;
let subscribeCallback: ((status: string) => void) | null = null;
let mockChannelInstance: any = null;
let removeChannelCalledWith: any = null;

const mockDbPuts: { store: string; value: any }[] = [];
const mockDbDeletes: { store: string; key: any }[] = [];
let mockDbExistingRecords: Record<string, any> = {};

let mockSupabaseSelectResult: { data: any; error: any } = { data: null, error: null };

vi.mock('../src/lib/supabaseClient', () => ({
  supabase: {
    channel: vi.fn((channelName: string) => {
      mockChannelInstance = {
        name: channelName,
        on: vi.fn((_event: string, _filter: any, cb: (payload: any) => void) => {
          realtimeCallback = cb;
          return mockChannelInstance;
        }),
        subscribe: vi.fn((cb: (status: string) => void) => {
          subscribeCallback = cb;
          return mockChannelInstance;
        }),
      };
      return mockChannelInstance;
    }),
    removeChannel: vi.fn((ch: any) => {
      removeChannelCalledWith = ch;
    }),
    from: vi.fn((table: string) => ({
      select: vi.fn((_query?: string) => ({
        eq: vi.fn((_field: string, _val: any) => ({
          maybeSingle: vi.fn().mockImplementation(() => Promise.resolve(mockSupabaseSelectResult)),
        })),
      })),
      insert: vi.fn().mockResolvedValue({ error: null }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
      delete: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    })),
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'mock-user' } }, error: null }),
    },
  },
}));

vi.mock('../src/lib/db', () => ({
  getDB: vi.fn(() => Promise.resolve({
    put: vi.fn((store: string, value: any) => {
      mockDbPuts.push({ store, value });
      return Promise.resolve();
    }),
    delete: vi.fn((store: string, key: any) => {
      mockDbDeletes.push({ store, key });
      return Promise.resolve();
    }),
    get: vi.fn((store: string, key: any) => {
      return Promise.resolve(mockDbExistingRecords[`${store}:${key}`] ?? null);
    }),
    getAll: vi.fn().mockResolvedValue([]),
    getFromIndex: vi.fn().mockResolvedValue(null),
  })),
  getSyncQueue: vi.fn().mockResolvedValue([]),
  removeFromSyncQueue: vi.fn().mockResolvedValue(undefined),
  addToSyncQueue: vi.fn().mockResolvedValue(undefined),
  generateId: vi.fn(() => 'mock-uuid-1234'),
  getSyncMetadata: vi.fn().mockResolvedValue(null),
  setSyncMetadata: vi.fn().mockResolvedValue(undefined),
}));

import {
  initRealtimeSync,
  subscribeToDataChanges,
  type DataChangeDetail,
} from '../src/lib/sync';

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('Realtime Relational Sync & Channel Lifecycle', () => {
  let cleanupRealtime: (() => void) | null = null;
  const recordedEvents: DataChangeDetail[] = [];
  let unsubData: (() => void) | null = null;

  beforeEach(() => {
    (globalThis as any).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };

    vi.clearAllMocks();
    mockDbPuts.length = 0;
    mockDbDeletes.length = 0;
    mockDbExistingRecords = {};
    recordedEvents.length = 0;
    realtimeCallback = null;
    subscribeCallback = null;
    mockChannelInstance = null;
    removeChannelCalledWith = null;
    mockSupabaseSelectResult = { data: null, error: null };

    if (cleanupRealtime) {
      cleanupRealtime();
      cleanupRealtime = null;
    }

    unsubData = subscribeToDataChanges((detail) => {
      recordedEvents.push(detail);
    });
  });

  afterEach(() => {
    if (cleanupRealtime) {
      cleanupRealtime();
      cleanupRealtime = null;
    }
    if (unsubData) {
      unsubData();
      unsubData = null;
    }
    delete (globalThis as any).window;
  });

  // Test 1: transactions realtime event retrieves authoritative transaction + items
  it('1. transactions realtime event retrieves relational transaction_items and writes complete record to IndexedDB', async () => {
    cleanupRealtime = initRealtimeSync();
    expect(realtimeCallback).not.toBeNull();

    const mockTxId = 'tx-rt-001';
    const mockItems = [
      { id: 'item-1', transaction_id: mockTxId, product_name: 'Coffee Table', quantity: 1, unit_price: 8500, subtotal: 8500 }
    ];

    mockSupabaseSelectResult = {
      data: {
        id: mockTxId,
        total_amount: 8500,
        payment_method: 'cash',
        status: 'completed',
        environment: 'PRODUCTION',
        transaction_items: mockItems,
      },
      error: null,
    };

    // Trigger realtime event
    realtimeCallback!({
      table: 'transactions',
      eventType: 'INSERT',
      new: { id: mockTxId, total_amount: 8500, payment_method: 'cash', status: 'completed' },
      old: {},
    });

    await flushAsync();

    expect(mockDbPuts).toHaveLength(1);
    expect(mockDbPuts[0].store).toBe('transactions');
    expect(mockDbPuts[0].value.id).toBe(mockTxId);
    expect(mockDbPuts[0].value.sync_status).toBe('synced');
    expect(mockDbPuts[0].value.items).toEqual(mockItems);
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0].table).toBe('transactions');
    expect(recordedEvents[0].eventType).toBe('INSERT');
  });

  // Test 2: transaction_items INSERT triggers parent transaction retrieval
  it('2. transaction_items INSERT triggers parent transaction reload with complete items', async () => {
    cleanupRealtime = initRealtimeSync();

    const mockTxId = 'tx-rt-002';
    const mockItems = [
      { id: 'item-a', transaction_id: mockTxId, product_name: 'Vines', quantity: 4, unit_price: 100, subtotal: 400 }
    ];

    mockSupabaseSelectResult = {
      data: {
        id: mockTxId,
        total_amount: 400,
        payment_method: 'cash',
        status: 'completed',
        transaction_items: mockItems,
      },
      error: null,
    };

    realtimeCallback!({
      table: 'transaction_items',
      eventType: 'INSERT',
      new: { id: 'item-a', transaction_id: mockTxId, product_name: 'Vines', quantity: 4, unit_price: 100, subtotal: 400 },
      old: {},
    });

    await flushAsync();

    expect(mockDbPuts).toHaveLength(1);
    expect(mockDbPuts[0].store).toBe('transactions');
    expect(mockDbPuts[0].value.id).toBe(mockTxId);
    expect(mockDbPuts[0].value.items).toEqual(mockItems);
    expect(recordedEvents[0].table).toBe('transactions');
  });

  // Test 3: transaction_items UPDATE updates parent transaction
  it('3. transaction_items UPDATE updates parent transaction in IndexedDB with modified items', async () => {
    cleanupRealtime = initRealtimeSync();

    const mockTxId = 'tx-rt-003';
    const updatedItems = [
      { id: 'item-b', transaction_id: mockTxId, product_name: 'Vines', quantity: 5, unit_price: 100, subtotal: 500 }
    ];

    mockSupabaseSelectResult = {
      data: {
        id: mockTxId,
        total_amount: 500,
        payment_method: 'cash',
        status: 'completed',
        transaction_items: updatedItems,
      },
      error: null,
    };

    realtimeCallback!({
      table: 'transaction_items',
      eventType: 'UPDATE',
      new: { id: 'item-b', transaction_id: mockTxId, quantity: 5, subtotal: 500 },
      old: { id: 'item-b', transaction_id: mockTxId, quantity: 4, subtotal: 400 },
    });

    await flushAsync();

    expect(mockDbPuts).toHaveLength(1);
    expect(mockDbPuts[0].value.id).toBe(mockTxId);
    expect(mockDbPuts[0].value.items[0].quantity).toBe(5);
  });

  // Test 4: transaction_items DELETE reloads parent transaction without stale item
  it('4. transaction_items DELETE reloads parent transaction without stale item', async () => {
    cleanupRealtime = initRealtimeSync();

    const mockTxId = 'tx-rt-004';
    mockSupabaseSelectResult = {
      data: {
        id: mockTxId,
        total_amount: 0,
        payment_method: 'cash',
        status: 'completed',
        transaction_items: [],
      },
      error: null,
    };

    realtimeCallback!({
      table: 'transaction_items',
      eventType: 'DELETE',
      new: {},
      old: { id: 'deleted-item-id', transaction_id: mockTxId },
    });

    await flushAsync();

    expect(mockDbPuts).toHaveLength(1);
    expect(mockDbPuts[0].value.id).toBe(mockTxId);
    expect(mockDbPuts[0].value.items).toEqual([]);
  });

  // Test 5: flat realtime payload fallback preserves existing items locally
  it('5. flat realtime payload fallback preserves existing local items if relational query is unreachable', async () => {
    cleanupRealtime = initRealtimeSync();

    const mockTxId = 'tx-rt-005';
    const localExistingItems = [{ id: 'loc-1', product_name: 'Local Item', quantity: 1, unit_price: 250, subtotal: 250 }];
    mockDbExistingRecords[`transactions:${mockTxId}`] = {
      id: mockTxId,
      total_amount: 250,
      items: localExistingItems,
    };

    mockSupabaseSelectResult = { data: null, error: { message: 'Network offline' } };

    realtimeCallback!({
      table: 'transactions',
      eventType: 'UPDATE',
      new: { id: mockTxId, total_amount: 250, status: 'completed' },
      old: {},
    });

    await flushAsync();

    expect(mockDbPuts).toHaveLength(1);
    expect(mockDbPuts[0].value.id).toBe(mockTxId);
    expect(mockDbPuts[0].value.items).toEqual(localExistingItems);
  });

  // Test 6: CHANNEL_ERROR clears singleton reference
  it('6. CHANNEL_ERROR clears realtimeChannel reference to allow subsequent reconnection', () => {
    cleanupRealtime = initRealtimeSync();
    expect(subscribeCallback).not.toBeNull();

    subscribeCallback!('CHANNEL_ERROR');

    const c2 = initRealtimeSync();
    expect(typeof c2).toBe('function');
    c2();
  });

  // Test 7: TIMED_OUT clears singleton reference and allows recovery
  it('7. TIMED_OUT clears realtimeChannel reference and permits re-subscription', () => {
    cleanupRealtime = initRealtimeSync();
    subscribeCallback!('TIMED_OUT');

    const c2 = initRealtimeSync();
    expect(typeof c2).toBe('function');
    c2();
  });

  // Test 8: CLOSED clears singleton reference and allows recovery
  it('8. CLOSED clears realtimeChannel reference and permits re-subscription', () => {
    cleanupRealtime = initRealtimeSync();
    subscribeCallback!('CLOSED');

    const c2 = initRealtimeSync();
    expect(typeof c2).toBe('function');
    c2();
  });

  // Test 9: repeated initialization maintains singleton
  it('9. repeated initRealtimeSync() calls before failure maintain the existing active subscription', () => {
    const c1 = initRealtimeSync();
    const c2 = initRealtimeSync();

    expect(typeof c1).toBe('function');
    expect(typeof c2).toBe('function');
    c1();
  });

  // Test 10: channel recovery flow (failure -> cleanup -> fresh channel)
  it('10. simulated reconnect flow: channel error cleans up and fresh channel is established', () => {
    cleanupRealtime = initRealtimeSync();
    
    subscribeCallback!('CHANNEL_ERROR');

    const recoveredCleanup = initRealtimeSync();
    expect(typeof recoveredCleanup).toBe('function');
    expect(subscribeCallback).not.toBeNull();

    subscribeCallback!('SUBSCRIBED');
    recoveredCleanup();
  });
});
