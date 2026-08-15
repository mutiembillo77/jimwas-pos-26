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

/**
 * Resolve payment-account information from the transaction.
 *
 * Priority:
 * 1. Explicit transaction values
 * 2. Known payment-account IDs/names
 * 3. Payment-method fallback
 *
 * This function is deliberately used once when building the receipt
 * so PayBill and A/C details cannot accidentally be printed twice.
 */
export function resolvePaymentAccountDetails(transaction: {
  payment_account_id?: string | null;
  payment_account_name?: string | null;
  payment_account_paybill?: string | null;
  payment_account_number?: string | null;
  payment_method?: string;
}): {
  name: string | null;
  paybill: string | null;
  accountNumber: string | null;
} {
  let paybill = transaction.payment_account_paybill || null;
  let accountNumber = transaction.payment_account_number || null;
  let name = transaction.payment_account_name || null;

  const id = transaction.payment_account_id || '';
  const nameStr = (transaction.payment_account_name || '').toLowerCase();
  const method = (transaction.payment_method || '').toLowerCase();

  /*
   * KCB
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
  }

  /*
   * NCBA
   */
  else if (
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
  }

  /*
   * Legacy/fallback KCB or M-Pesa mapping.
   *
   * Only use this when there is no explicit payment-account
   * information.
   */
  else if (
    method === 'kcb' ||
    method === 'mpesa'
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
  }

  /*
   * Cash should never receive a bank PayBill/account number
   * merely because the transaction has a generic payment method.
   */
  if (method === 'cash' && !transaction.payment_account_id) {
    if (!transaction.payment_account_name) {
      name = 'CASH';
    }

    paybill = null;
    accountNumber = null;
  }

  return {
    name,
    paybill,
    accountNumber,
  };
}

/**
 * Escape HTML-sensitive characters before inserting transaction
 * values into the generated receipt HTML.
 */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Convert a value into a safe display string.
 */
function displayValue(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

/**
 * Build printable receipt HTML.
 */
function buildReceiptHtml(options: PrintOptions): string {
  const {
    business,
    receipt,
    transaction,
  } = options;

  const paperWidth =
    receipt.paper_width === '80mm'
      ? '80mm'
      : '58mm';

  const charsPerLine =
    paperWidth === '80mm'
      ? 48
      : 32;

  const fontSize =
    paperWidth === '80mm'
      ? '12px'
      : '10px';

  const formatLine = (
    left: string,
    right?: string,
  ): string => {
    const safeLeft = String(left ?? '');
    const safeRight = right !== undefined
      ? String(right ?? '')
      : '';

    if (!right) {
      return safeLeft.substring(0, charsPerLine);
    }

    const leftWidth = Math.floor(charsPerLine * 0.60);
    const rightWidth = Math.floor(charsPerLine * 0.40);

    const leftStr = safeLeft.substring(0, leftWidth);
    const rightStr = safeRight.substring(0, rightWidth);

    const spaces = Math.max(
      1,
      charsPerLine - leftStr.length - rightStr.length,
    );

    return (
      leftStr +
      ' '.repeat(spaces) +
      rightStr
    );
  };

  const divider = '-'.repeat(charsPerLine);
  const doubleDivider = '='.repeat(charsPerLine);

  const lines: string[] = [];

  /*
   * ------------------------------------------------------------
   * BUSINESS HEADER
   * ------------------------------------------------------------
   */

  if (business.business_name) {
    const name = business.business_name
      .toUpperCase()
      .substring(0, charsPerLine);

    const pad = Math.max(
      0,
      Math.floor((charsPerLine - name.length) / 2),
    );

    lines.push(
      ' '.repeat(pad) + name,
    );
  }

  if (business.business_address) {
    lines.push(
      displayValue(business.business_address),
    );
  }

  if (business.business_phone) {
    lines.push(
      `Tel: ${displayValue(business.business_phone)}`,
    );
  }

  if (business.business_email) {
    lines.push(
      `Email: ${displayValue(business.business_email)}`,
    );
  }

  /*
   * IMPORTANT:
   * receipt_header belongs to BusinessSettings, not ReceiptSettings.
   */
  if (business.receipt_header) {
    lines.push('');
    lines.push(
      displayValue(business.receipt_header),
    );
  }

  lines.push(doubleDivider);

  /*
   * ------------------------------------------------------------
   * TRANSACTION DETAILS
   * ------------------------------------------------------------
   */

  lines.push(
    formatLine(
      'Receipt:',
      transaction.id,
    ),
  );

  const createdAt = new Date(transaction.created_at);

  const formattedDate = Number.isNaN(
    createdAt.getTime(),
  )
    ? transaction.created_at
    : createdAt.toLocaleString();

  lines.push(
    formatLine(
      'Date:',
      formattedDate,
    ),
  );

  if (
    receipt.show_cashier_name &&
    transaction.cashier_name
  ) {
    lines.push(
      formatLine(
        'Cashier:',
        transaction.cashier_name,
      ),
    );
  }

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

  if (
    receipt.show_customer_phone &&
    transaction.customer_phone
  ) {
    lines.push(
      formatLine(
        'Phone:',
        transaction.customer_phone,
      ),
    );
  }

  /*
   * ------------------------------------------------------------
   * ITEMS
   * ------------------------------------------------------------
   */

  lines.push(divider);

  lines.push(
    formatLine(
      'ITEM',
      'TOTAL',
    ),
  );

  lines.push(divider);

  for (const item of transaction.items) {
    const productName = displayValue(
      item.product_name,
      'Unknown Item',
    );

    lines.push(
      productName.substring(0, charsPerLine),
    );

    const quantity = Number.isFinite(item.quantity)
      ? item.quantity
      : 0;

    const unitPrice = Number.isFinite(item.unit_price)
      ? item.unit_price
      : 0;

    const subtotal = Number.isFinite(item.subtotal)
      ? item.subtotal
      : quantity * unitPrice;

    lines.push(
      formatLine(
        `  ${quantity} x ${unitPrice.toLocaleString()}`,
        subtotal.toLocaleString(),
      ),
    );
  }

  /*
   * ------------------------------------------------------------
   * TOTALS
   * ------------------------------------------------------------
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
   * ------------------------------------------------------------
   * PAYMENT DETAILS
   * ------------------------------------------------------------
   *
   * Resolve the payment account ONCE.
   *
   * Do NOT separately print transaction.payment_account_paybill
   * and transaction.payment_account_number before this block.
   *
   * This prevents:
   *
   * Paybill: 522522
   * A/C No.: 7941675
   * Paybill No.: 522522
   * A/C No.: 7941675
   *
   * from appearing twice.
   */

  const paymentMethod = displayValue(
    transaction.payment_method,
    'unknown',
  );

  lines.push(
    formatLine(
      'Method:',
      paymentMethod.toUpperCase(),
    ),
  );

  const accountInfo =
    resolvePaymentAccountDetails(transaction);

  const accountLabel =
    accountInfo.name ||
    (
      paymentMethod.toLowerCase() === 'cash'
        ? 'CASH'
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
   * M-Pesa/KCB receipt reference.
   */
  if (transaction.mpesa_receipt) {
    lines.push(
      formatLine(
        'STK Ref:',
        transaction.mpesa_receipt,
      ),
    );
  }

  lines.push(divider);

  /*
   * ------------------------------------------------------------
   * FOOTER
   * ------------------------------------------------------------
   *
   * receipt_footer belongs to BusinessSettings.
   */

  if (business.receipt_footer) {
    lines.push('');
    lines.push(
      displayValue(business.receipt_footer),
    );
  }

  lines.push('');
  lines.push('Thank You For Shopping With Us');
  lines.push('');
  lines.push(doubleDivider);

  const text = lines
    .map((line) => escapeHtml(line))
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  />
  <title>Receipt - ${escapeHtml(transaction.id)}</title>

  <style>
    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: #000000;
    }

    body {
      font-family:
        'Courier New',
        Courier,
        monospace;

      font-size: ${fontSize};
      line-height: 1.4;

      width: ${paperWidth};

      padding: 8px;
    }

    pre {
      margin: 0;
      padding: 0;

      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: break-word;
    }

    @media print {
      html,
      body {
        width: ${paperWidth};
        margin: 0;
        padding: 0;
      }

      body {
        padding: 0;
      }

      @page {
        margin: 4mm;
        size: ${paperWidth} auto;
      }
    }
  </style>
</head>

<body>
  <pre>${text}</pre>
</body>
</html>`;
}

/**
 * Print through a hidden iframe.
 *
 * This avoids opening a new browser tab/window and generally
 * works better for POS receipt printing.
 */
export function printReceipt(
  options: PrintOptions,
): void {
  const html = buildReceiptHtml(options);

  const iframe = document.createElement('iframe');

  iframe.setAttribute(
    'aria-hidden',
    'true',
  );

  iframe.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:0',
    'height:0',
    'border:0',
    'opacity:0',
    'pointer-events:none',
  ].join(';');

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

  const cleanup = () => {
    window.setTimeout(() => {
      if (document.body.contains(iframe)) {
        document.body.removeChild(iframe);
      }
    }, 1000);
  };

  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } finally {
      cleanup();
    }
  };
}

/**
 * Print a sample receipt.
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
 * Preview receipt in a new browser window.
 */
export function previewReceipt(
  options: PrintOptions,
): void {
  const html = buildReceiptHtml(options);

  const newWindow = window.open(
    '',
    'receipt-preview',
    [
      'width=400',
      'height=600',
      'resizable=yes',
      'scrollbars=yes',
    ].join(','),
  );

  if (!newWindow) {
    console.warn(
      'Receipt preview could not be opened. ' +
      'The browser may have blocked the popup.',
    );

    return;
  }

  newWindow.document.open();
  newWindow.document.write(html);
  newWindow.document.close();
}

/**
 * Store receipt in local browser history.
 *
 * Kept intentionally lightweight and defensive because receipt
 * history must never interfere with a completed sale.
 */
export function saveReceiptToHistory(
  transaction: PrintTransaction,
): void {
  try {
    const storageKey =
      'jimwas-receipt-history';

    const existingRaw =
      localStorage.getItem(storageKey);

    let existing: PrintTransaction[] = [];

    if (existingRaw) {
      try {
        const parsed =
          JSON.parse(existingRaw);

        if (Array.isArray(parsed)) {
          existing = parsed;
        }
      } catch {
        existing = [];
      }
    }

    /*
     * Avoid storing the same transaction repeatedly.
     */
    const withoutDuplicate =
      existing.filter(
        (receipt) =>
          receipt.id !== transaction.id,
      );

    const updated = [
      transaction,
      ...withoutDuplicate,
    ].slice(0, 100);

    localStorage.setItem(
      storageKey,
      JSON.stringify(updated),
    );
  } catch (error) {
    /*
     * Receipt-history failure must never break checkout.
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
    const raw =
      localStorage.getItem(
        'jimwas-receipt-history',
      );

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch {
    return [];
  }
}

/**
 * Remove one receipt from local history.
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
      'jimwas-receipt-history',
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
      'jimwas-receipt-history',
    );
  } catch (error) {
    console.warn(
      'Unable to clear receipt history:',
      error,
    );
  }
}