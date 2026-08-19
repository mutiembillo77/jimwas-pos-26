import { PaymentProvider } from './PaymentProvider';
import { PaymentRequest } from '../dto/PaymentRequest';
import { PaymentResponse, TransactionStatus } from '../dto/PaymentResponse';
import { CallbackPayload } from '../dto/CallbackPayload';

/**
 * NCBA Payment Provider (PENDING STATUS)
 * Placeholder provider for upcoming NCBA integration.
 */
export class NcbaProvider implements PaymentProvider {
  public async initiatePayment(request: PaymentRequest): Promise<PaymentResponse> {
    console.warn('[JIMWAS PAYMENT] NCBA payment provider is currently PENDING and not active.', {
      invoiceNumber: request.invoiceNumber,
      amount: request.amount,
    });

    return {
      provider: 'ncba',
      status: 'PENDING',
      responseCode: 'PROVIDER_PENDING',
      responseMessage: 'NCBA payment gateway integration is currently pending activation. Please use KCB BUNI or Cash.',
      timing: request.timing,
      raw: {
        provider: 'ncba',
        status: 'PENDING',
        message: 'NCBA integration is in pending state.',
      },
    };
  }

  public async processCallback(payload: any): Promise<CallbackPayload> {
    console.warn('[JIMWAS PAYMENT] Received callback for pending NCBA provider.');
    return {
      provider: 'ncba',
      status: 'PENDING',
      resultCode: 999,
      resultDesc: 'NCBA provider pending activation',
      raw: payload,
      receivedAt: new Date().toISOString(),
    };
  }

  public async validateTransaction(_transactionId: string): Promise<TransactionStatus> {
    return 'PENDING';
  }

  public async getTransactionStatus(transactionId: string): Promise<PaymentResponse> {
    return {
      provider: 'ncba',
      providerTransactionId: transactionId,
      status: 'PENDING',
      responseCode: 'PROVIDER_PENDING',
      responseMessage: 'NCBA payment gateway is pending activation.',
    };
  }
}
