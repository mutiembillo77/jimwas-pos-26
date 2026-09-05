import { generateId, getProduct, getTransaction, saveProduct, saveTransaction, saveLoyaltyTransaction, saveStockMovement, saveCustomer } from './db';
import { syncInsertTransaction, syncUpdateProduct, syncInsertStockMovement, syncUpdateCustomer, syncInsertLoyaltyTransaction } from './sync';
import type { Product, Customer, CartItem, SaleType } from './types';
import { PaymentMethod, PaymentTiming, isValidPaymentMethod } from '../types/payment';
import { ACTIVE_FINANCIAL_ENV, type FinancialEnvironment } from './environment';

const LOYALTY_POINTS_PER_SHILLING = 100;

// Serialize sale writes so rapid checkouts cannot calculate stock from the same stale snapshot.
let saleWriteQueue: Promise<void> = Promise.resolve();

export interface CompleteSaleParams {
  cart: CartItem[];
  cartTotal: number;
  products: Product[];
  selectedCustomer: Customer | null;
  paymentMethod: PaymentMethod;
  paymentTiming?: PaymentTiming;
  amountPaid: number;
  change: number;
  userId: string;
  mpesaReceipt?: string;
  paymentAccountId?: string | null;
  paymentAccountName?: string | null;
  paymentAccountPaybill?: string | null;
  paymentAccountNumber?: string | null;
  saleType?: SaleType;
  depositAmount?: number;
  balanceAmount?: number;
  /** Financial environment override. Defaults to ACTIVE_FINANCIAL_ENV from runtime config.
   *  Must never be set to PRODUCTION by client-side code in a sandbox runtime. */
  environment?: FinancialEnvironment;
  /** Stable client-side idempotency key for the logical checkout transaction */
  idempotencyKey?: string;
  /** Explicit transaction ID override (aliases idempotencyKey) */
  transactionId?: string;
  /** Selected delivery type (e.g. none, to_cbd, from_cbd_300, from_cbd_500) */
  deliveryType?: 'none' | 'to_cbd' | 'from_cbd_300' | 'from_cbd_500' | string;
  /** Explicit delivery fee amount (defaults according to deliveryType) */
  deliveryFee?: number;
  /** Transaction-level discount */
  discount?: number;
  /** Explicit payment account (KCB, NCBA, CASH, MPESA) */
  paymentAccount?: 'KCB' | 'NCBA' | 'CASH' | 'MPESA' | string;
}

export const DELIVERY_FEES: Record<string, number> = {
  none: 0,
  to_cbd: 100,
  from_cbd_300: 300,
  from_cbd_500: 500,
};

export function getDeliveryFee(deliveryType?: string): number {
  if (!deliveryType) return 0;
  return DELIVERY_FEES[deliveryType] ?? 0;
}

export interface CompleteSaleResult {
  success: boolean;
  transactionId: string;
  error?: string;
}

export async function completeSale({
  cart,
  cartTotal,
  products,
  selectedCustomer,
  paymentMethod: method,
  paymentTiming = 'immediate',
  amountPaid,
  change,
  userId,
  mpesaReceipt,
  paymentAccountId = null,
  paymentAccountName = null,
  paymentAccountPaybill = null,
  paymentAccountNumber = null,
  saleType = 'standard',
  depositAmount = 0,
  balanceAmount = 0,
  environment = ACTIVE_FINANCIAL_ENV,
  idempotencyKey,
  transactionId,
  deliveryType = 'none',
  deliveryFee,
  discount = 0,
  paymentAccount,
}: CompleteSaleParams): Promise<CompleteSaleResult> {
  const previousSale = saleWriteQueue;
  let releaseSale!: () => void;
  saleWriteQueue = new Promise<void>((resolve) => { releaseSale = resolve; });
  await previousSale;

  try {
    // Validate allowed payment method
    if (!isValidPaymentMethod(method)) {
      return {
        success: false,
        transactionId: '',
        error: `Invalid or prohibited payment method: "${method}". Only kcb_buni, ncba, and cash are supported.`,
      };
    }

    const txId = idempotencyKey || transactionId || generateId();

    // Idempotency check: If this transaction has already been committed, reuse the canonical sale
    // without duplicating inventory deductions, loyalty points, or ledger sync entries.
    const existingTransaction = await getTransaction(txId);
    if (existingTransaction) {
      return { success: true, transactionId: existingTransaction.id };
    }

    const isCod = paymentTiming === 'cod';
    const now = new Date().toISOString();

    const itemSubtotal = cart.reduce((sum, item) => sum + item.subtotal, 0);
    const resolvedDeliveryFee = deliveryFee !== undefined ? deliveryFee : getDeliveryFee(deliveryType);
    const resolvedDiscount = discount || 0;

    // Resolve designated payment account
    const resolvedPaymentAccount = paymentAccount || (
      method === 'cash' ? 'CASH' :
      method === 'kcb_buni' ? 'MPESA' :
      method === 'ncba' ? 'NCBA' :
      paymentAccountName?.toUpperCase().includes('KCB') ? 'KCB' :
      'CASH'
    );

    // Build transaction items with deterministic IDs
    const items = cart.map((item, index) => ({
      id: `${txId}-item-${item.product_id || index}`,
      transaction_id: txId,
      product_id: item.product_id,
      product_name: item.product_name,
      quantity: item.quantity,
      unit_price: item.unit_price,
      subtotal: item.subtotal,
    }));

    // Create transaction record
    const transaction = {
      id: txId,
      idempotency_key: idempotencyKey || txId,
      customer_id: selectedCustomer?.id,
      total_amount: cartTotal,
      amount_paid: isCod ? 0 : amountPaid,
      change_amount: isCod ? 0 : change,
      payment_method: method,
      payment_timing: paymentTiming,
      is_cod: isCod,
      payment_account_id: paymentAccountId,
      payment_account_name: paymentAccountName,
      payment_account_paybill: paymentAccountPaybill,
      payment_account_number: paymentAccountNumber,
      payment_account: resolvedPaymentAccount,
      delivery_type: deliveryType,
      delivery_fee: resolvedDeliveryFee,
      discount: resolvedDiscount,
      subtotal: itemSubtotal,
      status: isCod ? 'pending' as const : 'completed' as const,
      created_at: now,
      sync_status: 'pending' as const,
      items,
      sale_type: saleType,
      deposit_amount: depositAmount,
      balance_amount: isCod ? cartTotal : balanceAmount,
      cod_status: isCod ? 'PENDING' as const : undefined,
      mpesa_receipt: method === 'kcb_buni' ? mpesaReceipt : undefined,
      // Immutable environment classifier — stamped at creation from trusted runtime config.
      // Cannot be changed after creation. Prevents sandbox/production data mixing.
      environment,
    };
    // COD orders may be created for walk-in customers or customers without a phone.
    // Delivery contact details can be added later from Delivery Management.

    // Save transaction locally and queue for sync
    await saveTransaction(transaction);
    await syncInsertTransaction(transaction, items);

    // Supplier-fulfilled dropship orders do not deduct local stock until supplier confirmation.
    if (saleType !== 'dropshipping') {
      // Update product stock and create stock movements
      for (const item of cart) {
        const product = await getProduct(item.product_id) || products.find(p => p.id === item.product_id);
        if (product) {
          const newStock = Math.max(0, product.stock - item.quantity);
          const updated = {
            ...product,
            stock: newStock,
            updated_at: now,
            sync_status: 'pending' as const,
          };
          await saveProduct(updated);
          await syncUpdateProduct(updated);

          const noteSuffix = mpesaReceipt ? ` - MPESA:${mpesaReceipt}` : '';
          const movement = {
            id: `${txId}-sm-${product.id}`,
            product_id: product.id,
            qty_delta: -item.quantity,
            reason: 'sale' as const,
            note: `Sale ${transaction.id}${noteSuffix}`,
            balance_after: newStock,
            reference_type: 'sale' as const,
            reference_id: transaction.id,
            created_at: now,
            created_by: userId || 'system',
            sync_status: 'pending' as const,
          };
          await saveStockMovement(movement);
          await syncInsertStockMovement(movement);
        }
      }
    }

    // Update customer loyalty if applicable
    const loyaltyPointsToEarn = Math.floor(cartTotal / LOYALTY_POINTS_PER_SHILLING);
    if (selectedCustomer && loyaltyPointsToEarn > 0) {
      const updatedCustomer = {
        ...selectedCustomer,
        loyalty_points: selectedCustomer.loyalty_points + loyaltyPointsToEarn,
        total_spent: selectedCustomer.total_spent + cartTotal,
        updated_at: now,
        sync_status: 'pending' as const,
      };
      await saveCustomer(updatedCustomer);
      syncUpdateCustomer(updatedCustomer);

      const loyaltyTx = {
        id: `${txId}-loyalty`,
        customer_id: selectedCustomer.id,
        points: loyaltyPointsToEarn,
        transaction_type: 'earned' as const,
        source: 'purchase',
        reference_id: transaction.id,
        created_at: now,
        sync_status: 'pending' as const,
      };
      await saveLoyaltyTransaction(loyaltyTx);
      syncInsertLoyaltyTransaction(loyaltyTx);
    }

    return { success: true, transactionId: transaction.id };
  } finally {
    releaseSale();
  }
}

// Validation helpers
export function validatePhoneNumber(phone: string): { valid: boolean; error?: string } {
  const cleaned = phone.replace(/\D/g, '');
  
  // Valid Kenyan mobile prefixes (9 digits after country code 254)
  // Format: 0 + [2-digit prefix] + [7-digit subscriber number] = 10 total digits
  // Safaricom: 100-108 (older), 110-119, 700-729, 740-743, 745-746, 748, 757-759, 768-769, 790-799
  // Airtel: 100-108, 730-739, 750-756, 762, 767, 780-789
  // Other carriers: 010-019, 050-059, 070-079, 080-089
  // Including all 01X and 05X prefixes for other carriers
  const validPrefixPattern = /^0(?:1[0-9]|5[0-9]|7[0-9]{2}|8[0-9]{2})\d{7}$/;
  const validIntlPrefixPattern = /^254(?:1[0-9]|5[0-9]|7[0-9]{2}|8[0-9]{2})\d{7}$/;
  
  // Local format: 0XXXXXXXXX (10 digits)
  if (cleaned.length === 10) {
    if (!validPrefixPattern.test(cleaned)) {
      return { valid: false, error: 'Invalid Kenyan phone number' };
    }
    return { valid: true };
  }
  
  // International format: 254XXXXXXXXX (12 digits)
  if (cleaned.length === 12) {
    if (!validIntlPrefixPattern.test(cleaned)) {
      return { valid: false, error: 'Invalid Kenyan phone number' };
    }
    return { valid: true };
  }
  
  // Support +254 format (count without the +)
  if (phone.startsWith('+254') && cleaned.length === 12) {
    if (!validIntlPrefixPattern.test(cleaned)) {
      return { valid: false, error: 'Invalid Kenyan phone number' };
    }
    return { valid: true };
  }
  
  return { valid: false, error: 'Phone must be 10 digits (0XXXXXXXXX) or 12 digits (254XXXXXXXXX)' };
}

export function validateEmail(email: string): { valid: boolean; error?: string } {
  if (!email) return { valid: true }; // Email is optional
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { valid: false, error: 'Invalid email format' };
  }
  return { valid: true };
}

export function validatePrice(price: string): { valid: boolean; value?: number; error?: string } {
  const value = parseFloat(price);
  if (isNaN(value) || value < 0) {
    return { valid: false, error: 'Price must be a positive number' };
  }
  return { valid: true, value };
}

export function validateStock(stock: string): { valid: boolean; value?: number; error?: string } {
  const value = parseInt(stock, 10);
  if (isNaN(value) || value < 0) {
    return { valid: false, error: 'Stock must be a non-negative integer' };
  }
  return { valid: true, value };
}

// Sanitize input to prevent XSS
export function sanitizeInput(input: string): string {
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .trim();
}

// Debounce helper for search inputs
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}
