import { PrismaClient } from '@prisma/client';
import { PaymentRepository } from '../repositories/PaymentRepository';
import { PaymentRequest } from '../dto/PaymentRequest';
import { PaymentResponse } from '../dto/PaymentResponse';
import { CallbackPayload } from '../dto/CallbackPayload';
import { PaymentProviderFactory } from '../providers/PaymentProviderFactory';
import { PaymentMethod, PaymentStatus, isValidPaymentMethod } from '../../types/payment';

/**
 * PaymentService
 * Orchestrates payments using PaymentProviderFactory and manages payment lifecycles.
 * Handles immediate vs COD payment timing, provider validations, and status persistence.
 */
export class PaymentService {
  private repo?: PaymentRepository;
  private factory: PaymentProviderFactory;

  constructor(prismaOrRepo?: PrismaClient | PaymentRepository) {
    if (prismaOrRepo) {
      if ('findByMerchantRequestId' in prismaOrRepo) {
        this.repo = prismaOrRepo as PaymentRepository;
      } else {
        this.repo = new PaymentRepository(prismaOrRepo as PrismaClient);
      }
    }
    this.factory = PaymentProviderFactory.getInstance();
  }

  /**
   * Main payment processing entrypoint
   */
  async initiatePayment(request: PaymentRequest, overrideMethod?: PaymentMethod): Promise<PaymentResponse> {
    const method = overrideMethod || request.provider;

    // 1. Validate payment method
    if (!isValidPaymentMethod(method)) {
      return {
        provider: method,
        status: 'FAILED',
        responseCode: 'INVALID_METHOD',
        responseMessage: `Unsupported or prohibited payment method: "${method}". Only kcb_buni, ncba, and cash are supported.`,
      };
    }

    // 2. Handle C.O.D. Timing (No immediate payment processing needed)
    if (request.timing === 'cod') {
      const codResponse: PaymentResponse = {
        provider: method,
        status: 'PENDING',
        timing: 'cod',
        responseCode: 'COD_PENDING',
        responseMessage: 'Order recorded for Cash on Delivery. Payment will be collected upon delivery.',
      };

      if (this.repo) {
        try {
          const record = await this.repo.createFromInitiation({
            provider: method,
            phoneNumber: request.phoneNumber,
            amount: request.amount,
            invoiceNumber: request.invoiceNumber,
            status: 'PENDING',
            raw: { timing: 'cod', note: 'Created as COD order' },
          });
          codResponse.paymentId = record?.id;
        } catch (e) {
          console.warn('[PaymentService] Failed to persist COD record to repo:', e);
        }
      }

      return codResponse;
    }

    // 3. Obtain provider and initiate payment
    const provider = this.factory.getProvider(method);
    const response = await provider.initiatePayment({
      ...request,
      provider: method,
      timing: 'immediate',
    });

    // 4. Record initiation in database repository if available
    if (this.repo) {
      try {
        const record = await this.repo.createFromInitiation({
          provider: method,
          merchantRequestId: response.merchantRequestId || request.merchantRequestId,
          checkoutRequestId: response.checkoutRequestId || request.checkoutRequestId,
          providerTransactionId: response.providerTransactionId,
          phoneNumber: request.phoneNumber,
          amount: request.amount,
          invoiceNumber: request.invoiceNumber,
          status: response.status as PaymentStatus,
          raw: response.raw || request.raw,
        });
        response.paymentId = record?.id;
      } catch (e) {
        console.warn('[PaymentService] Failed to persist payment initiation to repo:', e);
      }
    }

    return response;
  }

  /**
   * Process incoming callback from a provider
   */
  async processCallback(payload: any, method: PaymentMethod = 'kcb_buni'): Promise<CallbackPayload> {
    const provider = this.factory.getProvider(method);
    const callbackResult = await provider.processCallback(payload);

    if (this.repo && callbackResult.merchantRequestId) {
      try {
        await this.repo.updateFromCallback(callbackResult.merchantRequestId, {
          status: callbackResult.status,
          providerTransactionId: callbackResult.providerTransactionId,
          callbackPayload: callbackResult.raw,
        });
      } catch (e) {
        console.warn('[PaymentService] Failed to update callback status in repo:', e);
      }
    }

    return callbackResult;
  }

  /**
   * Directly create initiation record in repository
   */
  async createInitiation(payload: PaymentRequest) {
    if (!this.repo) return null;
    return this.repo.createFromInitiation({
      provider: payload.provider,
      merchantRequestId: payload.merchantRequestId,
      checkoutRequestId: payload.checkoutRequestId,
      providerTransactionId: payload.providerTransactionId,
      phoneNumber: payload.phoneNumber,
      amount: payload.amount,
      invoiceNumber: payload.invoiceNumber,
      status: payload.status,
      raw: payload.raw,
    });
  }

  /**
   * Update payment status directly
   */
  async updatePaymentStatus(
    merchantRequestId: string,
    status: PaymentStatus,
    updates?: Partial<Record<string, any>>
  ) {
    if (!this.repo || !merchantRequestId) return null;
    return this.repo.updateFromCallback(merchantRequestId, {
      status,
      ...updates,
    });
  }
}
