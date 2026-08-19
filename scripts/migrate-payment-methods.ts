/**
 * Migration Script: Migrate Legacy Payment Methods to JIMWAS Payment Ecosystem
 * 
 * Rules:
 * 1. 'mpesa' or 'kcb' -> 'kcb_buni'
 * 2. 'cod' (as method) -> payment_method: 'cash', payment_timing: 'cod', is_cod: true, cod_status: 'PENDING'
 * 3. 'card' -> flag unsupported, migrate to 'cash' with note
 * 4. Ensure all transactions have valid paymentMethod ('kcb_buni' | 'ncba' | 'cash') and paymentTiming ('immediate' | 'cod')
 */

export interface LegacyTransactionRecord {
  id: string;
  payment_method?: string;
  payment_timing?: string;
  is_cod?: boolean;
  cod_status?: string;
  notes?: string;
  [key: string]: any;
}

export interface MigrationResult {
  migratedCount: number;
  unsupportedCount: number;
  skippedCount: number;
  records: Array<{
    id: string;
    originalMethod: string;
    newMethod: string;
    newTiming: string;
    notes?: string;
  }>;
}

export function migrateTransactionRecord(tx: LegacyTransactionRecord): {
  updatedTx: LegacyTransactionRecord;
  changed: boolean;
  warning?: string;
} {
  const originalMethod = (tx.payment_method || 'cash').toLowerCase().trim();
  let updatedMethod: 'kcb_buni' | 'ncba' | 'cash' = 'cash';
  let updatedTiming: 'immediate' | 'cod' = (tx.payment_timing as 'immediate' | 'cod') || 'immediate';
  let isCod = !!tx.is_cod;
  let codStatus = tx.cod_status;
  let warning: string | undefined;
  let changed = false;

  switch (originalMethod) {
    case 'mpesa':
    case 'kcb':
    case 'kcb_buni':
      updatedMethod = 'kcb_buni';
      if (originalMethod !== 'kcb_buni') changed = true;
      break;

    case 'ncba':
      updatedMethod = 'ncba';
      break;

    case 'cod':
      // Convert legacy COD payment method to timing flag
      updatedMethod = 'cash';
      updatedTiming = 'cod';
      isCod = true;
      if (!codStatus) codStatus = 'PENDING';
      changed = true;
      break;

    case 'card':
      // Legacy card method: unsupported in Jimwas Payment Ecosystem, migrate with audit note
      updatedMethod = 'cash';
      warning = `Legacy 'card' payment method migrated to 'cash'. Original ID: ${tx.id}`;
      changed = true;
      break;

    case 'cash':
    default:
      updatedMethod = 'cash';
      if (originalMethod !== 'cash') {
        warning = `Unknown method '${originalMethod}' defaulted to 'cash'`;
        changed = true;
      }
      break;
  }

  // If already marked as cod status or timing
  if (tx.payment_timing === 'cod' || tx.is_cod) {
    updatedTiming = 'cod';
    isCod = true;
  }

  const updatedTx: LegacyTransactionRecord = {
    ...tx,
    payment_method: updatedMethod,
    payment_timing: updatedTiming,
    is_cod: isCod,
    cod_status: codStatus,
    notes: warning ? `${tx.notes ? tx.notes + ' | ' : ''}[MIGRATED]: ${warning}` : tx.notes,
  };

  return { updatedTx, changed, warning };
}

export function migrateTransactionBatch(transactions: LegacyTransactionRecord[]): MigrationResult {
  const result: MigrationResult = {
    migratedCount: 0,
    unsupportedCount: 0,
    skippedCount: 0,
    records: [],
  };

  for (const tx of transactions) {
    const originalMethod = tx.payment_method || 'cash';
    const { updatedTx, changed, warning } = migrateTransactionRecord(tx);

    if (changed) {
      result.migratedCount++;
      if (warning) result.unsupportedCount++;
      result.records.push({
        id: tx.id,
        originalMethod,
        newMethod: updatedTx.payment_method!,
        newTiming: updatedTx.payment_timing!,
        notes: warning,
      });
    } else {
      result.skippedCount++;
    }
  }

  return result;
}

// Standalone execution logger
if (typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('migrate-payment-methods')) {
  console.log('[MIGRATION] Jimwas Payment Methods migration utility loaded.');
  console.log('[MIGRATION] Ready to process transactions.');
}
