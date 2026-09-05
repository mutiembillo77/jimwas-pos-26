import { describe, it, expect, beforeEach, vi } from 'vitest';
import { completeSale, CompleteSaleParams, getDeliveryFee } from '../src/lib/transaction-utils';
import * as dbModule from '../src/lib/db';
import * as syncModule from '../src/lib/sync';
import { buildReceiptHtml } from '../src/lib/print';
import type { Product, Customer, CartItem, Transaction } from '../src/lib/types';
import type { BusinessSettings, ReceiptSettings } from '../src/lib/settings-types';

describe('JIMWAS POS — Stage 2 Checkout Delivery Fees & Payment Accounts Test Suite', () => {
  let mockProducts: Product[];
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
        id: 'prod-paint-20l',
        name: 'Crown Vinyl Silk 20L',
        price: 9500,
        cost: 7500,
        stock: 25,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sync_status: 'synced',
      },
      {
        id: 'prod-roller',
        name: 'Paint Roller 9-inch',
        price: 450,
        cost: 280,
        stock: 40,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sync_status: 'synced',
      },
    ];

    vi.spyOn(dbModule, 'getProduct').mockImplementation(async (id: string) => {
      const live = savedProducts.find((p) => p.id === id);
      if (live) return live;
      return mockProducts.find((p) => p.id === id) || null;
    });

    vi.spyOn(dbModule, 'saveProduct').mockImplementation(async (product: any) => {
      const idx = savedProducts.findIndex((p) => p.id === product.id);
      if (idx >= 0) {
        savedProducts[idx] = product;
      } else {
        savedProducts.push(product);
      }
    });

    vi.spyOn(dbModule, 'getTransaction').mockImplementation(async (id: string) => {
      return savedTransactions.find((t) => t.id === id) || null;
    });

    vi.spyOn(dbModule, 'saveTransaction').mockImplementation(async (tx: any) => {
      const idx = savedTransactions.findIndex((t) => t.id === tx.id);
      if (idx >= 0) {
        savedTransactions[idx] = tx;
      } else {
        savedTransactions.push(tx);
      }
    });

    vi.spyOn(dbModule, 'saveStockMovement').mockImplementation(async (sm: any) => {
      savedStockMovements.push(sm);
    });

    vi.spyOn(dbModule, 'getAllTransactions').mockImplementation(async () => {
      return [...savedTransactions];
    });

    vi.spyOn(dbModule, 'saveCustomer').mockImplementation(async (c: any) => c);
    vi.spyOn(dbModule, 'saveLoyaltyTransaction').mockImplementation(async (l: any) => l);

    vi.spyOn(syncModule, 'syncInsertTransaction').mockImplementation(async (tx: any, items: any[]) => {
      syncedTransactions.push({ tx, items });
    });

    vi.spyOn(syncModule, 'syncUpdateProduct').mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, 'syncInsertStockMovement').mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, 'syncUpdateCustomer').mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, 'syncInsertLoyaltyTransaction').mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, 'getOnlineStatus').mockReturnValue(true);
  });

  const baseCustomer: Customer = {
    id: 'cust-kamau-1',
    name: 'Peter Kamau',
    phone: '0712345678',
    email: 'kamau@example.com',
    loyalty_points: 15,
    total_spent: 45000,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sync_status: 'synced',
  };

  const sampleCart: CartItem[] = [
    {
      id: 'cart-1',
      product_id: 'prod-paint-20l',
      product_name: 'Crown Vinyl Silk 20L',
      unit_price: 9500,
      quantity: 2,
      subtotal: 19000,
    },
    {
      id: 'cart-2',
      product_id: 'prod-roller',
      product_name: 'Paint Roller 9-inch',
      unit_price: 450,
      quantity: 3,
      subtotal: 1350,
    },
  ];
  // Subtotal = 19000 + 1350 = 20350

  const sampleBusiness: BusinessSettings = {
    id: 'business-default',
    name: 'Jimwas Hardware & Electricals',
    address: 'Nairobi CBD',
    phone: '0700000000',
    email: 'info@jimwashardware.co.ke',
    currency: 'KES',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const sampleReceipt: ReceiptSettings = {
    id: 'receipt-default',
    header_text: 'Thank you for shopping with Jimwas POS',
    footer_text: 'Goods once sold cannot be returned',
    show_logo: false,
    show_barcode: false,
    paper_size: '58mm',
    show_tax_breakdown: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  describe('1. Delivery Options & Exact Fee Mapping', () => {
    it('verifies standard helper maps delivery types to exact fees', () => {
      expect(getDeliveryFee('none')).toBe(0);
      expect(getDeliveryFee('to_cbd')).toBe(100);
      expect(getDeliveryFee('from_cbd_300')).toBe(300);
      expect(getDeliveryFee('from_cbd_500')).toBe(500);
      expect(getDeliveryFee(undefined)).toBe(0);
    });

    it('persists delivery_type none and delivery_fee 0 correctly', async () => {
      const res = await completeSale({
        cart: sampleCart,
        cartTotal: 20350,
        products: mockProducts,
        selectedCustomer: baseCustomer,
        paymentMethod: 'cash',
        paymentTiming: 'immediate',
        amountPaid: 20350,
        change: 0,
        userId: 'cashier-1',
        idempotencyKey: 'idemp-deliv-none',
        deliveryType: 'none',
        deliveryFee: 0,
        discount: 0,
        paymentAccount: 'CASH',
      });

      expect(res.success).toBe(true);
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx).toBeDefined();
      expect(tx.delivery_type).toBe('none');
      expect(tx.delivery_fee).toBe(0);
      expect(tx.subtotal).toBe(20350);
      expect(tx.discount).toBe(0);
      expect(tx.total_amount).toBe(20350);
    });

    it('persists delivery_type to_cbd (KES 100) correctly', async () => {
      const res = await completeSale({
        cart: sampleCart,
        cartTotal: 20450,
        products: mockProducts,
        selectedCustomer: baseCustomer,
        paymentMethod: 'cash',
        paymentTiming: 'immediate',
        amountPaid: 20450,
        change: 0,
        userId: 'cashier-1',
        idempotencyKey: 'idemp-deliv-to-cbd',
        deliveryType: 'to_cbd',
        deliveryFee: 100,
        discount: 0,
        paymentAccount: 'CASH',
      });

      expect(res.success).toBe(true);
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx).toBeDefined();
      expect(tx.delivery_type).toBe('to_cbd');
      expect(tx.delivery_fee).toBe(100);
      expect(tx.subtotal).toBe(20350);
      expect(tx.total_amount).toBe(20450);
    });

    it('persists delivery_type from_cbd_300 (KES 300) correctly', async () => {
      const res = await completeSale({
        cart: sampleCart,
        cartTotal: 20650,
        products: mockProducts,
        selectedCustomer: baseCustomer,
        paymentMethod: 'kcb_buni',
        paymentTiming: 'immediate',
        amountPaid: 20650,
        change: 0,
        userId: 'cashier-1',
        idempotencyKey: 'idemp-deliv-from-cbd-300',
        deliveryType: 'from_cbd_300',
        deliveryFee: 300,
        discount: 0,
        paymentAccount: 'MPESA',
      });

      expect(res.success).toBe(true);
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx).toBeDefined();
      expect(tx.delivery_type).toBe('from_cbd_300');
      expect(tx.delivery_fee).toBe(300);
      expect(tx.subtotal).toBe(20350);
      expect(tx.total_amount).toBe(20650);
    });

    it('persists delivery_type from_cbd_500 (KES 500) correctly', async () => {
      const res = await completeSale({
        cart: sampleCart,
        cartTotal: 20850,
        products: mockProducts,
        selectedCustomer: baseCustomer,
        paymentMethod: 'kcb_buni',
        paymentTiming: 'immediate',
        amountPaid: 20850,
        change: 0,
        userId: 'cashier-1',
        idempotencyKey: 'idemp-deliv-from-cbd-500',
        deliveryType: 'from_cbd_500',
        deliveryFee: 500,
        discount: 0,
        paymentAccount: 'KCB',
      });

      expect(res.success).toBe(true);
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx).toBeDefined();
      expect(tx.delivery_type).toBe('from_cbd_500');
      expect(tx.delivery_fee).toBe(500);
      expect(tx.subtotal).toBe(20350);
      expect(tx.total_amount).toBe(20850);
    });
  });

  describe('2. Delivery Fee Stock Non-Mutation Guarantee', () => {
    it('verifies that delivery fees do NOT decrement stock or create extra stock movements', async () => {
      const initialStockPaint = mockProducts[0].stock; // 25
      const initialStockRoller = mockProducts[1].stock; // 40

      const res = await completeSale({
        cart: sampleCart, // 2 paints, 3 rollers
        cartTotal: 20850, // 20350 + 500 delivery
        products: mockProducts,
        selectedCustomer: baseCustomer,
        paymentMethod: 'cash',
        paymentTiming: 'immediate',
        amountPaid: 20850,
        change: 0,
        userId: 'cashier-1',
        idempotencyKey: 'idemp-stock-check',
        deliveryType: 'from_cbd_500',
        deliveryFee: 500,
        discount: 0,
        paymentAccount: 'CASH',
      });

      expect(res.success).toBe(true);
      const paintAfter = savedProducts.find((p) => p.id === 'prod-paint-20l');
      const rollerAfter = savedProducts.find((p) => p.id === 'prod-roller');

      expect(paintAfter.stock).toBe(initialStockPaint - 2); // exactly 2 deducted
      expect(rollerAfter.stock).toBe(initialStockRoller - 3); // exactly 3 deducted

      // Stock movements should ONLY contain product movements, zero delivery fee entries
      expect(savedStockMovements.length).toBe(2);
      expect(savedStockMovements.every((sm) => sm.product_id !== 'delivery')).toBe(true);
      expect(savedStockMovements.map((sm) => sm.product_id)).toEqual(['prod-paint-20l', 'prod-roller']);
    });
  });

  describe('3. Payment Account Options & Persistence', () => {
    const paymentAccounts: Array<'KCB' | 'NCBA' | 'CASH' | 'MPESA'> = ['KCB', 'NCBA', 'CASH', 'MPESA'];

    paymentAccounts.forEach((account) => {
      it(`persists payment_account "${account}" cleanly on transaction record`, async () => {
        const res = await completeSale({
          cart: sampleCart,
          cartTotal: 20450,
          products: mockProducts,
          selectedCustomer: baseCustomer,
          paymentMethod: account === 'CASH' ? 'cash' : account === 'NCBA' ? 'ncba' : 'kcb_buni',
          paymentTiming: 'immediate',
          amountPaid: 20450,
          change: 0,
          userId: 'cashier-1',
          idempotencyKey: `idemp-acc-${account}`,
          deliveryType: 'to_cbd',
          deliveryFee: 100,
          discount: 0,
          paymentAccount: account,
        });

        expect(res.success).toBe(true);
        const tx = savedTransactions.find((t) => t.id === res.transactionId);
        expect(tx).toBeDefined();
        expect(tx.payment_account).toBe(account);
        expect(tx.status).toBe('completed');
      });
    });
  });

  describe('4. Total Calculation Logic Formula Verification', () => {
    it('calculates total correctly: Subtotal - Discount + Delivery Fee', async () => {
      // Cart subtotal: 20350, Discount: 350, Delivery: 300 => Total = 20300
      const res = await completeSale({
        cart: sampleCart,
        cartTotal: 20300,
        products: mockProducts,
        selectedCustomer: baseCustomer,
        paymentMethod: 'cash',
        paymentTiming: 'immediate',
        amountPaid: 20300,
        change: 0,
        userId: 'cashier-1',
        idempotencyKey: 'idemp-calc-discount-deliv',
        deliveryType: 'from_cbd_300',
        deliveryFee: 300,
        discount: 350,
        paymentAccount: 'CASH',
      });

      expect(res.success).toBe(true);
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx.subtotal).toBe(20350);
      expect(tx.discount).toBe(350);
      expect(tx.delivery_fee).toBe(300);
      expect(tx.total_amount).toBe(20300);
      expect(tx.subtotal - tx.discount + tx.delivery_fee).toBe(tx.total_amount);
    });
  });

  describe('5. Receipt / Print Representation & Historical Graceful Fallback', () => {
    it('renders Subtotal, Delivery Fee, Discount, and Payment Account on receipt HTML', () => {
      const printTx = {
        id: 'tx-print-demo',
        items: [
          {
            id: 'item-1',
            product_id: 'prod-paint-20l',
            product_name: 'Crown Vinyl Silk 20L',
            quantity: 1,
            unit_price: 9500,
            subtotal: 9500,
          },
        ],
        total_amount: 9800,
        amount_paid: 9800,
        change_amount: 0,
        payment_method: 'kcb_buni' as const,
        payment_account: 'MPESA' as const,
        delivery_type: 'from_cbd_300' as const,
        delivery_fee: 300,
        subtotal: 9500,
        discount: 0,
        created_at: '2026-09-05T12:00:00Z',
      };

      const html = buildReceiptHtml({
        business: sampleBusiness,
        receipt: sampleReceipt,
        transaction: printTx,
      });

      expect(html).toContain('Subtotal:');
      expect(html).toContain('KES 9,500');
      expect(html).toContain('Delivery:');
      expect(html).toContain('KES 300');
      expect(html).toContain('Payment Account:');
      expect(html).toContain('MPESA');
      expect(html).toContain('TOTAL:');
      expect(html).toContain('KES 9,800');
    });

    it('renders gracefully with fallback when historical transaction has undefined delivery and payment_account', () => {
      const historicalTx = {
        id: 'tx-hist-legacy',
        items: [
          {
            id: 'item-1',
            product_id: 'prod-roller',
            product_name: 'Paint Roller 9-inch',
            quantity: 1,
            unit_price: 450,
            subtotal: 450,
          },
        ],
        total_amount: 450,
        amount_paid: 500,
        change_amount: 50,
        payment_method: 'cash' as const,
        created_at: '2026-08-15T10:00:00Z',
      };

      const html = buildReceiptHtml({
        business: sampleBusiness,
        receipt: sampleReceipt,
        transaction: historicalTx,
      });

      // Should not throw and should display standard totals and fallback payment account
      expect(html).toContain('TOTAL:');
      expect(html).toContain('KES 450');
      expect(html).toContain('Payment Account:');
      expect(html).toContain('CASH'); // fallback to uppercase method
      expect(html).not.toContain('undefined');
    });
  });

  describe('6. Synchronization & Whitelist Integrity', () => {
    it('passes new delivery and payment account fields to sync queue', async () => {
      const res = await completeSale({
        cart: sampleCart,
        cartTotal: 20650,
        products: mockProducts,
        selectedCustomer: baseCustomer,
        paymentMethod: 'kcb_buni',
        paymentTiming: 'immediate',
        amountPaid: 20650,
        change: 0,
        userId: 'cashier-1',
        idempotencyKey: 'idemp-sync-check',
        deliveryType: 'from_cbd_300',
        deliveryFee: 300,
        discount: 0,
        paymentAccount: 'MPESA',
      });

      expect(res.success).toBe(true);
      expect(syncedTransactions.length).toBe(1);
      const synced = syncedTransactions[0].tx;
      expect(synced.delivery_type).toBe('from_cbd_300');
      expect(synced.delivery_fee).toBe(300);
      expect(synced.subtotal).toBe(20350);
      expect(synced.discount).toBe(0);
      expect(synced.payment_account).toBe('MPESA');
    });
  });

  describe('7. Preservation of Stage 1 Idempotency Mechanisms', () => {
    it('deduplicates repeat submission with identical idempotencyKey while preserving delivery and account', async () => {
      const payload: CompleteSaleParams = {
        cart: sampleCart,
        cartTotal: 20450,
        products: mockProducts,
        selectedCustomer: baseCustomer,
        paymentMethod: 'cash',
        paymentTiming: 'immediate',
        amountPaid: 20450,
        change: 0,
        userId: 'cashier-1',
        idempotencyKey: 'idemp-stage2-dedup-test',
        deliveryType: 'to_cbd',
        deliveryFee: 100,
        discount: 0,
        paymentAccount: 'CASH',
      };

      const firstAttempt = await completeSale(payload);
      expect(firstAttempt.success).toBe(true);
      expect(savedTransactions.length).toBe(1);

      // Repeat attempt with identical idempotencyKey
      const secondAttempt = await completeSale(payload);
      expect(secondAttempt.success).toBe(true);
      expect(secondAttempt.transactionId).toBe(firstAttempt.transactionId);

      // No second transaction or duplicate stock movement
      expect(savedTransactions.length).toBe(1);
      expect(savedStockMovements.length).toBe(2); // strictly 2 products
    });
  });
});
