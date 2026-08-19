import { PaymentMethod, PaymentTiming, PaymentStatus } from '../../types/payment';

export type TransactionStatus = PaymentStatus;

export interface PaymentResponse {
  provider: PaymentMethod;
  providerTransactionId?: string;
  merchantRequestId?: string;
  checkoutRequestId?: string;
  responseCode?: string;
  responseMessage?: string;
  status: TransactionStatus;
  timing?: PaymentTiming;
  paymentId?: string;
  raw?: any;
}
