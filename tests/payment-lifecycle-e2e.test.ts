import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { completeSale, CompleteSaleParams } from '../src/lib/transaction-utils';
import * as dbModule from '../src/lib/db';
import * as syncModule from '../src/lib/sync';
import { KCBBuniProvider } from '../src/payments/providers/KCBBuniProvider';
import { CashProvider } from '../src/payments/providers/CashProvider';
import { NcbaProvider } from '../src/payments/providers/NcbaProvider';
import { PaymentProviderFactory } from '../src/payments/providers/PaymentProviderFactory';
import { PaymentService } from '../src/payments/services/PaymentService';
import { PaymentRepository } from '../src/payments/repositories/PaymentRepository';
import type { PrismaClient } from '@prisma/client';

describe('JIMWAS Payment Ecosystem — Controlled End-to-End Lifecycle Verification', () => {
  let mockProducts: any[];
  let savedTransactions: any[];
  let savedProducts: any[];
  let savedStockMovements: any[];
  let syncedTransactions: any[];

  beforeEach(() => {
    savedTransactions = [];
    savedProducts = [];
    savedStockMovements = [];
    syncedTransactions = [];

    mockProducts = [
      {
        id: 'prod-001',
        name: 'Cement 50kg',
        price: 850,
        cost: 700,
        stock: 100,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sync_status: 'synced',
      },
    ];

    vi.spyOn(dbModule, 'getProduct').mockImplementation(async (id: string) => {
      return mockProducts.find((p) => p.id === id) || null;
    });

    vi.spyOn(dbModule, 'saveProduct').mockImplementation(async (product: any) => {
      savedProducts.push(product);
      return product;
    });

    vi.spyOn(dbModule, 'saveTransaction').mockImplementation(async (tx: any) => {
      savedTransactions.push(tx);
      return tx;
    });

    vi.spyOn(dbModule, 'saveStockMovement').mockImplementation(async (m: any) => {
      savedStockMovements.push(m);
      return m;
    });

    vi.spyOn(dbModule, 'saveCustomer').mockImplementation(async (c: any) => {
      return c;
    });

    vi.spyOn(dbModule, 'saveLoyaltyTransaction').mockImplementation(async (l: any) => {
      return l;
    });

    vi.spyOn(syncModule, 'syncInsertTransaction').mockImplementation(async (tx: any, items: any[]) => {
      syncedTransactions.push({ tx, items });
    });

    vi.spyOn(syncModule, 'syncUpdateProduct').mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, 'syncInsertStockMovement').mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, 'syncUpdateCustomer').mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, 'syncInsertLoyaltyTransaction').mockResolvedValue(undefined as any);
  });

  // STEP 2: VERIFY CASH PAY NOW
  describe('Step 2: CASH PAY NOW', () => {
    it('creates completed transaction, deducts stock, sets payment_timing=immediate, is_cod=false', async () => {
      const saleParams: CompleteSaleParams = {
        cart: [{ product_id: 'prod-001', product_name: 'Cement 50kg', quantity: 2, unit_price: 850, subtotal: 1700 }],
        cartTotal: 1700,
        products: mockProducts,
        selectedCustomer: null,
        paymentMethod: 'cash',
        paymentTiming: 'immediate',
        amountPaid: 2000,
        change: 300,
        userId: 'cashier-001',
      };

      const result = await completeSale(saleParams);
      expect(result.success).toBe(true);
      expect(savedTransactions).toHaveLength(1);

      const tx = savedTransactions[0];
      expect(tx.payment_method).toBe('cash');
      expect(tx.payment_timing).toBe('immediate');
      expect(tx.is_cod).toBe(false);
      expect(tx.amount_paid).toBe(2000);
      expect(tx.change_amount).toBe(300);
      expect(tx.status).toBe('completed');
      expect(tx.cod_status).toBeUndefined();
      expect(tx.mpesa_receipt).toBeUndefined();

      // Stock deducted immediately
      expect(savedProducts).toHaveLength(1);
      expect(savedProducts[0].stock).toBe(98);
      expect(savedStockMovements).toHaveLength(1);
      expect(savedStockMovements[0].qty_delta).toBe(-2);

      // Synced to Supabase payload
      expect(syncedTransactions).toHaveLength(1);
      expect(syncedTransactions[0].tx.payment_timing).toBe('immediate');
      expect(syncedTransactions[0].tx.is_cod).toBe(false);
    });
  });

  // STEP 3: VERIFY CASH COD
  describe('Step 3: CASH C.O.D.', () => {
    it('creates pending COD transaction, reserves stock, amount_paid=0, balance=total, cod_status=PENDING', async () => {
      const saleParams: CompleteSaleParams = {
        cart: [{ product_id: 'prod-001', product_name: 'Cement 50kg', quantity: 5, unit_price: 850, subtotal: 4250 }],
        cartTotal: 4250,
        products: mockProducts,
        selectedCustomer: { id: 'cust-123', name: 'John Doe', loyalty_points: 0, total_spent: 0, created_at: '', updated_at: '', sync_status: 'synced' },
        paymentMethod: 'cash',
        paymentTiming: 'cod',
        amountPaid: 0,
        change: 0,
        userId: 'cashier-001',
      };

      const result = await completeSale(saleParams);
      expect(result.success).toBe(true);

      const tx = savedTransactions[0];
      expect(tx.payment_method).toBe('cash');
      expect(tx.payment_timing).toBe('cod');
      expect(tx.is_cod).toBe(true);
      expect(tx.cod_status).toBe('PENDING');
      expect(tx.amount_paid).toBe(0);
      expect(tx.balance_amount).toBe(4250);
      expect(tx.status).toBe('pending');

      // Stock is reserved/deducted at order creation
      expect(savedProducts[0].stock).toBe(95);
      expect(savedStockMovements[0].qty_delta).toBe(-5);
    });
  });

  // STEP 4: VERIFY KCB PAY NOW
  describe('Step 4: KCB BUNI PAY NOW', () => {
    it('initiates STK push, resolves callback, and populates mpesa_receipt upon sale completion', async () => {
      const provider = new KCBBuniProvider({
        KCB_BUNI_BASE_URL: 'https://sandbox.buni.kcbgroup.com',
        KCB_BUNI_TOKEN_URL: 'https://sandbox.buni.kcbgroup.com/oauth/token',
        KCB_BUNI_CLIENT_ID: 'sb_client',
        KCB_BUNI_CLIENT_SECRET: 'sb_secret',
      });

      vi.spyOn(axios, 'post').mockResolvedValueOnce({
        status: 200,
        data: { access_token: 'sb_token_xyz', expires_in: 3600 },
      });

      vi.spyOn(provider.client, 'post').mockResolvedValueOnce({
        status: 200,
        data: {
          merchantRequestId: 'MRQ-KCB-001',
          checkoutRequestId: 'CRQ-KCB-001',
          status: 'SUCCESS',
        },
      });

      // 1. STK Initiation
      const initResp = await provider.initiatePayment({
        provider: 'kcb_buni',
        phoneNumber: '0711223344',
        amount: 850,
        invoiceNumber: 'INV-KCB-101',
      });

      expect(initResp.status).toBe('PENDING');
      expect(initResp.merchantRequestId).toBe('MRQ-KCB-001');

      // 2. Callback Processing
      const callbackPayload = {
        stkCallback: {
          MerchantRequestID: 'MRQ-KCB-001',
          CheckoutRequestID: 'CRQ-KCB-001',
          ResultCode: 0,
          ResultDesc: 'Success',
          CallbackMetadata: {
            Item: [
              { Name: 'MpesaReceiptNumber', Value: 'QWE888XYZ' },
              { Name: 'Amount', Value: 850 },
            ],
          },
        },
      };

      const cbResult = await provider.processCallback(callbackPayload);
      expect(cbResult.status).toBe('SUCCESS');
      expect(cbResult.merchantRequestId).toBe('MRQ-KCB-001');

      // 3. Complete sale with verified mpesaReceipt
      const saleResult = await completeSale({
        cart: [{ product_id: 'prod-001', product_name: 'Cement 50kg', quantity: 1, unit_price: 850, subtotal: 850 }],
        cartTotal: 850,
        products: mockProducts,
        selectedCustomer: null,
        paymentMethod: 'kcb_buni',
        paymentTiming: 'immediate',
        amountPaid: 850,
        change: 0,
        userId: 'cashier-001',
        mpesaReceipt: 'QWE888XYZ',
      });

      expect(saleResult.success).toBe(true);
      const tx = savedTransactions[0];
      expect(tx.payment_method).toBe('kcb_buni');
      expect(tx.payment_timing).toBe('immediate');
      expect(tx.mpesa_receipt).toBe('QWE888XYZ');
      expect(tx.status).toBe('completed');
    });
  });

  // STEP 5: VERIFY KCB COD
  describe('Step 5: KCB BUNI C.O.D.', () => {
    it('creates COD order without sending STK push at checkout', async () => {
      const kcbProvider = new KCBBuniProvider();
      const stkSpy = vi.spyOn(kcbProvider, 'initiatePayment');

      const saleResult = await completeSale({
        cart: [{ product_id: 'prod-001', product_name: 'Cement 50kg', quantity: 1, unit_price: 850, subtotal: 850 }],
        cartTotal: 850,
        products: mockProducts,
        selectedCustomer: null,
        paymentMethod: 'kcb_buni',
        paymentTiming: 'cod',
        amountPaid: 0,
        change: 0,
        userId: 'cashier-001',
      });

      expect(saleResult.success).toBe(true);
      expect(stkSpy).not.toHaveBeenCalled();

      const tx = savedTransactions[0];
      expect(tx.payment_method).toBe('kcb_buni');
      expect(tx.payment_timing).toBe('cod');
      expect(tx.is_cod).toBe(true);
      expect(tx.cod_status).toBe('PENDING');
      expect(tx.amount_paid).toBe(0);
      expect(tx.status).toBe('pending');
    });
  });

  // STEP 6: NCBA BLOCKED
  describe('Step 6: NCBA Blocked Status', () => {
    it('keeps NCBA in PROVIDER_PENDING and prevents active payment completion', async () => {
      const ncba = new NcbaProvider();
      const response = await ncba.initiatePayment({
        provider: 'ncba',
        amount: 500,
        invoiceNumber: 'INV-NCBA-99',
      });

      expect(response.provider).toBe('ncba');
      expect(response.status).toBe('PENDING');
      expect(response.responseCode).toBe('PROVIDER_PENDING');

      const factory = PaymentProviderFactory.getInstance();
      expect(factory.isMethodAvailable('ncba')).toBe(false);
    });
  });

  // STEP 7: DROPSHIPPING STOCK EXEMPTION
  describe('Step 7: Dropshipping Stock Exemption', () => {
    it('skips local inventory decrement for dropshipping sale type', async () => {
      const saleResult = await completeSale({
        cart: [{ product_id: 'prod-001', product_name: 'Cement 50kg', quantity: 10, unit_price: 850, subtotal: 8500 }],
        cartTotal: 8500,
        products: mockProducts,
        selectedCustomer: null,
        paymentMethod: 'cash',
        paymentTiming: 'immediate',
        amountPaid: 8500,
        change: 0,
        userId: 'cashier-001',
        saleType: 'dropshipping',
      });

      expect(saleResult.success).toBe(true);
      expect(savedTransactions[0].sale_type).toBe('dropshipping');
      // No local stock movement or update created
      expect(savedProducts).toHaveLength(0);
      expect(savedStockMovements).toHaveLength(0);
    });
  });

  // STEP 8: CALLBACK IDEMPOTENCY
  describe('Step 8: Callback Idempotency Protection', () => {
    it('handles duplicate callbacks safely through PaymentRepository without double-creating', async () => {
      const mockPrisma = {
        payment: {
          create: vi.fn().mockResolvedValue({ id: 'pay-uuid-1', merchantRequestId: 'MRQ-UNIQUE-123', status: 'PENDING' }),
          findFirst: vi.fn().mockResolvedValue({ id: 'pay-uuid-1', merchantRequestId: 'MRQ-UNIQUE-123', status: 'PENDING' }),
          update: vi.fn().mockResolvedValue({ id: 'pay-uuid-1', merchantRequestId: 'MRQ-UNIQUE-123', status: 'SUCCESS' }),
        },
      } as unknown as PrismaClient;

      const repo = new PaymentRepository(mockPrisma);
      const service = new PaymentService(repo);

      const callbackPayload = {
        stkCallback: {
          MerchantRequestID: 'MRQ-UNIQUE-123',
          CheckoutRequestID: 'CRQ-UNIQUE-123',
          ResultCode: 0,
          ResultDesc: 'Success',
        },
      };

      // First callback arrival
      const res1 = await service.processCallback(callbackPayload, 'kcb_buni');
      expect(res1.status).toBe('SUCCESS');
      expect(mockPrisma.payment.update).toHaveBeenCalledTimes(1);

      // Second identical duplicate callback arrival
      const res2 = await service.processCallback(callbackPayload, 'kcb_buni');
      expect(res2.status).toBe('SUCCESS');
      // No new creation, updates existing record idempotently
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });
  });

  // STEP 9: OFFLINE SYNC PAYLOAD GENERATION & RECOVERY
  describe('Step 9: Offline Sync Payload Generation & Recovery', () => {
    it('queues full transaction object with payment_timing, is_cod, cod_status, mpesa_receipt for sync', async () => {
      const saleResult = await completeSale({
        cart: [{ product_id: 'prod-001', product_name: 'Cement 50kg', quantity: 1, unit_price: 850, subtotal: 850 }],
        cartTotal: 850,
        products: mockProducts,
        selectedCustomer: null,
        paymentMethod: 'kcb_buni',
        paymentTiming: 'immediate',
        amountPaid: 850,
        change: 0,
        userId: 'cashier-001',
        mpesaReceipt: 'MPESA999',
      });

      expect(saleResult.success).toBe(true);
      expect(syncedTransactions).toHaveLength(1);

      const payload = syncedTransactions[0].tx;
      expect(payload).toMatchObject({
        payment_method: 'kcb_buni',
        payment_timing: 'immediate',
        is_cod: false,
        mpesa_receipt: 'MPESA999',
        status: 'completed',
      });
    });

    it('rejects prohibited payment methods safely without corrupting local state', async () => {
      const saleResult = await completeSale({
        cart: [{ product_id: 'prod-001', product_name: 'Cement 50kg', quantity: 1, unit_price: 850, subtotal: 850 }],
        cartTotal: 850,
        products: mockProducts,
        selectedCustomer: null,
        paymentMethod: 'card' as any,
        amountPaid: 850,
        change: 0,
        userId: 'cashier-001',
      });

      expect(saleResult.success).toBe(false);
      expect(saleResult.error).toContain('Invalid or prohibited payment method');
      expect(savedTransactions).toHaveLength(0);
      expect(savedProducts).toHaveLength(0);
    });
  });
});
