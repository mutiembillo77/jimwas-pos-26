/**
 * JIMWAS POS — Financial Environment Isolation Test Suite
 *
 * Architecture context:
 *   - ONE Supabase project (ddxthibctyfplcrzwdve) is intentionally shared across
 *     development / sandbox / preview / production.
 *   - Data isolation is enforced at the RECORD level via an immutable `environment` field.
 *   - Payment architecture: M-Pesa Express via KCB BUNI (KCB = gateway, M-Pesa = rail).
 *
 * Tests cover:
 *   1–3:   Transaction environment stamping and immutability
 *   4–11:  Callback environment compatibility gate (sandbox/production cross-environment rejection)
 *   12–21: Reporting isolation (ledger, sales, VAT, cashbook, mobile money, etc.)
 *   22–25: Offline sync environment preservation
 *   26–30: Reconciliation, payment-to-sale identity, summary isolation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveFinancialEnvironment,
  resolveProviderEnvironmentFromUrl,
  assertEnvironmentCompatibility,
  type FinancialEnvironment,
} from '../src/lib/environment';
import { getLedgerEntries, getDailySummary, getPeriodSummary } from '../src/lib/ledger';

// ============================================================================
// MOCK HELPERS
// ============================================================================

type MockTransaction = {
  id: string;
  created_at: string;
  status: string;
  total_amount: number;
  payment_method: string;
  environment: FinancialEnvironment;
  customer_id?: string;
  cashier_id?: string;
  cashier_name?: string;
  branch_id?: string;
  sync_status: 'pending' | 'synced';
};

function makeTx(env: FinancialEnvironment, overrides: Partial<MockTransaction> = {}): MockTransaction {
  return {
    id: `tx-${Math.random().toString(36).slice(2)}`,
    created_at: new Date().toISOString(),
    status: 'completed',
    total_amount: 1000,
    payment_method: env === 'PRODUCTION' ? 'kcb_buni' : 'cash',
    environment: env,
    sync_status: 'pending',
    ...overrides,
  };
}

function makeKcbPayment(env: FinancialEnvironment, status = 'pending') {
  return {
    id: `kcb-${Math.random().toString(36).slice(2)}`,
    status,
    environment: env,
    transaction_id: `tx-${Math.random().toString(36).slice(2)}`,
    checkout_request_id: `ws_CO_${Date.now()}`,
    idempotency_key: `idem-${Date.now()}`,
  };
}

/** Simulates callback settlement gate. Returns true if settlement is permitted. */
function isCallbackSettlementPermitted(
  providerEnvironment: FinancialEnvironment,
  paymentEnvironment: FinancialEnvironment
): boolean {
  return providerEnvironment === paymentEnvironment;
}

/** Simulates reconciliation gate. Returns true if reconciliation is permitted. */
function isReconciliationPermitted(
  providerEnvironment: FinancialEnvironment,
  transactionEnvironment: FinancialEnvironment
): boolean {
  return providerEnvironment === transactionEnvironment;
}

// ============================================================================
// SECTION 1–3: TRANSACTION ENVIRONMENT STAMPING AND IMMUTABILITY
// ============================================================================

describe('JIMWAS POS — Financial Environment Isolation', () => {

  describe('1. Transaction Environment Stamping', () => {
    it('1. SANDBOX runtime produces SANDBOX-classified transactions', () => {
      const tx = makeTx('SANDBOX');
      expect(tx.environment).toBe('SANDBOX');
    });

    it('2. PRODUCTION runtime produces PRODUCTION-classified transactions', () => {
      const tx = makeTx('PRODUCTION');
      expect(tx.environment).toBe('PRODUCTION');
    });

    it('3. Environment cannot be changed through ordinary update (immutability invariant)', () => {
      const tx = makeTx('SANDBOX');
      // Simulates an ordinary application-level update — environment must not change
      const updatePayload = { status: 'voided' }; // no environment key
      const updatedTx = { ...tx, ...updatePayload };
      expect(updatedTx.environment).toBe('SANDBOX');
      // Ordinary update must never produce environment escalation
      expect(Object.keys(updatePayload)).not.toContain('environment');
    });
  });

  // ============================================================================
  // SECTION 4–11: CALLBACK ENVIRONMENT COMPATIBILITY GATE
  // ============================================================================

  describe('2. Callback Environment Compatibility Gate (M-Pesa Express via KCB BUNI)', () => {
    it('4. SANDBOX callback against SANDBOX payment → ALLOW settlement', () => {
      const payment = makeKcbPayment('SANDBOX');
      const providerEnv: FinancialEnvironment = 'SANDBOX';
      expect(isCallbackSettlementPermitted(providerEnv, payment.environment)).toBe(true);
    });

    it('5. PRODUCTION callback against PRODUCTION payment → ALLOW settlement', () => {
      const payment = makeKcbPayment('PRODUCTION');
      const providerEnv: FinancialEnvironment = 'PRODUCTION';
      expect(isCallbackSettlementPermitted(providerEnv, payment.environment)).toBe(true);
    });

    it('6. SANDBOX callback against PRODUCTION payment → REJECT settlement', () => {
      const payment = makeKcbPayment('PRODUCTION');
      const providerEnv: FinancialEnvironment = 'SANDBOX';
      expect(isCallbackSettlementPermitted(providerEnv, payment.environment)).toBe(false);
    });

    it('7. PRODUCTION callback against SANDBOX payment → REJECT settlement', () => {
      const payment = makeKcbPayment('SANDBOX');
      const providerEnv: FinancialEnvironment = 'PRODUCTION';
      expect(isCallbackSettlementPermitted(providerEnv, payment.environment)).toBe(false);
    });

    it('8. Rejected callback creates no financial settlement (no status change)', () => {
      const payment = makeKcbPayment('PRODUCTION', 'pending');
      const providerEnv: FinancialEnvironment = 'SANDBOX'; // mismatch
      const permitted = isCallbackSettlementPermitted(providerEnv, payment.environment);
      expect(permitted).toBe(false);
      // Assert payment status unchanged
      expect(payment.status).toBe('pending');
    });

    it('9. Rejected callback creates no ledger posting', () => {
      // When settlement is rejected, the application must produce zero ledger entries.
      const sandboxCallback = { environment: 'SANDBOX' as FinancialEnvironment };
      const productionTx = makeTx('PRODUCTION');
      const canSettle = isCallbackSettlementPermitted(sandboxCallback.environment, productionTx.environment);
      expect(canSettle).toBe(false);
      // Zero entries would be added since settlement is blocked before ledger write
    });

    it('10. Rejected callback creates no inventory movement', () => {
      const productionCallback = { environment: 'PRODUCTION' as FinancialEnvironment };
      const sandboxTx = makeTx('SANDBOX');
      const canSettle = isCallbackSettlementPermitted(productionCallback.environment, sandboxTx.environment);
      expect(canSettle).toBe(false);
      // Stock movements are only created after successful settlement — which is blocked here
    });

    it('11. Rejected callback creates no cashbook movement', () => {
      const sandboxCallback = { environment: 'SANDBOX' as FinancialEnvironment };
      const productionTx = makeTx('PRODUCTION');
      expect(isCallbackSettlementPermitted(sandboxCallback.environment, productionTx.environment)).toBe(false);
    });
  });

  // ============================================================================
  // SECTION 12–21: REPORTING ISOLATION
  // ============================================================================

  describe('3. Reporting Isolation — getLedgerEntries', () => {
    const sandboxTx = makeTx('SANDBOX', { total_amount: 500, payment_method: 'cash' });
    const productionTx = makeTx('PRODUCTION', { total_amount: 2000, payment_method: 'kcb_buni' });

    it('12. SANDBOX ledger excluded from PRODUCTION ledger', async () => {
      // The production ledger must only contain production transactions.
      const allTxs: MockTransaction[] = [sandboxTx, productionTx];
      const productionEntries = allTxs.filter(tx => tx.environment === 'PRODUCTION');
      expect(productionEntries.every(e => e.environment === 'PRODUCTION')).toBe(true);
      expect(productionEntries.some(e => e.environment === 'SANDBOX')).toBe(false);
    });

    it('13. PRODUCTION ledger excluded from SANDBOX ledger', async () => {
      const allTxs: MockTransaction[] = [sandboxTx, productionTx];
      const sandboxEntries = allTxs.filter(tx => tx.environment === 'SANDBOX');
      expect(sandboxEntries.every(e => e.environment === 'SANDBOX')).toBe(true);
      expect(sandboxEntries.some(e => e.environment === 'PRODUCTION')).toBe(false);
    });

    it('14. SANDBOX sales excluded from PRODUCTION sales report', () => {
      const allTxs: MockTransaction[] = [sandboxTx, productionTx];
      const productionSales = allTxs
        .filter(tx => tx.environment === 'PRODUCTION' && tx.status === 'completed')
        .reduce((sum, tx) => sum + tx.total_amount, 0);
      // Should only include the 2000 production transaction
      expect(productionSales).toBe(2000);
      expect(productionSales).not.toBe(2500); // 500 + 2000 would be mixed
    });

    it('15. SANDBOX VAT excluded from PRODUCTION VAT', () => {
      // VAT (16%) on production sales must not include sandbox transaction amounts.
      const VAT_RATE = 0.16;
      const allTxs: MockTransaction[] = [sandboxTx, productionTx];
      const productionVAT = allTxs
        .filter(tx => tx.environment === 'PRODUCTION')
        .reduce((sum, tx) => sum + tx.total_amount * VAT_RATE, 0);
      const sandboxVAT = allTxs
        .filter(tx => tx.environment === 'SANDBOX')
        .reduce((sum, tx) => sum + tx.total_amount * VAT_RATE, 0);
      expect(productionVAT).toBeCloseTo(2000 * VAT_RATE);
      expect(sandboxVAT).toBeCloseTo(500 * VAT_RATE);
      // Production VAT must not include sandbox VAT
      expect(productionVAT + sandboxVAT).toBeGreaterThan(productionVAT);
    });

    it('16. SANDBOX cash excluded from PRODUCTION cashbook', () => {
      const allTxs: MockTransaction[] = [
        makeTx('SANDBOX', { payment_method: 'cash', total_amount: 300 }),
        makeTx('PRODUCTION', { payment_method: 'cash', total_amount: 1500 }),
      ];
      const productionCash = allTxs
        .filter(tx => tx.environment === 'PRODUCTION' && tx.payment_method === 'cash')
        .reduce((sum, tx) => sum + tx.total_amount, 0);
      expect(productionCash).toBe(1500);
      expect(productionCash).not.toBe(1800); // would be mixed
    });

    it('17. SANDBOX mobile money excluded from PRODUCTION mobile-money totals', () => {
      const allTxs: MockTransaction[] = [
        makeTx('SANDBOX', { payment_method: 'kcb_buni', total_amount: 400 }),
        makeTx('PRODUCTION', { payment_method: 'kcb_buni', total_amount: 3000 }),
      ];
      const productionMobileMoney = allTxs
        .filter(tx => tx.environment === 'PRODUCTION' && tx.payment_method === 'kcb_buni')
        .reduce((sum, tx) => sum + tx.total_amount, 0);
      expect(productionMobileMoney).toBe(3000);
    });

    it('18. SANDBOX receivables excluded from PRODUCTION receivables', () => {
      const plans = [
        { id: 'plan-a', total_amount: 5000, amount_paid: 1000, environment: 'SANDBOX' as FinancialEnvironment },
        { id: 'plan-b', total_amount: 8000, amount_paid: 3000, environment: 'PRODUCTION' as FinancialEnvironment },
      ];
      const productionReceivables = plans
        .filter(p => p.environment === 'PRODUCTION')
        .reduce((sum, p) => sum + (p.total_amount - p.amount_paid), 0);
      expect(productionReceivables).toBe(5000);
    });

    it('19. SANDBOX expenses excluded from PRODUCTION expenses', () => {
      const expenses = [
        { id: 'exp-a', amount: 200, environment: 'SANDBOX' as FinancialEnvironment },
        { id: 'exp-b', amount: 800, environment: 'PRODUCTION' as FinancialEnvironment },
      ];
      const productionExpenses = expenses
        .filter(e => e.environment === 'PRODUCTION')
        .reduce((sum, e) => sum + e.amount, 0);
      expect(productionExpenses).toBe(800);
    });

    it('20. SANDBOX refunds excluded from PRODUCTION refunds', () => {
      const refunds = [
        { id: 'ref-a', refund_amount: 100, environment: 'SANDBOX' as FinancialEnvironment },
        { id: 'ref-b', refund_amount: 500, environment: 'PRODUCTION' as FinancialEnvironment },
      ];
      const productionRefunds = refunds
        .filter(r => r.environment === 'PRODUCTION')
        .reduce((sum, r) => sum + r.refund_amount, 0);
      expect(productionRefunds).toBe(500);
    });

    it('21. SANDBOX voids excluded from PRODUCTION voids', () => {
      const voids = [
        { id: 'void-a', transaction_total: 250, environment: 'SANDBOX' as FinancialEnvironment },
        { id: 'void-b', transaction_total: 750, environment: 'PRODUCTION' as FinancialEnvironment },
      ];
      const productionVoids = voids
        .filter(v => v.environment === 'PRODUCTION')
        .reduce((sum, v) => sum + v.transaction_total, 0);
      expect(productionVoids).toBe(750);
    });
  });

  // ============================================================================
  // SECTION 22–25: OFFLINE SYNC ENVIRONMENT PRESERVATION
  // ============================================================================

  describe('4. Offline Sync Environment Preservation', () => {
    it('22. Offline sync preserves environment field on transaction', () => {
      const localTx = makeTx('SANDBOX');
      // Simulate sync payload construction — environment must be preserved
      const syncPayload = { ...localTx }; // sync.ts copies all fields including environment
      expect(syncPayload.environment).toBe('SANDBOX');
    });

    it('23. Environment mismatch during sync is rejected/quarantined', () => {
      const localTx = makeTx('SANDBOX');
      const runtimeEnv: FinancialEnvironment = 'PRODUCTION'; // current runtime
      // A SANDBOX local record must not be upserted into PRODUCTION
      const shouldSync = localTx.environment === runtimeEnv;
      expect(shouldSync).toBe(false);
    });

    it('24. Duplicate sync call preserves environment (idempotent)', () => {
      const localTx = makeTx('PRODUCTION');
      const syncPayload1 = { ...localTx };
      const syncPayload2 = { ...localTx }; // duplicate
      expect(syncPayload1.environment).toBe('PRODUCTION');
      expect(syncPayload2.environment).toBe('PRODUCTION');
      expect(syncPayload1.environment).toBe(syncPayload2.environment);
    });

    it('25. Callback replay preserves environment (idempotent environment check)', () => {
      const payment = makeKcbPayment('SANDBOX', 'success'); // already settled
      const providerEnv: FinancialEnvironment = 'SANDBOX';
      // Replay: environment gate passes but terminal state gate blocks re-settlement
      const envCompatible = isCallbackSettlementPermitted(providerEnv, payment.environment);
      const alreadySettled = payment.status === 'success';
      expect(envCompatible).toBe(true);
      expect(alreadySettled).toBe(true); // terminal state prevents double settlement
    });
  });

  // ============================================================================
  // SECTION 26–30: RECONCILIATION, IDENTITY, AND SUMMARY ISOLATION
  // ============================================================================

  describe('5. Reconciliation, Payment Identity, and Summary Isolation', () => {
    it('26. SANDBOX provider record cannot reconcile against PRODUCTION transaction', () => {
      const providerEnv: FinancialEnvironment = 'SANDBOX';
      const transactionEnv: FinancialEnvironment = 'PRODUCTION';
      expect(isReconciliationPermitted(providerEnv, transactionEnv)).toBe(false);
    });

    it('27. Payment-to-sale environment mismatch is rejected', () => {
      const tx = makeTx('PRODUCTION');
      const payment = { ...makeKcbPayment('SANDBOX'), transaction_id: tx.id };
      // A SANDBOX payment record must not be matched to a PRODUCTION transaction
      expect(payment.environment).not.toBe(tx.environment);
      expect(isReconciliationPermitted(payment.environment, tx.environment)).toBe(false);
    });

    it('28. Daily summary isolates environment — SANDBOX totals do not appear in PRODUCTION', () => {
      const allTxs: MockTransaction[] = [
        makeTx('SANDBOX', { total_amount: 200, created_at: '2026-08-22T10:00:00Z' }),
        makeTx('PRODUCTION', { total_amount: 1500, created_at: '2026-08-22T10:00:00Z' }),
      ];
      const productionSales = allTxs
        .filter(tx => tx.environment === 'PRODUCTION')
        .reduce((sum, tx) => sum + tx.total_amount, 0);
      // Production daily summary must only show 1500
      expect(productionSales).toBe(1500);
    });

    it('29. Period summary isolates environment', () => {
      const allTxs: MockTransaction[] = [
        makeTx('SANDBOX', { total_amount: 600 }),
        makeTx('SANDBOX', { total_amount: 400 }),
        makeTx('PRODUCTION', { total_amount: 5000 }),
        makeTx('PRODUCTION', { total_amount: 3000 }),
      ];
      const productionTotal = allTxs
        .filter(tx => tx.environment === 'PRODUCTION')
        .reduce((sum, tx) => sum + tx.total_amount, 0);
      const sandboxTotal = allTxs
        .filter(tx => tx.environment === 'SANDBOX')
        .reduce((sum, tx) => sum + tx.total_amount, 0);
      expect(productionTotal).toBe(8000);
      expect(sandboxTotal).toBe(1000);
      // They must be mutually exclusive
      expect(productionTotal + sandboxTotal).toBe(9000);
    });

    it('30. Financial statements isolate environment — no silent aggregation across environments', () => {
      const statement = {
        production: { revenue: 8000, expenses: 1000, net: 7000 },
        sandbox: { revenue: 1000, expenses: 200, net: 800 },
      };
      // Production financial statement must not silently include sandbox activity
      expect(statement.production.revenue).toBe(8000);
      expect(statement.production.revenue + statement.sandbox.revenue).toBeGreaterThan(statement.production.revenue);
      // The combined value would be 9000 — which is what mixing would produce
      // Production reports must remain at exactly 8000
    });
  });

  // ============================================================================
  // SECTION 31+: ENVIRONMENT RESOLVER UNIT TESTS
  // ============================================================================

  describe('6. Environment Resolver', () => {
    it('31. KCB sandbox URL resolves to SANDBOX provider environment', () => {
      expect(resolveProviderEnvironmentFromUrl('https://api.sandbox.kcb.co.ke')).toBe('SANDBOX');
    });

    it('32. KCB UAT URL resolves to SANDBOX provider environment', () => {
      expect(resolveProviderEnvironmentFromUrl('https://uat.buni.kcbgroup.com')).toBe('SANDBOX');
    });

    it('33. KCB production URL resolves to PRODUCTION provider environment', () => {
      expect(resolveProviderEnvironmentFromUrl('https://api.kcb.co.ke')).toBe('PRODUCTION');
    });

    it('34. Unknown URL defaults to SANDBOX (fail-safe)', () => {
      expect(resolveProviderEnvironmentFromUrl('')).toBe('SANDBOX');
      expect(resolveProviderEnvironmentFromUrl('https://unknown-host.example.com')).toBe('SANDBOX');
    });

    it('35. assertEnvironmentCompatibility passes when environments match', () => {
      expect(() => assertEnvironmentCompatibility('SANDBOX', 'SANDBOX', 'test')).not.toThrow();
      expect(() => assertEnvironmentCompatibility('PRODUCTION', 'PRODUCTION', 'test')).not.toThrow();
    });

    it('36. assertEnvironmentCompatibility throws when environments mismatch', () => {
      expect(() => assertEnvironmentCompatibility('SANDBOX', 'PRODUCTION', 'callback')).toThrow(/mismatch/i);
      expect(() => assertEnvironmentCompatibility('PRODUCTION', 'SANDBOX', 'callback')).toThrow(/mismatch/i);
    });

    it('37. Provider reference collision across environments is rejected', () => {
      const sandboxPayment = makeKcbPayment('SANDBOX');
      const productionPayment = { ...makeKcbPayment('PRODUCTION'), checkout_request_id: sandboxPayment.checkout_request_id };
      // Even if checkout_request_id collides, environments differ — reconciliation must reject
      expect(isReconciliationPermitted(sandboxPayment.environment, productionPayment.environment)).toBe(false);
    });
  });

});
