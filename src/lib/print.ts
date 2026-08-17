import { BusinessSettings, ReceiptSettings } from './settings-types';

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

function buildReceiptHtml(options: PrintOptions): string {
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
   * Payment method
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
    accountInfo.name ||
    transaction.payment_account_name ||
    (
      paymentMethodLower === 'cash'
        ? 'CASH'
        : paymentMethodLower === 'kcb'
          ? 'KCB'
          : paymentMethodLower === 'ncba'
            ? 'NCBA'
            : 'Unassigned'
    );

  lines.push(
    formatLine(
      'Account:',
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
  const safeTransactionId =
    escapeHtml(transaction.id);

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
      width: ${receipt.paper_width};
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
        width: ${receipt.paper_width};
      }

      body {
        padding: 0;
      }

      @page {
        margin: 4mm;
        size: ${receipt.paper_width} auto;
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