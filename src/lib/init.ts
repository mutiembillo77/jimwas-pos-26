import { getDB, getLastRestorePoint, getAllProducts, getAllCustomers } from './db';
import {
  DEFAULT_BUSINESS_SETTINGS,
  DEFAULT_KCB_SETTINGS,
  DEFAULT_PAYMENT_METHODS,
  DEFAULT_LOYALTY_SETTINGS,
  DEFAULT_RECEIPT_SETTINGS,
  DEFAULT_PAYMENT_ACCOUNTS,
  type PaymentAccount,
} from './settings-types';

/**
 * Idempotently ensures all default payment accounts exist in IndexedDB.
 * Detects existing records by ID and unique Code, never duplicates, and preserves existing records.
 */
export async function ensurePaymentAccounts(): Promise<PaymentAccount[]> {
  const db = await getDB();
  const accounts: PaymentAccount[] = [];

  for (const account of DEFAULT_PAYMENT_ACCOUNTS) {
    const existingById = await db.get('payment_accounts', account.id);
    let existing = existingById;
    if (!existing) {
      try {
        existing = await db.getFromIndex('payment_accounts', 'by-code', account.code);
      } catch {
        // Fallback if index not ready
      }
    }

    if (!existing) {
      await db.put('payment_accounts', account);
      accounts.push(account);
      try {
        const { queueForSync } = await import('./sync');
        queueForSync('payment_accounts', 'insert', account as unknown as Record<string, unknown>);
      } catch {
        // Non-blocking sync queueing
      }
    } else {
      // Preserve existing record. Only backfill paybill/account_number if defined on default and missing on existing
      if (
        (account.paybill_number && !existing.paybill_number) ||
        (account.account_number && !existing.account_number)
      ) {
        const merged: PaymentAccount = { ...existing, ...account };
        await db.put('payment_accounts', merged);
        accounts.push(merged);
      } else {
        accounts.push(existing);
      }
    }
  }

  return accounts;
}

/**
 * Initialize the application on first run
 * Creates default settings in IndexedDB if they don't exist
 */
export async function initializeApp(): Promise<void> {
  try {
    const db = await getDB();

    // Add a small delay to allow database upgrade to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    try {
      // Payment accounts must be seeded independently from first-run settings so
      // upgrades and existing installations receive the destinations too.
      await ensurePaymentAccounts();

      // Check if business settings exist
      const existingSettings = await db.get('business_settings', DEFAULT_BUSINESS_SETTINGS.id);
      if (!existingSettings) {
        console.log('[v0] Initializing default business settings...');
        
        // Stores use inline key paths, so persist the records without a separate key argument.
        await db.put('business_settings', DEFAULT_BUSINESS_SETTINGS);
        await db.put('kcb_settings', DEFAULT_KCB_SETTINGS);
        await db.put('loyalty_settings', DEFAULT_LOYALTY_SETTINGS);
        await db.put('receipt_settings', DEFAULT_RECEIPT_SETTINGS);

        // Initialize payment methods sequentially
        for (const method of DEFAULT_PAYMENT_METHODS) {
          await db.put('payment_methods', method);
        }

        console.log('[v0] Default settings initialized successfully');
      }
    } catch (dbError) {
      console.warn('[v0] Database initialization warning (non-critical):', dbError instanceof Error ? dbError.message : String(dbError));
      // Don't fail - database might already be initialized
    }

    // Mark app as initialized
    sessionStorage.setItem('app_initialized', 'true');
  } catch (error) {
    console.error('[v0] Failed to initialize app:', error);
    // Don't throw - allow app to continue even if init fails
  }
}

/**
 * Check if app has been initialized in this session
 */
export function isAppInitialized(): boolean {
  return sessionStorage.getItem('app_initialized') === 'true';
}

/**
 * Check if we should attempt auto-restore from last backup
 * Returns true if:
 * - A restore point exists (previous backup was imported)
 * - Local product/customer data is empty (fresh session or IndexedDB cleared)
 */
export async function shouldAutoRestore(): Promise<boolean> {
  try {
    const restorePoint = await getLastRestorePoint();
    if (!restorePoint) {
      console.log('[v0] No restore point found, auto-restore skipped');
      return false;
    }

    // Check if we have data in the database
    const products = await getAllProducts();
    const customers = await getAllCustomers();

    if (products.length === 0 || customers.length === 0) {
      console.log('[v0] Database appears empty, auto-restore needed');
      console.log(`[v0] Restore point: ${restorePoint.product_count} products, ${restorePoint.customer_count} customers`);
      return true;
    }

    console.log('[v0] Database has data, auto-restore not needed');
    return false;
  } catch (error) {
    console.error('[v0] Error checking auto-restore status:', error);
    return false;
  }
}
