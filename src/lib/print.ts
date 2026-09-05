import { BusinessSettings, ReceiptSettings } from './settings-types';
import type { AuthoritativeDashboardKPIs, DailyTransactionSummary } from './reporting';
import type { Customer, Product, Transaction } from './types';

export interface PrintTransaction {
  id: string;
  items: Array<{
    product_name: string;
    quantity: number;
    unit_price: number;
    subtotal: number;
  }>;
  total_amount: number;
  amount_paid: number;
  change_amount: number;
  payment_method: string;
  payment_account_id?: string | null;
  payment_account_name?: string | null;
  payment_account_paybill?: string | null;
  payment_account_number?: string | null;
  payment_account?: string;
  delivery_type?: string;
  delivery_fee?: number;
  discount?: number;
  subtotal?: number;
  created_at: string;
  customer_name?: string;
  customer_phone?: string;
  cashier_name?: string;
  mpesa_receipt?: string;
}

interface PrintOptions {
  business: BusinessSettings;
  receipt: ReceiptSettings;
  transaction: PrintTransaction;
}

const RECEIPT_HISTORY_KEY = 'jimwas_receipt_history';
const MAX_RECEIPT_HISTORY = 100;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Privacy helper to mask customer phone numbers on receipts.
 *
 * Examples:
 *   0712345678 -> 07XXXXXX78
 *   0798765400 -> 07XXXXXX00
 *   0112345600 -> 01XXXXXX00
 *   +254712345678 -> +254 7XXXXXX78
 *
 * Rules:
 * - If phone is empty/null/undefined -> returns null.
 * - Removes non-digit formatting characters for length calculation.
 * - For Kenyan 10-digit numbers starting with 07 or 01:
 *   shows first 2 digits + X characters + last 2 digits.
 * - For +254/254 prefixed numbers: outputs +254 7XXXXXX78.
 * - For general phone strings: masks middle digits preserving first 2 and last 2.
 * - Never returns the complete phone number.
 */
export function maskPhoneNumber(phone?: string | null): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) return null;

  // Short digits fallback - safe redaction (never exposes raw digits)
  if (digits.length <= 4) {
    return 'XXXX';
  }

  // 12-digit Kenyan numbers starting with 254 (e.g. +254712345678 or 254712345678)
  if (digits.length === 12 && digits.startsWith('254')) {
    const localNine = digits.slice(3);
    const firstDigit = localNine[0];
    const lastTwo = localNine.slice(-2);
    return `${hasPlus ? '+' : ''}254 ${firstDigit}XXXXXX${lastTwo}`;
  }

  // 10-digit Kenyan mobile numbers starting with 07 or 01
  if (digits.length === 10 && (digits.startsWith('07') || digits.startsWith('01'))) {
    const prefix = digits.slice(0, 2);
    const lastTwo = digits.slice(-2);
    return `${prefix}XXXXXX${lastTwo}`;
  }

  // General fallback preserving first 2 and last 2 characters with middle X's
  const prefix = digits.slice(0, 2);
  const lastTwo = digits.slice(-2);
  const maskLen = Math.max(1, digits.length - 4);
  return `${hasPlus ? '+' : ''}${prefix}${'X'.repeat(maskLen)}${lastTwo}`;
}

/**
 * Resolve payment account information from explicit transaction data
 * or known Jimwas payment account identifiers/names.
 *
 * KCB:
 *   PayBill: 522522
 *   A/C:     7941675
 *
 * NCBA:
 *   PayBill: 880100
 *   A/C:     166294
 */
export function resolvePaymentAccountDetails(transaction: {
  payment_account_id?: string | null;
  payment_account_name?: string | null;
  payment_account_paybill?: string | null;
  payment_account_number?: string | null;
  payment_method?: string;
}) {
  let paybill = transaction.payment_account_paybill || null;
  let accountNumber = transaction.payment_account_number || null;
  let name = transaction.payment_account_name || null;

  const id = transaction.payment_account_id;
  const nameStr = (transaction.payment_account_name || '').toLowerCase();
  const paymentMethod = (transaction.payment_method || '').toLowerCase();

  /*
   * Prefer explicitly stored values.
   *
   * Only resolve missing values from known payment accounts.
   */
  if (
    id === 'payment-account-kcb' ||
    nameStr.includes('kcb') ||
    nameStr.includes('7941675')
  ) {
    if (!paybill) {
      paybill = '522522';
    }

    if (!accountNumber) {
      accountNumber = '7941675';
    }

    if (!name) {
      name = 'KCB A/C 7941675';
    }
  } else if (
    id === 'payment-account-ncba' ||
    nameStr.includes('ncba') ||
    nameStr.includes('166294')
  ) {
    if (!paybill) {
      paybill = '880100';
    }

    if (!accountNumber) {
      accountNumber = '166294';
    }

    if (!name) {
      name = 'NCBA A/C 166294';
    }
  } else if (paymentMethod === 'kcb') {
    if (!paybill) {
      paybill = '522522';
    }

    if (!accountNumber) {
      accountNumber = '7941675';
    }

    if (!name) {
      name = 'KCB A/C 7941675';
    }
  }

  /*
   * Do not automatically treat every M-Pesa transaction as KCB.
   *
   * M-Pesa is a payment method, while KCB/NCBA are payment accounts.
   * Account resolution should therefore happen from the account ID/name
   * unless the transaction explicitly identifies KCB.
   */

  return {
    name,
    paybill,
    accountNumber,
  };
}

export function buildReceiptHtml(options: PrintOptions): string {
  const { business, receipt, transaction } = options;

  /*
   * ReceiptSettings.paper_width is a string union:
   * '58mm' | '80mm'
   *
   * Convert it once to a numeric width and use the number consistently.
   */
  const paperWidth = receipt.paper_width === '80mm' ? 80 : 58;
  const charsPerLine = paperWidth === 80 ? 48 : 32;
  const fontSize = paperWidth === 80 ? '12px' : '10px';

  const formatLine = (left: string, right?: string): string => {
    if (!right) {
      return left.padEnd(charsPerLine);
    }

    const leftStr = left.substring(
      0,
      Math.floor(charsPerLine * 0.6),
    );

    const rightStr = right.substring(
      0,
      Math.floor(charsPerLine * 0.4),
    );

    const spaces = Math.max(
      1,
      charsPerLine - leftStr.length - rightStr.length,
    );

    return leftStr + ' '.repeat(spaces) + rightStr;
  };

  const divider = '-'.repeat(charsPerLine);
  const doubleDivider = '='.repeat(charsPerLine);
  const lines: string[] = [];

  /*
   * Business header
   */
  if (business.business_name) {
    const name = business.business_name.toUpperCase();
    const pad = Math.max(
      0,
      Math.floor((charsPerLine - name.length) / 2),
    );

    lines.push(' '.repeat(pad) + name);
  }

  if (business.business_address) {
    lines.push(business.business_address);
  }

  if (business.business_phone) {
    lines.push(`Tel: ${business.business_phone}`);
  }

  if (business.business_email) {
    lines.push(`Email: ${business.business_email}`);
  }

  /*
   * Receipt header belongs to BusinessSettings,
   * not ReceiptSettings.
   */
  if (business.receipt_header) {
    lines.push('');
    lines.push(business.receipt_header);
  }

  lines.push(doubleDivider);

  /*
   * Transaction information
   */
  lines.push(formatLine('Receipt:', transaction.id));

  lines.push(
    formatLine(
      'Date:',
      new Date(transaction.created_at).toLocaleString(),
    ),
  );

  lines.push(
    formatLine(
      'Cashier:',
      transaction.cashier_name || 'System',
    ),
  );

  /*
   * Customer information
   */
  if (
    receipt.show_customer_name &&
    transaction.customer_name
  ) {
    lines.push(
      formatLine(
        'Customer:',
        transaction.customer_name,
      ),
    );
  }

  const maskedPhone = maskPhoneNumber(transaction.customer_phone);

  if (
    receipt.show_customer_phone &&
    maskedPhone
  ) {
    lines.push(
      formatLine(
        'Phone:',
        maskedPhone,
      ),
    );
  }

  lines.push(divider);

  /*
   * Items
   */
  lines.push(formatLine('ITEM', 'TOTAL'));
  lines.push(divider);

  for (const item of transaction.items) {
    const productName = item.product_name || 'Unknown Item';

    lines.push(
      productName.substring(0, charsPerLine),
    );

    lines.push(
      formatLine(
        `  ${item.quantity} x ${item.unit_price.toLocaleString()}`,
        item.subtotal.toLocaleString(),
      ),
    );
  }

  /*
   * Totals
   */
  const subtotal = transaction.subtotal !== undefined
    ? transaction.subtotal
    : transaction.items.reduce((sum, it) => sum + it.subtotal, 0);
  const discount = transaction.discount ?? 0;
  const deliveryFee = transaction.delivery_fee ?? 0;

  lines.push(divider);

  lines.push(
    formatLine(
      'Subtotal:',
      `KES ${subtotal.toLocaleString()}`,
    ),
  );

  if (discount > 0 || transaction.discount !== undefined) {
    lines.push(
      formatLine(
        'Discount:',
        `KES ${discount.toLocaleString()}`,
      ),
    );
  }

  lines.push(
    formatLine(
      'Delivery:',
      `KES ${deliveryFee.toLocaleString()}`,
    ),
  );

  lines.push(divider);

  lines.push(
    formatLine(
      'TOTAL:',
      `KES ${transaction.total_amount.toLocaleString()}`,
    ),
  );

  lines.push(
    formatLine(
      'PAID:',
      `KES ${transaction.amount_paid.toLocaleString()}`,
    ),
  );

  lines.push(
    formatLine(
      'CHANGE:',
      `KES ${transaction.change_amount.toLocaleString()}`,
    ),
  );

  /*
   * Payment method & account
   */
  const paymentMethod =
    transaction.payment_method || 'unknown';

  lines.push(
    formatLine(
      'Method:',
      paymentMethod.toUpperCase(),
    ),
  );

  /*
   * Resolve payment account details ONCE.
   *
   * This prevents the receipt from printing the same PayBill
   * and A/C number twice when the transaction already contains
   * those values.
   */
  const paymentMethodLower =
    paymentMethod.toLowerCase();

  const accountInfo =
    resolvePaymentAccountDetails(transaction);

  const accountLabel =
    transaction.payment_account ||
    accountInfo.name ||
    transaction.payment_account_name ||
    (
      paymentMethodLower === 'cash'
        ? 'CASH'
        : paymentMethodLower === 'kcb' || paymentMethodLower === 'kcb_buni'
          ? 'MPESA'
          : paymentMethodLower === 'ncba'
            ? 'NCBA'
            : 'Unassigned'
    );

  lines.push(
    formatLine(
      'Payment Account:',
      accountLabel,
    ),
  );

  if (accountInfo.paybill) {
    lines.push(
      formatLine(
        'Paybill No.:',
        accountInfo.paybill,
      ),
    );
  }

  if (accountInfo.accountNumber) {
    lines.push(
      formatLine(
        'A/C No.:',
        accountInfo.accountNumber,
      ),
    );
  }

  /*
   * M-Pesa/KCB BUNI STK reference
   */
  if (transaction.mpesa_receipt) {
    lines.push(
      formatLine(
        'KCB BUNI STK Ref:',
        transaction.mpesa_receipt,
      ),
    );
  }

  lines.push(divider);

  /*
   * Receipt footer belongs to BusinessSettings,
   * not ReceiptSettings.
   */
  if (business.receipt_footer) {
    lines.push('');
    lines.push(business.receipt_footer);
  }

  lines.push('');
  lines.push('Thank You For Shopping With Us');
  lines.push('');
  lines.push(doubleDivider);

  const text = lines.join('\n');

  /*
   * Escape receipt content before injecting it into HTML.
   */
  const safeText = escapeHtml(text);
  const safeTransactionId = escapeHtml(transaction.id);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Receipt - ${safeTransactionId}</title>

  <style>
    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      padding: 0;
      background: white;
      color: black;
    }

    body {
      font-family: 'Courier New', Courier, monospace;
      font-size: ${fontSize};
      line-height: 1.4;
      padding: 8px;
      width: ${paperWidth}mm;
    }

    pre {
      margin: 0;
      padding: 0;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    @media print {
      html,
      body {
        width: ${paperWidth}mm;
      }

      body {
        padding: 0;
      }

      @page {
        margin: 4mm;
        size: ${paperWidth}mm auto;
      }
    }
  </style>
</head>

<body>
  <pre>${safeText}</pre>
</body>
</html>`;
}

/**
 * Print receipt through a hidden iframe.
 *
 * This avoids popup permission requirements in most browsers.
 */
export function printReceipt(
  options: PrintOptions,
): void {
  const html = buildReceiptHtml(options);

  const iframe =
    document.createElement('iframe');

  iframe.style.cssText =
    'position:fixed;' +
    'top:0;' +
    'left:0;' +
    'width:0;' +
    'height:0;' +
    'border:0;' +
    'opacity:0;' +
    'pointer-events:none;';

  iframe.setAttribute(
    'aria-hidden',
    'true',
  );

  document.body.appendChild(iframe);

  const doc =
    iframe.contentDocument ||
    iframe.contentWindow?.document;

  if (!doc) {
    if (document.body.contains(iframe)) {
      document.body.removeChild(iframe);
    }

    return;
  }

  doc.open();
  doc.write(html);
  doc.close();

  const printWindow =
    iframe.contentWindow;

  if (!printWindow) {
    if (document.body.contains(iframe)) {
      document.body.removeChild(iframe);
    }

    return;
  }

  let printed = false;

  const cleanup = () => {
    if (
      document.body.contains(iframe)
    ) {
      document.body.removeChild(iframe);
    }
  };

  const doPrint = () => {
    if (printed) {
      return;
    }

    printed = true;

    printWindow.focus();
    printWindow.print();

    /*
     * Give the browser enough time to finish
     * handling the print dialog before cleanup.
     */
    setTimeout(cleanup, 1000);
  };

  /*
   * Wait for the iframe document to finish loading.
   */
  iframe.onload = () => {
    setTimeout(doPrint, 50);
  };

  /*
   * Some browsers may not reliably fire iframe.onload
   * after document.write(). Use a fallback.
   */
  setTimeout(() => {
    if (!printed) {
      doPrint();
    }
  }, 300);
}

/**
 * Print a test receipt using the current business
 * and receipt settings.
 */
export function testPrint(
  business: BusinessSettings,
  receipt: ReceiptSettings,
): void {
  printReceipt({
    business,
    receipt,

    transaction: {
      id:
        'TEST-' +
        Date.now()
          .toString(36)
          .toUpperCase(),

      items: [
        {
          product_name: 'Milk 500ml',
          quantity: 2,
          unit_price: 65,
          subtotal: 130,
        },
        {
          product_name: 'Bread',
          quantity: 1,
          unit_price: 55,
          subtotal: 55,
        },
        {
          product_name: 'Sugar 1kg',
          quantity: 1,
          unit_price: 180,
          subtotal: 180,
        },
      ],

      total_amount: 365,
      amount_paid: 400,
      change_amount: 35,

      payment_method: 'cash',

      created_at:
        new Date().toISOString(),

      customer_name: 'John Doe',
      customer_phone: '0712345678',
      cashier_name: 'Admin',
    },
  });
}

/**
 * Preview receipt in a separate browser window
 * before printing.
 */
export function previewReceipt(
  options: PrintOptions,
): void {
  const html = buildReceiptHtml(options);

  const newWindow = window.open(
    '',
    'receipt-preview',
    'width=400,height=600,resizable=yes,scrollbars=yes',
  );

  if (!newWindow) {
    /*
     * Popup blockers may prevent the preview window.
     */
    console.warn(
      'Receipt preview was blocked by the browser popup blocker.',
    );

    return;
  }

  newWindow.document.open();
  newWindow.document.write(html);
  newWindow.document.close();

  newWindow.focus();
}

/**
 * Store a receipt transaction locally for reprinting/history.
 *
 * The history is intentionally stored as transaction data rather
 * than rendered HTML so the receipt can be regenerated later
 * using the current receipt/business settings.
 */
export function saveReceiptToHistory(
  transaction: PrintTransaction,
): void {
  try {
    const existing =
      localStorage.getItem(
        RECEIPT_HISTORY_KEY,
      );

    let history: PrintTransaction[] = [];

    if (existing) {
      try {
        const parsed =
          JSON.parse(existing);

        if (Array.isArray(parsed)) {
          history = parsed;
        }
      } catch {
        /*
         * Ignore malformed existing history
         * and recreate it below.
         */
        history = [];
      }
    }

    /*
     * Remove an existing copy of the same transaction.
     * This prevents duplicate history entries when
     * a receipt is saved more than once.
     */
    history = history.filter(
      (item) =>
        item.id !== transaction.id,
    );

    /*
     * Newest transaction first. Mask customer phone to ensure local history preserves privacy.
     */
    const sanitizedTransaction: PrintTransaction = {
      ...transaction,
      customer_phone: maskPhoneNumber(transaction.customer_phone) || undefined,
    };
    history.unshift(sanitizedTransaction);

    /*
     * Prevent unlimited localStorage growth.
     */
    if (
      history.length >
      MAX_RECEIPT_HISTORY
    ) {
      history = history.slice(
        0,
        MAX_RECEIPT_HISTORY,
      );
    }

    localStorage.setItem(
      RECEIPT_HISTORY_KEY,
      JSON.stringify(history),
    );
  } catch (error) {
    /*
     * localStorage may be unavailable in private browsing,
     * restricted environments, or if storage quota is exceeded.
     *
     * Receipt printing itself should never fail because
     * receipt history could not be saved.
     */
    console.warn(
      'Unable to save receipt to local history:',
      error,
    );
  }
}

/**
 * Retrieve locally stored receipt history.
 */
export function getReceiptHistory(): PrintTransaction[] {
  try {
    const stored =
      localStorage.getItem(
        RECEIPT_HISTORY_KEY,
      );

    if (!stored) {
      return [];
    }

    const parsed =
      JSON.parse(stored);

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch (error) {
    console.warn(
      'Unable to read receipt history:',
      error,
    );

    return [];
  }
}

/**
 * Find a single receipt by transaction ID.
 */
export function getReceiptFromHistory(
  transactionId: string,
): PrintTransaction | null {
  const history =
    getReceiptHistory();

  return (
    history.find(
      (transaction) =>
        transaction.id === transactionId,
    ) || null
  );
}

/**
 * Remove a single receipt from local history.
 */
export function removeReceiptFromHistory(
  transactionId: string,
): void {
  try {
    const history =
      getReceiptHistory();

    const updated =
      history.filter(
        (transaction) =>
          transaction.id !== transactionId,
      );

    localStorage.setItem(
      RECEIPT_HISTORY_KEY,
      JSON.stringify(updated),
    );
  } catch (error) {
    console.warn(
      'Unable to remove receipt from history:',
      error,
    );
  }
}

/**
 * Clear all locally stored receipt history.
 */
export function clearReceiptHistory(): void {
  try {
    localStorage.removeItem(
      RECEIPT_HISTORY_KEY,
    );
  } catch (error) {
    console.warn(
      'Unable to clear receipt history:',
      error,
    );
  }
}

export interface CombinedDashboardReportOptions {
  business: BusinessSettings;
  receipt?: ReceiptSettings;
  periodLabel: string;
  generatedAt?: Date;
  cashierName?: string;
  kpis: AuthoritativeDashboardKPIs;
  dailySummaries: DailyTransactionSummary[];
  detailedTransactions: Transaction[];
  customers: Customer[];
  products: Product[];
}

export function buildCombinedDashboardReportHtml(options: CombinedDashboardReportOptions): string {
  const {
    business,
    periodLabel,
    generatedAt = new Date(),
    cashierName = 'System',
    kpis,
    dailySummaries,
    detailedTransactions,
    customers,
    products,
  } = options;

  const stockMap = new Map(products.map((p) => [p.id, p]));
  const customerMap = new Map(customers.map((c) => [c.id, c.name]));

  // Build rows for Section B (Daily Detailed Report)
  const detailedRows = detailedTransactions.flatMap((tx) => {
    const cust = tx.customer_name || (tx.customer_id ? customerMap.get(tx.customer_id) : null) || 'Walk-in';
    const txDate = new Date(tx.created_at);
    const dateStr = `${txDate.toLocaleDateString()}<br><small style="color:#64748b">${txDate.toLocaleTimeString()}</small>`;
    const paymentAcct = tx.payment_account || (tx.payment_account_name ? tx.payment_account_name : tx.payment_method?.toUpperCase() || 'CASH');
    const codStatus = tx.payment_method === 'cod' ? (tx.cod_status === 'PAID' ? 'COD Paid' : 'COD Pending') : tx.payment_method;

    return (tx.items || []).map((item) => {
      const prod = stockMap.get(item.product_id);
      const stock = prod ? prod.stock : 0;
      const stockClass = stock <= 0 ? 'out' : stock <= (prod?.low_stock_alert || 5) ? 'low' : 'ok';
      const stockText = stock <= 0 ? 'Out of stock' : `${stock} in stock`;

      return `<tr>
        <td>${dateStr}</td>
        <td><strong>${escapeHtml(cust)}</strong><br><small style="color:#64748b">${escapeHtml(tx.id.slice(0, 12))}</small></td>
        <td><strong>${escapeHtml(item.product_name)}</strong><br><small style="color:#64748b">${item.quantity} &times; KES ${item.unit_price.toLocaleString()}</small></td>
        <td style="text-align:center">${item.quantity}</td>
        <td><span class="badge ${stockClass}">${stockText}</span></td>
        <td style="text-align:right; font-weight:600">KES ${item.subtotal.toLocaleString()}</td>
        <td style="text-align:center"><span class="badge method">${escapeHtml(codStatus)}</span></td>
        <td style="text-align:center"><strong>${escapeHtml(paymentAcct)}</strong></td>
      </tr>`;
    });
  }).join('');

  // Daily Summary Rows
  const dailySummaryRows = dailySummaries.map((day) => {
    return `<tr>
      <td><strong>${day.dayLabel}</strong></td>
      <td style="text-align:center">${day.transactionCount}</td>
      <td style="text-align:right">KES ${day.subtotal.toLocaleString()}</td>
      <td style="text-align:right">${day.discounts > 0 ? `KES ${day.discounts.toLocaleString()}` : '-'}</td>
      <td style="text-align:right">${day.deliveryFees > 0 ? `KES ${day.deliveryFees.toLocaleString()}` : '-'}</td>
      <td style="text-align:right; font-weight:700; color:#047857">KES ${day.totalSales.toLocaleString()}</td>
      <td>
        <small style="color:#475569">
          ${day.paymentAccounts.CASH > 0 ? `CASH: ${day.paymentAccounts.CASH.toLocaleString()} ` : ''}
          ${day.paymentAccounts.MPESA > 0 ? `MPESA: ${day.paymentAccounts.MPESA.toLocaleString()} ` : ''}
          ${day.paymentAccounts.KCB > 0 ? `KCB: ${day.paymentAccounts.KCB.toLocaleString()} ` : ''}
          ${day.paymentAccounts.NCBA > 0 ? `NCBA: ${day.paymentAccounts.NCBA.toLocaleString()} ` : ''}
        </small>
      </td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Jimwas POS — Combined Executive KPI & Detailed Sales Report</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #1e293b; margin: 24px; font-size: 13px; line-height: 1.4; }
    .header { border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; }
    .header h1 { margin: 0 0 4px 0; font-size: 22px; color: #0f172a; }
    .header p { margin: 2px 0; color: #64748b; font-size: 12px; }
    .actions { margin: 16px 0 24px; display: flex; gap: 10px; }
    .btn { padding: 8px 16px; border: 0; border-radius: 6px; background: #059669; color: #fff; font-weight: 600; cursor: pointer; font-size: 13px; }
    .section-title { font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #0f172a; border-left: 4px solid #059669; padding-left: 8px; margin: 24px 0 12px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
    .kpi-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; break-inside: avoid; }
    .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 4px; }
    .kpi-value { font-size: 20px; font-weight: 700; color: #0f172a; }
    .kpi-subtext { font-size: 11px; color: #64748b; margin-top: 2px; }
    .accounts-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
    .account-card { background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px; break-inside: avoid; }
    .account-card .name { font-weight: 700; font-size: 13px; color: #1e293b; }
    .account-card .amt { font-size: 16px; font-weight: 700; color: #059669; margin: 4px 0 2px; }
    .account-card .meta { font-size: 11px; color: #64748b; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
    th, td { border: 1px solid #e2e8f0; padding: 8px; vertical-align: top; text-align: left; }
    th { background: #f1f5f9; font-weight: 600; color: #334155; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
    .badge.ok { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
    .badge.low { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }
    .badge.out { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
    .badge.method { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; text-transform: uppercase; }
    .page-break { page-break-before: always; margin-top: 24px; }
    @media print {
      body { margin: 10mm; font-size: 11px; }
      .actions { display: none; }
      @page { margin: 10mm; size: A4 portrait; }
      .kpi-grid, .accounts-grid, table { break-inside: auto; }
      tr { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="actions">
    <button class="btn" onclick="window.print()">Print / Save as PDF</button>
  </div>

  <div class="header">
    <div>
      <h1>${escapeHtml(business.business_name || 'Jimwas Hardware & Electricals')}</h1>
      <p><strong>Period:</strong> ${escapeHtml(periodLabel)} &nbsp;|&nbsp; <strong>Generated:</strong> ${generatedAt.toLocaleString()} &nbsp;|&nbsp; <strong>Cashier:</strong> ${escapeHtml(cashierName)}</p>
      <p>${escapeHtml(business.business_address || '')} ${business.business_phone ? `&bull; Tel: ${escapeHtml(business.business_phone)}` : ''}</p>
    </div>
    <div style="text-align: right">
      <div style="font-size: 16px; font-weight: 700; color: #059669">EXECUTIVE REPORT</div>
      <div style="font-size: 11px; color: #64748b">RECONCILED FINANCIAL REPORT</div>
    </div>
  </div>

  <!-- SECTION A: DASHBOARD / KPI SUMMARY -->
  <div class="section-title">SECTION A &mdash; DASHBOARD KPI SUMMARY</div>

  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">Total Sales (Net)</div>
      <div class="kpi-value" style="color: #059669">KES ${kpis.totalSales.toLocaleString()}</div>
      <div class="kpi-subtext">Merchandise + Delivery - Discounts</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Merchandise Subtotal</div>
      <div class="kpi-value">KES ${kpis.subtotal.toLocaleString()}</div>
      <div class="kpi-subtext">Product merchandise sum</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Total Delivery Fees</div>
      <div class="kpi-value" style="color: #d97706">KES ${kpis.totalDeliveryFees.toLocaleString()}</div>
      <div class="kpi-subtext">Tracked separately from goods</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Total Discounts</div>
      <div class="kpi-value">KES ${kpis.totalDiscounts.toLocaleString()}</div>
      <div class="kpi-subtext">Deducted from sales</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Completed Transactions</div>
      <div class="kpi-value">${kpis.totalTransactions}</div>
      <div class="kpi-subtext">Active completed sales</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Avg. Transaction Value</div>
      <div class="kpi-value">KES ${Math.round(kpis.averageTransactionValue).toLocaleString()}</div>
      <div class="kpi-subtext">Per sale average</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Unique Customers</div>
      <div class="kpi-value">${kpis.uniqueCustomers}</div>
      <div class="kpi-subtext">Purchasing clients in period</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Reconciled Total</div>
      <div class="kpi-value" style="color: #059669">KES ${kpis.paymentAccounts.totalAmount.toLocaleString()}</div>
      <div class="kpi-subtext">100% reconciled to payment accounts</div>
    </div>
  </div>

  <div style="font-weight: 600; font-size: 13px; margin: 12px 0 6px; color: #1e293b">PAYMENT ACCOUNT SUMMARY</div>
  <div class="accounts-grid">
    <div class="account-card">
      <div class="name">CASH</div>
      <div class="amt">KES ${kpis.paymentAccounts.CASH.amount.toLocaleString()}</div>
      <div class="meta">${kpis.paymentAccounts.CASH.count} sales &bull; ${kpis.paymentAccounts.CASH.percentage}% share</div>
    </div>
    <div class="account-card">
      <div class="name">MPESA (KCB BUNI)</div>
      <div class="amt">KES ${kpis.paymentAccounts.MPESA.amount.toLocaleString()}</div>
      <div class="meta">${kpis.paymentAccounts.MPESA.count} sales &bull; ${kpis.paymentAccounts.MPESA.percentage}% share</div>
    </div>
    <div class="account-card">
      <div class="name">KCB BANK</div>
      <div class="amt">KES ${kpis.paymentAccounts.KCB.amount.toLocaleString()}</div>
      <div class="meta">${kpis.paymentAccounts.KCB.count} sales &bull; ${kpis.paymentAccounts.KCB.percentage}% share</div>
    </div>
    <div class="account-card">
      <div class="name">NCBA BANK</div>
      <div class="amt">KES ${kpis.paymentAccounts.NCBA.amount.toLocaleString()}</div>
      <div class="meta">${kpis.paymentAccounts.NCBA.count} sales &bull; ${kpis.paymentAccounts.NCBA.percentage}% share</div>
    </div>
  </div>

  <div style="font-weight: 600; font-size: 13px; margin: 12px 0 6px; color: #1e293b">DAILY SALES BREAKDOWN (${dailySummaries.length} DAYS)</div>
  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th style="text-align:center">Sales Count</th>
        <th style="text-align:right">Subtotal</th>
        <th style="text-align:right">Discounts</th>
        <th style="text-align:right">Delivery</th>
        <th style="text-align:right">Net Total</th>
        <th>Payment Account Distribution</th>
      </tr>
    </thead>
    <tbody>
      ${dailySummaryRows || '<tr><td colspan="7" style="text-align:center">No daily sales for this period</td></tr>'}
    </tbody>
  </table>

  <!-- SECTION B: DAILY DETAILED REPORT -->
  <div class="page-break"></div>
  <div class="section-title">SECTION B &mdash; DAILY DETAILED REPORT (LINE ITEMS)</div>
  <p style="color: #64748b; font-size: 12px; margin-top: -6px; margin-bottom: 12px">Full transaction inventory lines and live stock status as of report generation.</p>

  <table>
    <thead>
      <tr>
        <th>Date & Time</th>
        <th>Customer / Tx ID</th>
        <th>Product Description</th>
        <th style="text-align:center">Qty</th>
        <th>Current Stock</th>
        <th style="text-align:right">Line Amount</th>
        <th style="text-align:center">Payment / COD</th>
        <th style="text-align:center">Account</th>
      </tr>
    </thead>
    <tbody>
      ${detailedRows || '<tr><td colspan="8" style="text-align:center">No detailed line items for this period</td></tr>'}
    </tbody>
  </table>

  <div style="margin-top: 24px; padding-top: 12px; border-top: 2px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center">
    <p style="font-weight: 600; color: #0f172a; margin: 0">Thank You For Shopping With Us &bull; Jimwas POS</p>
    <p style="font-size: 12px; color: #64748b; margin: 0">Official Accounting Record</p>
  </div>
</body>
</html>`;
}

export function previewCombinedDashboardReport(options: CombinedDashboardReportOptions): void {
  const html = buildCombinedDashboardReportHtml(options);
  const win = window.open('', '_blank');
  if (!win) {
    console.warn('Combined report popup was blocked by browser.');
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
}