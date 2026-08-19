import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { KCBBuniProvider, formatPhoneNumber } from '../src/payments/providers/KCBBuniProvider';
import { NcbaProvider } from '../src/payments/providers/NcbaProvider';
import { CashProvider } from '../src/payments/providers/CashProvider';
import { PaymentProviderFactory } from '../src/payments/providers/PaymentProviderFactory';
import { PaymentService } from '../src/payments/services/PaymentService';
import { isValidPaymentMethod, getPaymentDisplayName, isProviderActive } from '../src/types/payment';
import { migrateTransactionRecord, migrateTransactionBatch } from '../scripts/migrate-payment-methods';

describe('JIMWAS Payment Ecosystem - Core Types & Configs', () => {
  it('should validate allowed payment methods correctly', () => {
    expect(isValidPaymentMethod('cash')).toBe(true);
    expect(isValidPaymentMethod('kcb_buni')).toBe(true);
    expect(isValidPaymentMethod('ncba')).toBe(true);

    // Prohibited methods
    expect(isValidPaymentMethod('card')).toBe(false);
    expect(isValidPaymentMethod('mpesa')).toBe(false);
    expect(isValidPaymentMethod('cod')).toBe(false);
    expect(isValidPaymentMethod('paypal')).toBe(false);
  });

  it('should return display names and provider active states', () => {
    expect(getPaymentDisplayName('cash')).toBe('Physical Cash');
    expect(getPaymentDisplayName('kcb_buni')).toBe('KCB BUNI STK (MPESAEXPRESS)');
    expect(getPaymentDisplayName('ncba')).toBe('NCBA');

    expect(isProviderActive('cash')).toBe(true);
    expect(isProviderActive('kcb_buni')).toBe(true);
    expect(isProviderActive('ncba')).toBe(false); // Pending
  });
});

describe('JIMWAS Payment Ecosystem - Providers', () => {
  describe('Phone Number Normalization', () => {
    it('formats local Kenyan numbers to 254 format', () => {
      expect(formatPhoneNumber('0712345678')).toBe('254712345678');
      expect(formatPhoneNumber('0112345678')).toBe('254112345678');
      expect(formatPhoneNumber('712345678')).toBe('254712345678');
      expect(formatPhoneNumber('254712345678')).toBe('254712345678');
    });
  });

  describe('KCBBuniProvider', () => {
    let provider: KCBBuniProvider;

    beforeEach(() => {
      provider = new KCBBuniProvider({
        KCB_BUNI_BASE_URL: 'https://kcb.test',
        KCB_BUNI_TOKEN_URL: 'https://kcb.test/oauth/token',
        KCB_BUNI_CLIENT_ID: 'test_client_id',
        KCB_BUNI_CLIENT_SECRET: 'test_client_secret',
        KCB_BUNI_CALLBACK_URL: 'https://pos.test/callback',
      });
    });

    it('should initiate STK push successfully', async () => {
      vi.spyOn(axios, 'post').mockResolvedValueOnce({
        status: 200,
        data: { access_token: 'valid_token_123', expires_in: 3600 },
      });

      vi.spyOn(provider.client, 'post').mockResolvedValueOnce({
        status: 200,
        data: {
          merchantRequestId: 'MRQ-999',
          checkoutRequestId: 'CRQ-888',
          transactionReference: 'TRX-777',
          status: 'SUCCESS',
          message: 'STK push accepted',
        },
      });

      const response = await provider.initiatePayment({
        provider: 'kcb_buni',
        phoneNumber: '0712345678',
        amount: 500,
        invoiceNumber: 'INV-001',
      });

      expect(response.provider).toBe('kcb_buni');
      expect(response.status).toBe('PENDING');
      expect(response.merchantRequestId).toBe('MRQ-999');
      expect(response.checkoutRequestId).toBe('CRQ-888');
    });

    it('should parse STK push callback correctly', async () => {
      const callbackData = {
        stkCallback: {
          MerchantRequestID: 'MRQ-999',
          CheckoutRequestID: 'CRQ-888',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 500 },
              { Name: 'MpesaReceiptNumber', Value: 'QWE123RTY' },
            ],
          },
        },
      };

      const result = await provider.processCallback(callbackData);
      expect(result.merchantRequestId).toBe('MRQ-999');
      expect(result.status).toBe('SUCCESS');
      expect(result.resultCode).toBe(0);
    });
  });

  describe('NcbaProvider', () => {
    it('should return PENDING status with appropriate message', async () => {
      const provider = new NcbaProvider();
      const response = await provider.initiatePayment({
        provider: 'ncba',
        amount: 1000,
        invoiceNumber: 'INV-NCBA-001',
      });

      expect(response.provider).toBe('ncba');
      expect(response.status).toBe('PENDING');
      expect(response.responseCode).toBe('PROVIDER_PENDING');
      expect(response.responseMessage).toContain('pending activation');
    });
  });

  describe('CashProvider', () => {
    it('should return immediate SUCCESS with cashier tracking', async () => {
      const provider = new CashProvider();
      const response = await provider.initiatePayment({
        provider: 'cash',
        amount: 2500,
        invoiceNumber: 'INV-CASH-001',
        cashierId: 'user-cashier-1',
        cashierName: 'Jane Doe',
      });

      expect(response.provider).toBe('cash');
      expect(response.status).toBe('SUCCESS');
      expect(response.responseCode).toBe('00');
      expect(response.providerTransactionId).toContain('CASH-');
      expect(response.raw.cashierId).toBe('user-cashier-1');
    });
  });

  describe('PaymentProviderFactory', () => {
    it('should return provider instances correctly via singleton', () => {
      const factory = PaymentProviderFactory.getInstance();
      expect(factory.getProvider('cash')).toBeInstanceOf(CashProvider);
      expect(factory.getProvider('kcb_buni')).toBeInstanceOf(KCBBuniProvider);
      expect(factory.getProvider('ncba')).toBeInstanceOf(NcbaProvider);

      expect(factory.isMethodAvailable('cash')).toBe(true);
      expect(factory.isMethodAvailable('kcb_buni')).toBe(true);
      expect(factory.isMethodAvailable('ncba')).toBe(false);
    });

    it('should throw on unsupported payment methods', () => {
      const factory = PaymentProviderFactory.getInstance();
      expect(() => factory.getProvider('card' as any)).toThrow();
      expect(() => factory.getProvider('mpesa' as any)).toThrow();
    });
  });
});

describe('JIMWAS Payment Ecosystem - PaymentService', () => {
  it('should handle COD orders without initiating external payment', async () => {
    const service = new PaymentService();
    const response = await service.initiatePayment({
      provider: 'cash',
      timing: 'cod',
      amount: 1500,
      invoiceNumber: 'INV-COD-101',
    });

    expect(response.timing).toBe('cod');
    expect(response.status).toBe('PENDING');
    expect(response.responseCode).toBe('COD_PENDING');
  });

  it('should reject invalid or prohibited payment methods', async () => {
    const service = new PaymentService();
    const response = await service.initiatePayment({
      provider: 'card' as any,
      amount: 1500,
      invoiceNumber: 'INV-INVALID-101',
    });

    expect(response.status).toBe('FAILED');
    expect(response.responseCode).toBe('INVALID_METHOD');
  });
});

describe('JIMWAS Payment Ecosystem - Migration Utilities', () => {
  it('should correctly migrate legacy transaction records', () => {
    const mpesaTx = { id: 'tx-1', payment_method: 'mpesa' };
    const { updatedTx: mpesaResult } = migrateTransactionRecord(mpesaTx);
    expect(mpesaResult.payment_method).toBe('kcb_buni');
    expect(mpesaResult.payment_timing).toBe('immediate');

    const codTx = { id: 'tx-2', payment_method: 'cod' };
    const { updatedTx: codResult } = migrateTransactionRecord(codTx);
    expect(codResult.payment_method).toBe('cash');
    expect(codResult.payment_timing).toBe('cod');
    expect(codResult.is_cod).toBe(true);
    expect(codResult.cod_status).toBe('PENDING');

    const cardTx = { id: 'tx-3', payment_method: 'card' };
    const { updatedTx: cardResult, warning } = migrateTransactionRecord(cardTx);
    expect(cardResult.payment_method).toBe('cash');
    expect(warning).toContain('Legacy \'card\' payment method migrated');
  });

  it('should process batch transaction migrations', () => {
    const batch = [
      { id: 'tx-1', payment_method: 'mpesa' },
      { id: 'tx-2', payment_method: 'cod' },
      { id: 'tx-3', payment_method: 'cash' },
    ];
    const result = migrateTransactionBatch(batch);
    expect(result.migratedCount).toBe(2);
    expect(result.skippedCount).toBe(1);
  });
});
