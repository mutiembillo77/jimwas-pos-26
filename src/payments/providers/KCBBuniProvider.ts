import axios, { AxiosInstance } from 'axios';
import qs from 'qs';
import { PaymentProvider } from './PaymentProvider';
import { PaymentRequest } from '../dto/PaymentRequest';
import { PaymentResponse, TransactionStatus } from '../dto/PaymentResponse';
import { CallbackPayload } from '../dto/CallbackPayload';

type TokenCache = { token: string; expiresAt: number } | null;

export interface KCBBuniConfig {
  KCB_BUNI_BASE_URL?: string;
  KCB_BUNI_TOKEN_URL?: string;
  KCB_BUNI_CLIENT_ID?: string;
  KCB_BUNI_CLIENT_SECRET?: string;
  KCB_BUNI_SHORT_CODE?: string;
  KCB_BUNI_CALLBACK_URL?: string;
  KCB_BUNI_TIMEOUT?: string | number;
}

/**
 * Format phone number to international Kenyan format (254XXXXXXXXX)
 */
export function formatPhoneNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('254') && cleaned.length === 12) {
    return cleaned;
  }
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return `254${cleaned.slice(1)}`;
  }
  if (cleaned.length === 9) {
    return `254${cleaned}`;
  }
  return cleaned;
}

/**
 * KCB BUNI STK Push Provider (MPESAEXPRESS)
 */
export class KCBBuniProvider implements PaymentProvider {
  public client: AxiosInstance;
  private tokenCache: TokenCache = null;

  private baseUrl: string;
  private tokenUrl: string;
  private clientId: string;
  private clientSecret: string;
  private shortCode?: string;
  private callbackUrl: string;
  private timeout: number;

  constructor(config?: KCBBuniConfig) {
    const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>;
    this.baseUrl = config?.KCB_BUNI_BASE_URL || env.KCB_BUNI_BASE_URL || 'https://uat.buni.kcbgroup.com';
    this.tokenUrl = config?.KCB_BUNI_TOKEN_URL || env.KCB_BUNI_TOKEN_URL || `${this.baseUrl}/oauth/token`;
    this.clientId = config?.KCB_BUNI_CLIENT_ID || env.KCB_BUNI_CLIENT_ID || '';
    this.clientSecret = config?.KCB_BUNI_CLIENT_SECRET || env.KCB_BUNI_CLIENT_SECRET || '';
    this.shortCode = config?.KCB_BUNI_SHORT_CODE || env.KCB_BUNI_SHORT_CODE;
    this.callbackUrl = config?.KCB_BUNI_CALLBACK_URL || env.KCB_BUNI_CALLBACK_URL || '';
    this.timeout = Number(config?.KCB_BUNI_TIMEOUT || env.KCB_BUNI_TIMEOUT || 10000);

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 5000) {
      return this.tokenCache.token;
    }

    try {
      const resp = await axios.post(
        this.tokenUrl,
        qs.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'client_credentials',
        }),
        {
          timeout: this.timeout,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
      );

      const data = resp.data;
      if (!data || !data.access_token) {
        throw new Error('Token response missing access_token');
      }
      const expiresIn = Number(data.expires_in || 3600);
      this.tokenCache = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
      return data.access_token;
    } catch (err: any) {
      const msg = err?.response?.data || err?.message || 'Token fetch failed';
      throw new Error(`KCB token error: ${JSON.stringify(msg)}`);
    }
  }

  private buildStkPayload(request: PaymentRequest) {
    const formattedPhone = request.phoneNumber ? formatPhoneNumber(request.phoneNumber) : '';
    return {
      phoneNumber: formattedPhone,
      amount: request.amount,
      invoiceNumber: request.invoiceNumber,
      sharedShortCode: !!request.sharedShortCode,
      orgShortCode: request.orgShortCode || this.shortCode || '',
      orgPassKey: request.orgPassKey || '',
      callbackUrl: request.callbackUrl || this.callbackUrl,
      transactionDescription: request.transactionDescription || 'Jimwas POS Payment',
      metadata: request.metadata || {},
    };
  }

  public async initiatePayment(request: PaymentRequest): Promise<PaymentResponse> {
    try {
      if (!request.phoneNumber) {
        return {
          provider: 'kcb_buni',
          status: 'FAILED',
          responseCode: 'INVALID_PHONE',
          responseMessage: 'Phone number is required for KCB BUNI STK push',
        };
      }

      const token = await this.getToken();
      const payload = this.buildStkPayload(request);
      const resp = await this.client.post('/stk-push', payload, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = resp.data;

      const response: PaymentResponse = {
        provider: 'kcb_buni',
        providerTransactionId: data.transactionReference || data.transactionId || undefined,
        merchantRequestId: data.merchantRequestId || undefined,
        checkoutRequestId: data.checkoutRequestId || undefined,
        responseCode: data.responseCode || data.code || undefined,
        responseMessage: data.responseMessage || data.message || 'initiated',
        status: (data.status === 'SUCCESS' ? 'PENDING' : 'FAILED') as TransactionStatus,
        raw: data,
      };

      return response;
    } catch (err: any) {
      const code = err?.code || err?.response?.status;
      const body = err?.response?.data || err?.message;
      return {
        provider: 'kcb_buni',
        status: 'FAILED',
        responseCode: String(code || 'UNKNOWN'),
        responseMessage: typeof body === 'string' ? body : JSON.stringify(body),
        raw: body,
      };
    }
  }

  public async processCallback(payload: any): Promise<CallbackPayload> {
    const receivedAt = new Date().toISOString();
    const body = payload?.body || payload;
    const stkCallback = body.stkCallback || body;

    if (!stkCallback) {
      throw new Error('Invalid callback: missing stkCallback payload');
    }

    const merchantRequestId: string = stkCallback.MerchantRequestID || stkCallback.merchantRequestId;
    const checkoutRequestId: string = stkCallback.CheckoutRequestID || stkCallback.checkoutRequestId;
    const resultCode = Number(stkCallback.ResultCode ?? stkCallback.resultCode ?? -1);
    const resultDesc = stkCallback.ResultDesc || stkCallback.resultDesc || '';
    const callbackMetadata = stkCallback.CallbackMetadata || stkCallback.callbackMetadata || {};

    if (!merchantRequestId) {
      throw new Error('Invalid callback: missing MerchantRequestID');
    }

    const status: TransactionStatus = resultCode === 0 ? 'SUCCESS' : 'FAILED';

    const normalized: CallbackPayload = {
      provider: 'kcb_buni',
      merchantRequestId,
      checkoutRequestId,
      status,
      resultCode,
      resultDesc,
      callbackMetadata,
      raw: stkCallback,
      receivedAt,
    };

    return normalized;
  }

  public async validateTransaction(transactionId: string): Promise<TransactionStatus> {
    try {
      const token = await this.getToken();
      const resp = await this.client.get(`/transactions/${encodeURIComponent(transactionId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = resp.data;
      const status = (data.status === 'SUCCESS' ? 'SUCCESS' : data.status === 'PENDING' ? 'PENDING' : 'FAILED') as TransactionStatus;
      return status;
    } catch (err) {
      return 'FAILED';
    }
  }

  public async getTransactionStatus(transactionId: string): Promise<PaymentResponse> {
    try {
      const token = await this.getToken();
      const resp = await this.client.get(`/transactions/${encodeURIComponent(transactionId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = resp.data;
      return {
        provider: 'kcb_buni',
        providerTransactionId: transactionId,
        responseCode: data.code || '0',
        responseMessage: data.message || '',
        status: (data.status === 'SUCCESS' ? 'SUCCESS' : data.status === 'PENDING' ? 'PENDING' : 'FAILED') as TransactionStatus,
        raw: data,
      };
    } catch (err: any) {
      const body = err?.response?.data || err?.message;
      return {
        provider: 'kcb_buni',
        providerTransactionId: transactionId,
        status: 'FAILED',
        responseMessage: typeof body === 'string' ? body : JSON.stringify(body),
        raw: body,
      };
    }
  }
}

// Re-export alias for backward compatibility
export const KcbBuniMpesaService = KCBBuniProvider;
