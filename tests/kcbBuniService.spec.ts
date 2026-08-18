import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { KcbBuniMpesaService } from '../src/payments/providers/KcbBuniMpesaService';

describe('KcbBuniMpesaService', () => {
  let service: KcbBuniMpesaService;

  beforeEach(() => {
    service = new KcbBuniMpesaService({
      KCB_BUNI_BASE_URL: 'https://kcb.example',
      KCB_BUNI_TOKEN_URL: 'https://kcb.example/oauth/token',
      KCB_BUNI_CLIENT_ID: 'id',
      KCB_BUNI_CLIENT_SECRET: 'secret',
      KCB_BUNI_CALLBACK_URL: 'https://example.com/callback',
    });
  });

  it('should initiate STK Push successfully', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { access_token: 'tok', expires_in: 3600 },
    });

    vi.spyOn(service.client, 'post').mockResolvedValue({
      status: 200,
      data: {
        merchantRequestId: 'MCR123',
        checkoutRequestId: 'CHK123',
        transactionReference: 'TRX123',
        status: 'SUCCESS',
        message: 'Request accepted',
      },
    });

    const req = {
      phoneNumber: '254700123456',
      amount: '100',
      invoiceNumber: 'KCBTILLNO-JIMWAS001',
      sharedShortCode: true,
      callbackUrl: 'https://example.com/callback',
      transactionDescription: 'Payment for goods purchased',
    };

    const resp = await service.initiatePayment(req);
    expect(resp.merchantRequestId).toBe('MCR123');
    expect(resp.status).toBe('PENDING');
  });

  it('should handle failed authentication', async () => {
    vi.spyOn(axios, 'post').mockRejectedValue({
      response: { status: 401, data: { error: 'invalid_client' } },
    });

    const req = {
      phoneNumber: '254700123456',
      amount: '100',
      invoiceNumber: 'KCBTILLNO-JIMWAS001',
      sharedShortCode: true,
      callbackUrl: 'https://example.com/callback',
      transactionDescription: 'Payment for goods purchased',
    };

    const resp = await service.initiatePayment(req);
    expect(resp.status).toBe('FAILED');
  });
});
