/**
 * environment.ts — Canonical runtime environment resolver for JIMWAS POS
 *
 * Maps the application runtime to either SANDBOX or PRODUCTION.
 *
 * Architecture:
 *   - ONE Supabase project (ddxthibctyfplcrzwdve) is intentionally shared.
 *   - Environment isolation is enforced at the RECORD level, not the project level.
 *   - The runtime environment is determined from trusted configuration (VITE_APP_ENV / VERCEL_ENV).
 *   - The client CANNOT override this to PRODUCTION when running in a non-production context.
 *
 * Mapping:
 *   production  → PRODUCTION
 *   preview     → SANDBOX  (Vercel previews use sandbox credentials)
 *   sandbox     → SANDBOX
 *   development → SANDBOX
 *   (default)   → SANDBOX  (fail-safe: unknown = sandbox, never silently escalate to production)
 */

export type FinancialEnvironment = 'SANDBOX' | 'PRODUCTION';

/**
 * Resolves the active financial environment from trusted runtime configuration.
 *
 * Priority:
 *   1. VITE_APP_ENV (explicit, recommended)
 *   2. VERCEL_ENV (Vercel deployment context)
 *   3. NODE_ENV (fallback for non-Vercel environments)
 *
 * The caller CANNOT pass 'PRODUCTION' directly from the browser/client.
 * Only server-side trusted config can produce PRODUCTION.
 */
export function resolveFinancialEnvironment(): FinancialEnvironment {
  // Check explicit app environment variable first (highest priority)
  const viteAppEnv = import.meta.env?.VITE_APP_ENV as string | undefined;
  if (viteAppEnv) {
    return viteAppEnv.toLowerCase() === 'production' ? 'PRODUCTION' : 'SANDBOX';
  }

  // Check Vercel's deployment environment (injected at build time via VERCEL_ENV)
  const vercelEnv = import.meta.env?.VITE_VERCEL_ENV as string | undefined;
  if (vercelEnv) {
    return vercelEnv.toLowerCase() === 'production' ? 'PRODUCTION' : 'SANDBOX';
  }

  // Fallback: dev environment is always SANDBOX
  const mode = import.meta.env?.MODE as string | undefined;
  if (mode === 'production') {
    // In Vite, MODE=production only when built for production AND deployed to production.
    // For safety we still check for an explicit opt-in via VITE_APP_ENV.
    // Without it, we conservatively return SANDBOX.
    return 'SANDBOX';
  }

  return 'SANDBOX';
}

/**
 * Returns the active FinancialEnvironment for record stamping.
 * This is the canonical call site for all financial record creation.
 */
export const ACTIVE_FINANCIAL_ENV: FinancialEnvironment = resolveFinancialEnvironment();

/**
 * Asserts that a financial record's environment matches the expected environment.
 * Used in callback processing and reconciliation to prevent cross-environment settlement.
 *
 * @throws Error if environments are incompatible
 */
export function assertEnvironmentCompatibility(
  providerEnvironment: FinancialEnvironment,
  transactionEnvironment: FinancialEnvironment,
  context: string
): void {
  if (providerEnvironment !== transactionEnvironment) {
    throw new Error(
      `[FINANCIAL ISOLATION] Environment mismatch in ${context}: ` +
      `provider=${providerEnvironment}, transaction=${transactionEnvironment}. ` +
      `Settlement rejected to prevent sandbox/production contamination.`
    );
  }
}

/**
 * Resolves the provider environment from trusted server-side KCB BUNI configuration.
 * The provider environment is derived from the KCB_BUNI_BASE_URL, not from callback payloads.
 *
 * This function is for use in server-side contexts (Edge Functions, API routes).
 * The callback payload itself is NOT trusted as the source of provider environment.
 */
export function resolveProviderEnvironmentFromUrl(kcbBaseUrl: string): FinancialEnvironment {
  const url = (kcbBaseUrl || '').toLowerCase();
  if (url.includes('sandbox') || url.includes('uat')) {
    return 'SANDBOX';
  }
  if (url.includes('api.kcb.co.ke') && !url.includes('sandbox')) {
    return 'PRODUCTION';
  }
  // Default to SANDBOX if unknown — fail safe
  return 'SANDBOX';
}
