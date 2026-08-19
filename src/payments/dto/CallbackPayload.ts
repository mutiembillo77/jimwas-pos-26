import { TransactionStatus } from './PaymentResponse';
import { PaymentMethod } from '../../types/payment';

export interface CallbackPayload {
  merchantRequestId?: string;
  checkoutRequestId?: string;
  providerTransactionId?: string;
  status: TransactionStatus;
  amount?: number | string;
  phoneNumber?: string;
  raw: any;
  provider?: PaymentMethod | string;
  resultCode?: number;
  resultDesc?: string;
  callbackMetadata?: any;
  receivedAt?: string;
}
