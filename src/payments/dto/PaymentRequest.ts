import { PaymentMethod, PaymentTiming, PaymentStatus } from '../../types/payment';

export type { PaymentStatus };

export interface PaymentRequest {
  provider: PaymentMethod;
  merchantRequestId?: string;
  checkoutRequestId?: string;
  providerTransactionId?: string;
  phoneNumber?: string;
  amount: number | string;
  invoiceNumber: string;
  status?: PaymentStatus;
  timing?: PaymentTiming;
  paymentAccountId?: string;
  paymentAccountName?: string;
  sharedShortCode?: boolean;
  orgShortCode?: string;
  orgPassKey?: string;
  callbackUrl?: string;
  transactionDescription?: string;
  metadata?: Record<string, any>;
  cashierId?: string;
  cashierName?: string;
  raw?: any;
}
