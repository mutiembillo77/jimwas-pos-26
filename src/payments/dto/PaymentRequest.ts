export type PaymentStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

export interface PaymentRequest {
  provider: string;
  merchantRequestId?: string;
  checkoutRequestId?: string;
  providerTransactionId?: string;
  phoneNumber: string;
  amount: number | string;
  invoiceNumber: string;
  status?: PaymentStatus;
  raw?: any;
  callbackUrl?: string;
  sharedShortCode?: string;
  orgShortCode?: string;
  orgPassKey?: string;
  transactionDescription?: string;
  metadata?: Record<string, unknown>;
}
