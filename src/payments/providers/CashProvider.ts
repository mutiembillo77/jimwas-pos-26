import { PaymentProvider } from './PaymentProvider';
import { PaymentRequest } from '../dto/PaymentRequest';
import { PaymentResponse, TransactionStatus } from '../dto/PaymentResponse';
import { CallbackPayload } from '../dto/CallbackPayload';

/**
 * Physical Cash Payment Provider
 * Instant local validation for cash transactions at the POS counter.
 */
export class CashProvider implements PaymentProvider {
  public async initiatePayment(request: PaymentRequest): Promise<PaymentResponse> {
    const cashReceiptId = `CASH-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    return {
      provider: 'cash',
      providerTransactionId: cashReceiptId,
      status: 'SUCCESS',
      responseCode: '00',
      responseMessage: 'Physical cash received and recorded successfully',
      timing: request.timing || 'immediate',
      raw: {
        method: 'cash',
        amount: request.amount,
        invoiceNumber: request.invoiceNumber,
        cashierId: request.cashierId,
        cashierName: request.cashierName,
        timestamp: new Date().toISOString(),
      },
    };
  }

  public async processCallback(payload: any): Promise<CallbackPayload> {
    return {
      provider: 'cash',
      status: 'SUCCESS',
      resultCode: 0,
      resultDesc: 'Cash payment confirmed',
      raw: payload,
      receivedAt: new Date().toISOString(),
    };
  }

  public async validateTransaction(_transactionId: string): Promise<TransactionStatus> {
    return 'SUCCESS';
  }

  public async getTransactionStatus(transactionId: string): Promise<PaymentResponse> {
    return {
      provider: 'cash',
      providerTransactionId: transactionId,
      status: 'SUCCESS',
      responseCode: '00',
      responseMessage: 'Cash payment confirmed',
    };
  }
}
