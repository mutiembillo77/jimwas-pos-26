/**
 * JIMWAS Payment Ecosystem Type Definitions
 * Strict payment method types: only 'kcb_buni' | 'ncba' | 'cash'
 */

export type PaymentMethod = 'kcb_buni' | 'ncba' | 'cash';
export type PaymentTiming = 'immediate' | 'cod';
export type PaymentStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export type ProviderStatus = 'ACTIVE' | 'PENDING' | 'INACTIVE';

export interface PaymentConfig {
  method: PaymentMethod;
  timing: PaymentTiming;
  displayName: string;
  providerStatus: ProviderStatus;
  requiresPhoneNumber?: boolean;
  requiresCashier?: boolean;
}

export const PAYMENT_CONFIGS: Record<PaymentMethod, Omit<PaymentConfig, 'method'>> = {
  kcb_buni: {
    timing: 'immediate',
    displayName: 'KCB BUNI STK (MPESAEXPRESS)',
    providerStatus: 'ACTIVE',
    requiresPhoneNumber: true,
    requiresCashier: false,
  },
  ncba: {
    timing: 'immediate',
    displayName: 'NCBA',
    providerStatus: 'PENDING',
    requiresPhoneNumber: true,
    requiresCashier: false,
  },
  cash: {
    timing: 'immediate',
    displayName: 'Physical Cash',
    providerStatus: 'ACTIVE',
    requiresPhoneNumber: false,
    requiresCashier: true,
  },
};

export function isValidPaymentMethod(method: string): method is PaymentMethod {
  return ['kcb_buni', 'ncba', 'cash'].includes(method);
}

export function getPaymentDisplayName(method: PaymentMethod): string {
  return PAYMENT_CONFIGS[method]?.displayName || method;
}

export function isProviderActive(method: PaymentMethod): boolean {
  return PAYMENT_CONFIGS[method]?.providerStatus === 'ACTIVE';
}
