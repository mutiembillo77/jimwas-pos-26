import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getDB, getSyncQueue, removeFromSyncQueue, addToSyncQueue, generateId, getSyncMetadata, setSyncMetadata } from './db';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? import.meta.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let _supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseKey) return null;
  if (!_supabase) _supabase = createClient(supabaseUrl, supabaseKey);
  return _supabase;
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

let syncState: SyncState = {
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
    return { success: true, message: 'Item synced successfully' };
  } catch (error) {
    await addToSyncQueue({ ...item, operation: item.operation as 'insert' | 'update' | 'delete', retry_count: (item.retry_count ?? 0) + 1, next_retry_at: undefined, last_error: error instanceof Error ? error.message : 'Sync failed' } as any);
    syncState.failedCount += 1;
    syncState.status = 'degraded';
    syncState.error = error instanceof Error ? error.message : 'Sync failed';
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
    result.success ? success++ : failed++;
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
}

async function checkPendingCount() {
  try {
    const queue = await getSyncQueue();
    syncState.pendingCount = queue.length;
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
    syncState.status = 'offline';
    syncState.error = 'Supabase is not configured. Local operations remain enabled.';
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
        await addToSyncQueue({ ...item, retry_count: retryCount, next_retry_at: new Date(Date.now() + retryDelay).toISOString(), last_error: error instanceof Error ? error.message : 'Sync failed' });
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

async function processSyncItem(item: { table_name: string; operation: string; data: Record<string, unknown> }) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase is not configured. Sync is unavailable while offline.');
  const { table_name, operation, data } = item;
  const table = client.from(table_name);

  let error;
  switch (operation) {
    case 'insert': {
      // All local records carry their stable ID; upsert makes retries safe after
      // a timeout or a browser restart instead of creating duplicate rows.
      const result = await table.upsert(data, { onConflict: 'id', ignoreDuplicates: false });
      error = result.error;
      break;
    }
    case 'update': {
      const result = await table.upsert(data);
      error = result.error;
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
  store: string;
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

  if (config.single) {
    if (data.length > 0) {
      await db.put(config.store, { ...data[0], sync_status: 'synced' });
    }
    return;
  }

  for (const row of data) {
    if (config.uniqueIndex && config.uniqueField) {
      const fieldValue = row[config.uniqueField];
      if (fieldValue) {
        const existing = await db.getFromIndex(config.store, config.uniqueIndex, fieldValue);
        if (existing && existing.id !== row.id) {
          const pending = await getSyncQueue();
          const hasPendingWrite = pending.some(item => item.table_name === config.table && item.data.id === existing.id);
          if (hasPendingWrite) continue;
          // Reuse the existing local key to avoid unique-index collisions.
          row.id = existing.id;
        }
      }
    }

    const record = config.relation
      ? { ...row, sync_status: 'synced', items: row[config.relation.field] || [] }
      : { ...row, sync_status: 'synced' };

    await db.put(config.store, record);
  }
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
  if (!isOnline || !getSupabase()) {
    queueForSync(table, 'insert', data);
    return;
  }
  try {
    const { error } = await getSupabase()!.from(table).insert(data as Record<string, unknown>);
    if (error) throw error;
  } catch {
    queueForSync(table, 'insert', data);
  }
}

async function syncUpdate(table: string, data: unknown): Promise<void> {
  if (!isOnline || !getSupabase()) {
    queueForSync(table, 'update', data);
    return;
  }
  try {
    const { error } = await getSupabase()!.from(table).upsert(data as Record<string, unknown>);
    if (error) throw error;
  } catch {
    queueForSync(table, 'update', data);
  }
}

// Entity-specific sync functions (thin wrappers for backward compatibility)
export const syncInsertCustomer = (customer: unknown) => syncInsert('customers', customer);
export const syncUpdateCustomer = (customer: unknown) => syncUpdate('customers', customer);

export async function syncInsertTransaction(transaction: unknown, items: unknown[]) {
  if (!isOnline || !getSupabase()) {
    queueForSync('transactions', 'insert', transaction);
    items.forEach(item => queueForSync('transaction_items', 'insert', item));
    return;
  }
  try {
    const { error: txError } = await getSupabase()!.from('transactions').insert(transaction as Record<string, unknown>);
    if (txError) throw txError;
    if (items.length > 0) {
      const { error: itemsError } = await getSupabase()!.from('transaction_items').insert(items as Record<string, unknown>[]);
      if (itemsError) throw itemsError;
    }
  } catch {
    queueForSync('transactions', 'insert', transaction);
    items.forEach(item => queueForSync('transaction_items', 'insert', item));
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
        barcode: product.barcode ?? null,
        low_stock_alert: product.lowStockAlert ?? 5,
        tax_category: product.taxCategory ?? 'standard_16',
        is_active: product.isActive ?? true,
        sync_status: 'synced',
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
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to sync "${product.name}": ${errMsg}`);
    }
  }

  return { synced, skipped, errors };
}
