import { SupabaseClient } from '@supabase/supabase-js';
import type { StoreNames } from 'idb';
import { supabase } from './supabaseClient';
import { getDB, getSyncQueue, removeFromSyncQueue, addToSyncQueue, generateId, getSyncMetadata, setSyncMetadata } from './db';

export function getSupabase(): SupabaseClient | null {
  return supabase;
}


let isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
let isSyncing = false;

export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'error' | 'offline' | 'degraded';

export interface SyncState {
  status: SyncStatus;
  pendingCount: number;
  failedCount: number;
  conflictCount: number;
  lastSync: string | null;
  lastPush: string | null;
  lastPull: string | null;
  deviceId: string | null;
  error: string | null;
}

const syncState: SyncState = {
  status: 'synced', pendingCount: 0, failedCount: 0, conflictCount: 0,
  lastSync: null, lastPush: null, lastPull: null, deviceId: null, error: null,
};

let deviceIdPromise: Promise<string> | null = null;
async function getDeviceId(): Promise<string> {
  if (!deviceIdPromise) deviceIdPromise = (async () => {
    const existing = await getSyncMetadata('device_id');
    if (existing) return existing;
    const created = globalThis.crypto?.randomUUID?.() ?? generateId();
    await setSyncMetadata('device_id', created);
    return created;
  })();
  const id = await deviceIdPromise;
  syncState.deviceId = id;
  return id;
}

function formatSyncError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [candidate.message, candidate.details, candidate.hint, candidate.code].filter((part): part is string => typeof part === 'string' && part.length > 0);
    if (parts.length > 0) return parts.join(' — ');
    try { return JSON.stringify(error); } catch { return 'Unknown sync error'; }
  }
  return 'Unknown sync error';
}

const syncListeners: Set<(state: SyncState) => void> = new Set();

export function subscribeToSyncState(listener: (state: SyncState) => void): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

function notifySyncState() {
  syncListeners.forEach(listener => listener({ ...syncState }));
}

export function getSyncState(): SyncState {
  return { ...syncState };
}

export type DataChangeDetail = { table: string; eventType: string; data?: unknown };
export type DataChangeListener = (detail: DataChangeDetail) => void;
const dataChangeListeners = new Set<DataChangeListener>();

export function subscribeToDataChanges(listener: DataChangeListener): () => void {
  dataChangeListeners.add(listener);
  return () => dataChangeListeners.delete(listener);
}

export function notifyDataUpdated(table: string, eventType: string = 'sync', data?: unknown) {
  const detail: DataChangeDetail = { table, eventType, data };
  dataChangeListeners.forEach(listener => {
    try { listener(detail); } catch (e) { console.warn('[Sync] Data listener error:', e); }
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('jimwas:data-updated', { detail }));
  }
}

export interface SyncQueueItem {
  id: string;
  table_name: string;
  operation: string;
  data: Record<string, unknown>;
  created_at: string;
  device_id?: string;
  retry_count?: number;
  next_retry_at?: string;
  last_error?: string;
}

export async function getSyncQueueItems(): Promise<SyncQueueItem[]> {
  return (await getSyncQueue()) as SyncQueueItem[];
}

export async function retrySyncItem(id: string): Promise<{ success: boolean; message: string }> {
  const item = (await getSyncQueueItems()).find((entry) => entry.id === id);
  if (!item) return { success: false, message: 'Queue item not found' };
  try {
    await processSyncItem(item);
    await removeFromSyncQueue(item.id);
    await checkPendingCount();
    syncState.error = null;
    syncState.status = syncState.pendingCount === 0 ? 'synced' : 'pending';
    notifySyncState();
    return { success: true, message: 'Item synced successfully' };
  } catch (error) {
    await addToSyncQueue({ ...item, operation: item.operation as 'insert' | 'update' | 'delete', retry_count: (item.retry_count ?? 0) + 1, next_retry_at: undefined, last_error: formatSyncError(error) } as any);
    syncState.failedCount = (await getSyncQueueItems()).filter((entry) => (entry.retry_count ?? 0) > 0).length;
    syncState.status = 'degraded';
    syncState.error = error instanceof Error ? `${item.table_name}: ${error.message}` : `Failed to sync ${item.table_name}`;
    notifySyncState();
    return { success: false, message: syncState.error };
  }
}

export async function retryAllSyncItems(): Promise<{ success: number; failed: number }> {
  const items = await getSyncQueueItems();
  let success = 0;
  let failed = 0;
  for (const item of items) {
    const result = await retrySyncItem(item.id);
    if (result.success) { success++; } else { failed++; }
  }
  await checkPendingCount();
  return { success, failed };
}

export function initNetworkListeners() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => {
    isOnline = true;
    syncState.status = 'synced';
    notifySyncState();
    initRealtimeSync();
    triggerSync();
  });

  window.addEventListener('offline', () => {
    isOnline = false;
    syncState.status = 'offline';
    notifySyncState();
  });

  void getDeviceId().then(() => {
    notifySyncState();
  });
  checkPendingCount();
  initRealtimeSync();
  initBackgroundSyncHeartbeat(15000);
}

async function checkPendingCount() {
  try {
    const queue = await getSyncQueue();
    syncState.pendingCount = queue.length;
    syncState.failedCount = queue.filter((item) => (item.retry_count ?? 0) > 0).length;
    if (queue.length === 0 && isOnline && getSupabase()) {
      syncState.status = 'synced';
      syncState.error = null;
    }
    notifySyncState();
  } catch (error) {
    console.error('Failed to check pending count:', error);
  }
}

export function getOnlineStatus(): boolean {
  return isOnline;
}

async function triggerSync() {
  if (!isOnline || isSyncing) return;
  if (!getSupabase()) {
    syncState.status = isOnline ? 'error' : 'offline';
    syncState.error = isOnline ? 'Supabase configuration is unavailable. Local operations remain enabled.' : 'Browser is offline. Local operations remain enabled.';
    notifySyncState();
    return;
  }

  isSyncing = true;
  syncState.status = 'syncing';
  syncState.error = null;
  notifySyncState();

  try {
    const queue = await getSyncQueue();

    let successCount = 0;
    let failCount = 0;

    const now = Date.now();
    for (const item of queue) {
      if (item.next_retry_at && new Date(item.next_retry_at).getTime() > now) continue;
      try {
        await processSyncItem(item);
        await removeFromSyncQueue(item.id);
        successCount++;
      } catch (error) {
        console.error('Sync failed for item:', item.id, item.table_name, item.operation, error);
        const retryCount = (item.retry_count ?? 0) + 1;
        const retryDelay = Math.min(60 * 60 * 1000, 1000 * 2 ** Math.min(retryCount, 10));
        await addToSyncQueue({ ...item, retry_count: retryCount, next_retry_at: new Date(Date.now() + retryDelay).toISOString(), last_error: formatSyncError(error) });
        failCount++;
      }
    }

    try {
      await syncFromRemote();
    } catch (remoteError) {
      console.error('Remote sync failed:', remoteError);
      syncState.error = remoteError instanceof Error ? remoteError.message : 'Remote sync failed';
    }

    syncState.status = failCount > 0 || syncState.error ? 'degraded' : 'synced';
    syncState.lastSync = failCount > 0 || syncState.error ? syncState.lastSync : new Date().toISOString();
    syncState.lastPush = new Date().toISOString();
    const remainingQueue = await getSyncQueueItems();
    syncState.pendingCount = remainingQueue.length;
    syncState.failedCount = remainingQueue.filter((item) => (item.retry_count ?? 0) > 0).length;

    if (failCount > 0 && !syncState.error) {
      syncState.error = `${failCount} items failed to sync`;
    }
  } catch (error) {
    console.error('Sync error:', error);
    syncState.status = 'error';
    syncState.error = error instanceof Error ? error.message : 'Sync failed';
  } finally {
    isSyncing = false;
    notifySyncState();
  }
}

const TABLE_ALLOWED_COLUMNS: Record<string, string[]> = {
  transactions: [
    'id', 'customer_id', 'total_amount', 'amount_paid', 'change_amount',
    'payment_method', 'status', 'notes', 'created_at', 'sync_status',
    'local_id', 'cashier_id', 'cashier_name', 'branch_id', 'payment_timing',
    'is_cod', 'cod_status', 'mpesa_receipt', 'environment'
  ],
  transaction_items: [
    'id', 'transaction_id', 'product_id', 'product_name', 'quantity',
    'unit_price', 'subtotal', 'created_at'
  ],
  products: [
    'id', 'name', 'sku', 'price', 'cost', 'stock', 'category',
    'image_url', 'is_active', 'low_stock_alert', 'barcode',
    'created_at', 'updated_at', 'sync_status', 'local_id'
  ],
  customers: [
    'id', 'name', 'phone', 'email', 'loyalty_points', 'total_spent',
    'created_at', 'updated_at', 'sync_status', 'local_id'
  ],
  stock_movements: [
    'id', 'product_id', 'qty_delta', 'reason', 'note', 'balance_after',
    'reference_type', 'reference_id', 'branch_id', 'created_at',
    'created_by', 'sync_status', 'local_id'
  ],
  audit_logs: [
    'id', 'event_type', 'user_id', 'user_name', 'user_role', 'entity_type',
    'entity_id', 'old_value', 'new_value', 'reason', 'branch_id',
    'branch_name', 'device_info', 'ip_address', 'created_at', 'sync_status'
  ],
  kcb_payments: [
    'id', 'checkout_request_id', 'merchant_request_id', 'phone_number',
    'amount', 'status', 'result_code', 'result_desc', 'mpesa_receipt_number',
    'transaction_date', 'transaction_id', 'customer_id', 'cashier_id',
    'cashier_name', 'callback_received', 'callback_payload', 'raw_request',
    'raw_response', 'error_message', 'attempts', 'idempotency_key',
    'last_attempt_at', 'completed_at', 'created_at', 'updated_at'
  ],
  payment: [
    'id', 'provider', 'provider_transaction_id', 'merchant_request_id',
    'checkout_request_id', 'phone_number', 'amount', 'invoice_number',
    'status', 'transaction_type', 'callback_payload', 'environment'
  ],
  business_settings: [
    'id', 'business_name', 'business_phone', 'business_email',
    'business_address', 'tax_id', 'currency', 'currency_symbol',
    'receipt_header', 'receipt_footer', 'show_tax_on_receipt', 'logo_url',
    'created_at', 'updated_at', 'sync_status'
  ],
  kcb_settings: [
    'id', 'is_enabled', 'environment', 'client_id', 'client_secret',
    'org_shortcode', 'org_passkey', 'callback_url', 'timeout_url',
    'public_cert_path', 'default_phone_country_code', 'business_paybill',
    'business_account', 'business_name', 'last_updated', 'last_updated_by',
    'created_at', 'updated_at', 'sync_status'
  ],
  payment_accounts: [
    'id', 'name', 'account_type', 'paybill_number', 'account_number',
    'bank_name', 'branch_name', 'code', 'created_at', 'updated_at'
  ],
};

export function sanitizeForSupabase(table: string, data: Record<string, unknown>): Record<string, unknown> {
  const allowed = TABLE_ALLOWED_COLUMNS[table];
  if (!allowed) {
    const copy = { ...data };
    delete copy.items;
    delete copy._local;
    return copy;
  }
  const clean: Record<string, unknown> = {};
  for (const col of allowed) {
    if (col in data && data[col] !== undefined) {
      clean[col] = data[col];
    }
  }
  return clean;
}

async function processSyncItem(item: { table_name: string; operation: string; data: Record<string, unknown> }) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase is not configured. Sync is unavailable while offline.');
  const { table_name, operation, data } = item;
  const table = client.from(table_name);

  let error;
  switch (operation) {
    case 'insert': {
      if (table_name === 'transactions') {
        const rawItems = Array.isArray(data.items) ? data.items : [];
        const sanitizedTx = sanitizeForSupabase('transactions', data);
        const result = await table.upsert(sanitizedTx, { onConflict: 'id', ignoreDuplicates: false });
        error = result.error;
        if (!error && rawItems.length > 0) {
          const sanitizedItems = rawItems.map((it: Record<string, unknown>) => ({
            ...sanitizeForSupabase('transaction_items', it),
            transaction_id: sanitizedTx.id || data.id,
          }));
          const itemsResult = await client.from('transaction_items').upsert(sanitizedItems, { onConflict: 'id', ignoreDuplicates: false });
          if (itemsResult.error) console.warn('[Sync] Failed to sync transaction items:', itemsResult.error);
        }
      } else {
        const sanitized = sanitizeForSupabase(table_name, data);
        const result = await table.upsert(sanitized, { onConflict: 'id', ignoreDuplicates: false });
        error = result.error;
      }
      break;
    }
    case 'update': {
      if (table_name === 'transactions') {
        const sanitizedTx = sanitizeForSupabase('transactions', data);
        const result = await table.upsert(sanitizedTx, { onConflict: 'id', ignoreDuplicates: false });
        error = result.error;
      } else {
        const sanitized = sanitizeForSupabase(table_name, data);
        const result = await table.upsert(sanitized, { onConflict: 'id', ignoreDuplicates: false });
        error = result.error;
      }
      break;
    }
    case 'delete': {
      const result = await table.delete().eq('id', data.id);
      error = result.error;
      break;
    }
  }
  if (error) {
    console.error(`Sync error for ${operation} on ${table_name}:`, error);
    throw error;
  }
}

// Generic table sync config
interface TableSyncConfig {
  table: string;
  // Must be a valid IDB store name so db.put/getFromIndex receive the correct literal type.
  store: StoreNames<import('./db').POSDatabase>;
  uniqueIndex?: string;
  uniqueField?: string;
  relation?: { table: string; field: string };
  single?: boolean;
  limit?: number;
  orderBy?: string;
}

const TABLE_CONFIGS: TableSyncConfig[] = [
  { table: 'customers', store: 'customers', uniqueIndex: 'by-phone', uniqueField: 'phone' },
  { table: 'products', store: 'products', uniqueIndex: 'by-sku', uniqueField: 'sku' },
  { table: 'transactions', store: 'transactions', relation: { table: 'transaction_items', field: 'transaction_items' } },
  { table: 'installment_plans', store: 'installment_plans' },
  { table: 'installment_payments', store: 'installment_payments' },
  { table: 'loyalty_transactions', store: 'loyalty_transactions' },
  { table: 'stock_movements', store: 'stock_movements' },
  { table: 'suppliers', store: 'suppliers' },
  { table: 'deliveries', store: 'deliveries' },
  { table: 'users', store: 'users' },
  { table: 'roles', store: 'roles', uniqueIndex: 'by-code', uniqueField: 'code' },
  { table: 'audit_logs', store: 'audit_logs', orderBy: 'created_at', limit: 500 },
  { table: 'approval_requests', store: 'approval_requests' },
  { table: 'business_settings', store: 'business_settings', single: true },
  { table: 'kcb_settings', store: 'kcb_settings', single: true },
  { table: 'kcb_payments', store: 'kcb_payments', orderBy: 'created_at', limit: 500 },
  { table: 'payment_methods', store: 'payment_methods' },
  { table: 'payment_accounts', store: 'payment_accounts', uniqueIndex: 'by-code', uniqueField: 'code' },
  { table: 'loyalty_settings', store: 'loyalty_settings', single: true },
  { table: 'receipt_settings', store: 'receipt_settings', single: true },
  { table: 'ledger_entries', store: 'ledger_entries', orderBy: 'date', limit: 1000 },
  { table: 'expense_categories', store: 'expense_categories' },
  { table: 'shifts', store: 'shifts', orderBy: 'opened_at', limit: 500 },
  { table: 'reconciliations', store: 'reconciliations', orderBy: 'created_at', limit: 1000 },
  { table: 'outbound_deliveries', store: 'outbound_deliveries', orderBy: 'updated_at', limit: 1000 },
  { table: 'offers', store: 'offers' },
  { table: 'supplier_fulfillments', store: 'supplier_fulfillments', orderBy: 'created_at', limit: 1000 },
  { table: 'report_schedules', store: 'report_schedules', orderBy: 'next_run_at', limit: 500 },
  { table: 'safe_drops', store: 'safe_drops', orderBy: 'created_at', limit: 500 },
];

async function syncTableFromRemote(client: SupabaseClient, db: Awaited<ReturnType<typeof getDB>>, config: TableSyncConfig) {
  let query = client.from(config.table).select(
    config.relation ? `*, ${config.relation.table}(*)` : '*'
  );

  if (config.orderBy) {
    query = query.order(config.orderBy, { ascending: false });
  }
  if (config.limit) {
    query = query.limit(config.limit);
  }

  const { data } = await query;
  if (!data) return;

  // Supabase returns `any[]` at runtime; the generic type can include a ParserError
  // union for complex select expressions. Double-cast via unknown to bypass it safely.
  const rows = (data as unknown) as Record<string, unknown>[];

  if (config.single) {
    if (rows.length > 0) {
      await db.put(config.store, { ...rows[0], sync_status: 'synced' } as never);
    }
    return;
  }

  const seenUniqueValues = new Set<unknown>();
  for (const row of rows) {
    if (config.uniqueIndex && config.uniqueField) {
      const fieldValue = row[config.uniqueField];
      if (fieldValue && seenUniqueValues.has(fieldValue)) continue;
      if (fieldValue) seenUniqueValues.add(fieldValue);
      if (fieldValue) {
        const existing = await db.getFromIndex(config.store, config.uniqueIndex as never, fieldValue as never);
        if (existing && (existing as Record<string, unknown>).id !== row.id) {
          const pending = await getSyncQueue();
          const hasPendingWrite = pending.some(item => item.table_name === config.table && item.data.id === (existing as Record<string, unknown>).id);
          if (hasPendingWrite) continue;
          // Reuse the existing local key to avoid unique-index collisions.
          row.id = (existing as Record<string, unknown>).id;
        }
      }
    }

    const record = config.relation
      ? { ...row, sync_status: 'synced', items: (row[config.relation.field] as unknown[]) || [] }
      : { ...row, sync_status: 'synced' };

    await db.put(config.store, record as never);
  }
}

let realtimeChannel: ReturnType<NonNullable<ReturnType<typeof getSupabase>>['channel']> | null = null;
let backgroundHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function handleRealtimeChange(payload: { table: string; eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }) {
  try {
    const { table, eventType } = payload;

    // Handle transaction_items changes by updating the parent transaction in IndexedDB
    if (table === 'transaction_items') {
      const txId = (payload.new?.transaction_id || payload.old?.transaction_id) as string | undefined;
      if (txId) {
        const client = getSupabase();
        if (client) {
          const { data, error } = await client
            .from('transactions')
            .select('*, transaction_items(*)')
            .eq('id', txId)
            .maybeSingle();
          if (!error && data) {
            const db = await getDB();
            const row = (data as unknown) as Record<string, unknown>;
            const fullRecord = {
              ...row,
              sync_status: 'synced',
              items: (row['transaction_items'] as unknown[]) || [],
            };
            await db.put('transactions', fullRecord as never);
            notifyDataUpdated('transactions', eventType, fullRecord);
            return;
          }
        }
      }
    }

    const config = TABLE_CONFIGS.find(c => c.table === table);
    if (!config) return;

    const db = await getDB();
    if (eventType === 'DELETE') {
      const id = payload.old?.id;
      if (id) {
        await db.delete(config.store, id as never);
        notifyDataUpdated(table, 'DELETE', payload.old);
      }
    } else if (eventType === 'INSERT' || eventType === 'UPDATE') {
      const record = payload.new;
      if (record && record.id) {
        if (config.relation) {
          const client = getSupabase();
          if (client) {
            const { data, error } = await client
              .from(table)
              .select(`*, ${config.relation.table}(*)`)
              .eq('id', record.id)
              .maybeSingle();
            if (!error && data) {
              const row = (data as unknown) as Record<string, unknown>;
              const fullRecord = {
                ...row,
                sync_status: 'synced',
                items: (row[config.relation.field] as unknown[]) || [],
              };
              await db.put(config.store, fullRecord as never);
              notifyDataUpdated(table, eventType, fullRecord);
              return;
            }
          }
          // Preserve existing local items if relational query could not be completed
          const existing = await db.get(config.store, record.id as never);
          const existingItems = (existing as Record<string, unknown> | undefined)?.items;
          const fallbackRecord = {
            ...record,
            sync_status: 'synced',
            ...(existingItems ? { items: existingItems } : {}),
          };
          await db.put(config.store, fallbackRecord as never);
          notifyDataUpdated(table, eventType, fallbackRecord);
          return;
        }
        await db.put(config.store, { ...record, sync_status: 'synced' } as never);
        notifyDataUpdated(table, eventType, record);
      }
    }
  } catch (err) {
    console.warn('[Sync] Error processing realtime change:', err);
  }
}

export function initRealtimeSync(): () => void {
  const client = getSupabase();
  if (!client || typeof window === 'undefined') return () => {};
  if (realtimeChannel) return () => {};

  try {
    realtimeChannel = client
      .channel('jimwas-multi-terminal-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public' },
        (payload) => {
          void handleRealtimeChange(payload as unknown as { table: string; eventType: string; new: Record<string, unknown>; old: Record<string, unknown> });
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[Sync] Realtime channel connected for multi-terminal sync');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn(`[Sync] Realtime channel status: ${status}, resetting channel reference`);
          if (realtimeChannel && client) {
            try { void client.removeChannel(realtimeChannel); } catch {}
          }
          realtimeChannel = null;
        }
      });
  } catch (err) {
    console.warn('[Sync] Realtime subscription init failed:', err);
    realtimeChannel = null;
  }

  return () => {
    if (realtimeChannel && client) {
      void client.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
  };
}

export function initBackgroundSyncHeartbeat(intervalMs = 15000): () => void {
  if (typeof window === 'undefined') return () => {};
  if (backgroundHeartbeatTimer) return () => {};

  backgroundHeartbeatTimer = setInterval(() => {
    if (isOnline && !isSyncing && getSupabase()) {
      void syncFromRemote().then(() => {
        notifyDataUpdated('*', 'heartbeat-pull');
      }).catch(err => {
        console.warn('[Sync] Background heartbeat pull warning:', err);
      });
    }
  }, intervalMs);

  return () => {
    if (backgroundHeartbeatTimer) {
      clearInterval(backgroundHeartbeatTimer);
      backgroundHeartbeatTimer = null;
    }
  };
}

async function syncFromRemote() {
  const client = getSupabase();
  if (!client) return;
  const db = await getDB();

  for (const config of TABLE_CONFIGS) {
    try {
      await syncTableFromRemote(client, db, config);
    } catch (error) {
      console.error(`Failed to sync ${config.table}:`, error);
    }
  }
  syncState.lastPull = new Date().toISOString();
  notifyDataUpdated('*', 'remote-pull');
}

export async function syncNow(): Promise<{ success: boolean; message: string }> {
  if (!getSupabase()) {
    return { success: false, message: 'Sync is not configured. Running in offline mode.' };
  }
  if (!isOnline) {
    return { success: false, message: 'You are offline. Changes will sync when online.' };
  }

  try {
    await triggerSync();
    if (syncState.status === 'degraded' || syncState.status === 'error') return { success: false, message: syncState.error ?? 'Some items failed to sync.' };
    return { success: true, message: 'Sync completed successfully' };
  } catch (error) {
    console.error('Sync error:', error);
    return { success: false, message: 'Sync failed. Will retry automatically.' };
  }
}

export function queueForSync(tableName: string, operation: 'insert' | 'update' | 'delete', data: unknown) {
  const record = data as Record<string, unknown>;
  void (async () => {
    const queue = await getSyncQueue();
    const existing = queue.find(item => item.table_name === tableName && item.operation !== 'delete' && item.data.id === record.id);
    if (existing) {
      await addToSyncQueue({ ...existing, operation, data: record, retry_count: 0, next_retry_at: undefined, last_error: undefined });
    } else {
      await addToSyncQueue({ id: generateId(), table_name: tableName, operation, data: record, created_at: new Date().toISOString(), device_id: await getDeviceId() });
    }
    syncState.pendingCount = (await getSyncQueue()).length;
    syncState.status = 'pending';
    notifySyncState();
    if (isOnline) void triggerSync();
  })();
}

// Generic sync helpers
async function syncInsert(table: string, data: unknown): Promise<void> {
  const sanitized = sanitizeForSupabase(table, data as Record<string, unknown>);
  if (!isOnline || !getSupabase()) {
    queueForSync(table, 'insert', data);
    return;
  }
  try {
    const { error } = await getSupabase()!.from(table).insert(sanitized);
    if (error) throw error;
  } catch {
    queueForSync(table, 'insert', data);
  }
}

async function syncUpdate(table: string, data: unknown): Promise<void> {
  const sanitized = sanitizeForSupabase(table, data as Record<string, unknown>);
  if (!isOnline || !getSupabase()) {
    queueForSync(table, 'update', data);
    return;
  }
  try {
    const { error } = await getSupabase()!.from(table).upsert(sanitized, { onConflict: 'id' });
    if (error) throw error;
  } catch {
    queueForSync(table, 'update', data);
  }
}

// Entity-specific sync functions (thin wrappers for backward compatibility)
export const syncInsertCustomer = (customer: unknown) => syncInsert('customers', customer);
export const syncUpdateCustomer = (customer: unknown) => syncUpdate('customers', customer);

export async function syncInsertTransaction(transaction: unknown, items: unknown[]) {
  const rawTx = transaction as Record<string, unknown>;
  const sanitizedTx = sanitizeForSupabase('transactions', rawTx);
  const rawItems = Array.isArray(items) ? items : (Array.isArray(rawTx.items) ? rawTx.items : []);
  const sanitizedItems = rawItems.map((it: Record<string, unknown>) => ({
    ...sanitizeForSupabase('transaction_items', it),
    transaction_id: sanitizedTx.id || rawTx.id,
  }));

  if (!isOnline || !getSupabase()) {
    queueForSync('transactions', 'insert', rawTx);
    rawItems.forEach(item => queueForSync('transaction_items', 'insert', item));
    return;
  }
  try {
    const { error: txError } = await getSupabase()!.from('transactions').insert(sanitizedTx);
    if (txError) throw txError;
    if (sanitizedItems.length > 0) {
      const { error: itemsError } = await getSupabase()!.from('transaction_items').insert(sanitizedItems);
      if (itemsError) throw itemsError;
    }
  } catch {
    queueForSync('transactions', 'insert', rawTx);
    rawItems.forEach(item => queueForSync('transaction_items', 'insert', item));
  }
}

export const syncInsertInstallmentPlan = (plan: unknown) => syncInsert('installment_plans', plan);
export const syncUpdateInstallmentPlan = (plan: unknown) => syncUpdate('installment_plans', plan);
export const syncInsertInstallmentPayment = (payment: unknown) => syncInsert('installment_payments', payment);
export const syncInsertLoyaltyTransaction = (loyaltyTx: unknown) => syncInsert('loyalty_transactions', loyaltyTx);
export const syncInsertProduct = (product: unknown) => syncInsert('products', product);
export const syncUpdateProduct = (product: unknown) => syncUpdate('products', product);
export async function syncDeleteProduct(id: string): Promise<void> {
  const client = getSupabase();
  if (!client || !isOnline) return;
  try {
    await client.from('products').delete().eq('id', id);
  } catch {
    // Best-effort — local delete already done
  }
}
export const syncInsertStockMovement = (movement: unknown) => syncInsert('stock_movements', movement);
export const syncInsertUser = (user: unknown) => syncInsert('users', user);
export const syncUpdateUser = (user: unknown) => syncUpdate('users', user);
export const syncInsertAuditLog = (log: unknown) => syncInsert('audit_logs', log);
export const syncInsertApprovalRequest = (request: unknown) => syncInsert('approval_requests', request);
export const syncUpdateApprovalRequest = (request: unknown) => syncUpdate('approval_requests', request);
export const syncInsertDelivery = (delivery: unknown) => syncInsert('deliveries', delivery);
export const syncUpdateDelivery = (delivery: unknown) => syncUpdate('deliveries', delivery);
export const syncInsertDeliveryItem = (item: unknown) => syncInsert('delivery_items', item);
export const syncInsertLedgerEntry = (entry: unknown) => syncInsert('ledger_entries', entry);
export const syncUpdateLedgerEntry = (entry: unknown) => syncUpdate('ledger_entries', entry);
export const syncInsertShift = (shift: unknown) => syncInsert('shifts', shift);
export const syncUpdateShift = (shift: unknown) => syncUpdate('shifts', shift);
export const syncInsertReconciliation = (record: unknown) => syncInsert('reconciliations', record);
export const syncUpdateReconciliation = (record: unknown) => syncUpdate('reconciliations', record);
export const syncInsertOutboundDelivery = (delivery: unknown) => syncInsert('outbound_deliveries', delivery);
export const syncUpdateOutboundDelivery = (delivery: unknown) => syncUpdate('outbound_deliveries', delivery);
export const syncInsertOffer = (offer: unknown) => syncInsert('offers', offer);
export const syncUpdateOffer = (offer: unknown) => syncUpdate('offers', offer);
export const syncInsertSupplierFulfillment = (record: unknown) => syncInsert('supplier_fulfillments', record);
export const syncUpdateSupplierFulfillment = (record: unknown) => syncUpdate('supplier_fulfillments', record);
export const syncInsertReportSchedule = (record: unknown) => syncInsert('report_schedules', record);
export const syncUpdateReportSchedule = (record: unknown) => syncUpdate('report_schedules', record);
export const syncInsertSafeDrop = (record: unknown) => syncInsert('safe_drops', record);

// Settings sync functions
export const syncUpdateBusinessSettings = (settings: unknown) => syncUpdate('business_settings', settings);
export const syncUpdateKCBSettings = (settings: unknown) => syncUpdate('kcb_settings', settings);
// Backward-compatible alias for older callers.
export const syncUpdateMpesaSettings = syncUpdateKCBSettings;
export const syncUpdatePaymentMethod = (method: unknown) => syncUpdate('payment_methods', method);
export const syncUpdateLoyaltySettings = (settings: unknown) => syncUpdate('loyalty_settings', settings);
export const syncUpdateReceiptSettings = (settings: unknown) => syncUpdate('receipt_settings', settings);

// Helper to check if ID is a valid UUID
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(id: string): boolean {
  return UUID_REGEX.test(id);
}

// Generate a proper UUID v4
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function resyncAllLocalProducts(): Promise<{ synced: number; skipped: number; errors: string[] }> {
  const client = getSupabase();
  if (!client || !isOnline) {
    return { synced: 0, skipped: 0, errors: ['Not online or Supabase not configured'] };
  }

  const db = await getDB();
  const localProducts = await db.getAll('products');
  const errors: string[] = [];
  let synced = 0;
  let skipped = 0;

  // Get all existing SKUs from Supabase to avoid duplicates
  const { data: existingProducts } = await client.from('products').select('id, sku');
  const existingSkus = new Map((existingProducts || []).map(p => [p.sku?.toLowerCase(), p.id]));
  const existingIds = new Set((existingProducts || []).map(p => p.id));

  for (const product of localProducts) {
    try {
      // Skip if already synced (has valid UUID and exists in Supabase)
      if (isValidUUID(product.id) && existingIds.has(product.id)) {
        skipped++;
        continue;
      }

      // Generate new UUID for products with non-UUID IDs
      const newId = isValidUUID(product.id) ? product.id : generateUUID();

      // Check for SKU conflict
      const skuLower = product.sku?.trim().toLowerCase();
      let finalSku = product.sku;
      if (skuLower && existingSkus.has(skuLower) && existingSkus.get(skuLower) !== newId) {
        // SKU conflict - append a number
        let counter = 1;
        while (existingSkus.has(`${skuLower}-${counter}`)) {
          counter++;
        }
        finalSku = `${product.sku}-${counter}`;
      }
      existingSkus.set(finalSku?.toLowerCase() || '', newId);

      // Prepare product data for Supabase
      const productData = {
        id: newId,
        name: product.name,
        sku: finalSku,
        price: product.price,
        cost: product.cost ?? 0,
        stock: product.stock,
        category: product.category ?? null,
        image_url: product.image_url ?? null,
        is_active: product.is_active ?? true,
        created_at: product.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Upsert to Supabase
      const { error } = await client.from('products').upsert(productData);
      if (error) throw error;

      // Update local record with new ID if changed
      if (newId !== product.id) {
        await db.delete('products', product.id);
        await db.put('products', { ...product, id: newId, sku: finalSku, sync_status: 'synced' });
      } else {
        await db.put('products', { ...product, sku: finalSku, sync_status: 'synced' });
      }

      synced++;
    } catch (err) {
      const errMsg = formatSyncError(err);
      errors.push(`Failed to sync "${product.name}": ${errMsg}`);
    }
  }

  return { synced, skipped, errors };
}
