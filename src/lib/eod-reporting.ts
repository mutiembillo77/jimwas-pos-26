import type {
  AuditApprovalStatus,
  DailySalesRow,
  DualSourceReconciliationRow,
  DualSourceReconciliationStatus,
  EvidenceStrength,
  HistoricalDailySales,
  MonthEndSalesSummary,
  ReconciliationStatusDimension,
  ShiftRecord,
  SourceAvailability,
  Transaction,
  WeeklySalesSummary,
} from './types';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Format a Date object into YYYY-MM-DD
 */
export function formatDateKey(year: number, month: number, day: number): string {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

/**
 * Validate manual historical sales entry calculations and rules
 */
export function validateManualSalesEntry(
  entry: Partial<HistoricalDailySales>,
  existingPosTransactionsCount = 0
): { isValid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!entry.business_date) {
    errors.push('Business date is required.');
  }

  if (existingPosTransactionsCount > 0) {
    warnings.push(
      `POS transaction data (${existingPosTransactionsCount} transactions) already exists for this date. Manual historical entry cannot replace transaction-derived figures.`
    );
  }

  const gross = Number(entry.gross_sales ?? 0);
  const discounts = Number(entry.discounts ?? 0);
  const refunds = Number(entry.refunds ?? 0);
  const net = Number(entry.net_sales ?? 0);
  const cash = Number(entry.cash_sales ?? 0);
  const mpesa = Number(entry.mpesa_sales ?? 0);
  const other = Number(entry.other_sales ?? 0);

  if (gross < 0) errors.push('Gross sales cannot be negative.');
  if (discounts < 0) errors.push('Discounts cannot be negative.');
  if (refunds < 0) errors.push('Refunds cannot be negative.');
  if (discounts > gross) errors.push('Discounts cannot exceed gross sales.');
  if (refunds > gross) errors.push('Refunds cannot exceed gross sales.');

  const expectedNet = Math.round((gross - discounts - refunds) * 100) / 100;
  if (Math.abs(net - expectedNet) > 0.05) {
    errors.push(`Net sales (KES ${net}) does not equal Gross (KES ${gross}) - Discounts (KES ${discounts}) - Refunds (KES ${refunds}) = KES ${expectedNet}.`);
  }

  const paymentsSum = Math.round((cash + mpesa + other) * 100) / 100;
  if (Math.abs(paymentsSum - net) > 0.05 && net > 0) {
    warnings.push(
      `Payment method total (Cash: ${cash} + M-Pesa: ${mpesa} + Other: ${other} = ${paymentsSum}) does not match Net Sales (${net}).`
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Authoritative builder for the August 2026 Sales Report and EOD Reconciliation matrix
 */
export function buildDailySalesReport(
  transactions: Transaction[] = [],
  shifts: ShiftRecord[] = [],
  manualEntries: HistoricalDailySales[] = [],
  year = 2026,
  month = 8
): MonthEndSalesSummary {
  // Days in given month (August has 31)
  const daysInMonth = new Date(year, month, 0).getDate();
  const dailyRows: DailySalesRow[] = [];

  // Index manual entries by date
  const manualMap = new Map<string, HistoricalDailySales>();
  for (const entry of manualEntries) {
    if (entry.business_date) {
      manualMap.set(entry.business_date, entry);
    }
  }

  // Index shifts by opened date (YYYY-MM-DD)
  const shiftMap = new Map<string, ShiftRecord>();
  for (const shift of shifts) {
    if (shift.opened_at) {
      const sDate = shift.opened_at.slice(0, 10);
      shiftMap.set(sDate, shift);
    }
  }

  // Index transactions by created_at date (YYYY-MM-DD)
  const txMap = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    if (tx.status !== 'voided' && tx.created_at) {
      const tDate = tx.created_at.slice(0, 10);
      const existing = txMap.get(tDate) || [];
      existing.push(tx);
      txMap.set(tDate, existing);
    }
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = formatDateKey(year, month, day);
    const dateObj = new Date(year, month - 1, day);
    const dayName = DAY_NAMES[dateObj.getDay()];
    const dayTransactions = txMap.get(dateKey) || [];
    const shiftRecord = shiftMap.get(dateKey);
    const manualRecord = manualMap.get(dateKey);

    const warnings: string[] = [];

    if (dayTransactions.length > 0) {
      // 1. POS Transactions take precedence as live authoritative data
      let gross = 0;
      let cash = 0;
      let mpesa = 0;
      let other = 0;
      let discounts = 0;
      let refunds = 0;
      let tax = 0;

      for (const tx of dayTransactions) {
        const amount = Number(tx.total_amount || 0);
        gross += amount;
        const pm = (tx.payment_method || '').toLowerCase();
        if (pm.includes('cash')) cash += amount;
        else if (pm.includes('mpesa') || pm.includes('mobile')) mpesa += amount;
        else other += amount;

        // Trace discounts or refunds if attached
        if (tx.notes && tx.notes.toLowerCase().includes('discount')) {
          // best-effort
        }
      }

      const net = Math.max(0, gross - discounts - refunds);
      const eodTotal = net;

      if (shiftRecord && shiftRecord.variance && Math.abs(shiftRecord.variance) > 0.01) {
        warnings.push(`Shift cash variance: KES ${shiftRecord.variance}`);
      }

      dailyRows.push({
        date: dateKey,
        day_name: dayName,
        day_number: day,
        source: 'POS_TRANSACTION',
        status: 'COMPLETE',
        transaction_count: dayTransactions.length,
        gross_sales: gross,
        discounts,
        refunds,
        tax,
        net_sales: net,
        cash_sales: cash,
        mpesa_sales: mpesa,
        other_sales: other,
        eod_total: eodTotal,
        shift_record: shiftRecord,
        manual_record: undefined,
        warnings,
        is_editable: false,
      });
    } else if (manualRecord) {
      // 2. Manual Historical or Recovered entry
      const gross = Number(manualRecord.gross_sales || 0);
      const discounts = Number(manualRecord.discounts || 0);
      const refunds = Number(manualRecord.refunds || 0);
      const net = Number(manualRecord.net_sales || gross - discounts - refunds);
      const cash = Number(manualRecord.cash_sales || 0);
      const mpesa = Number(manualRecord.mpesa_sales || 0);
      const other = Number(manualRecord.other_sales || 0);
      const tax = Number(manualRecord.tax || 0);
      const eodTotal = Number(manualRecord.eod_total || net);

      if (manualRecord.warnings && manualRecord.warnings.length > 0) {
        warnings.push(...manualRecord.warnings);
      }

      const paymentsSum = cash + mpesa + other;
      if (Math.abs(paymentsSum - net) > 0.05 && net > 0) {
        warnings.push(`Payment breakdown (KES ${paymentsSum}) differs from Net Sales (KES ${net})`);
      }

      dailyRows.push({
        date: dateKey,
        day_name: dayName,
        day_number: day,
        source: manualRecord.source || 'MANUAL_HISTORICAL',
        status: manualRecord.status || 'RECONCILED',
        transaction_count: Number(manualRecord.transaction_count || 0),
        gross_sales: gross,
        discounts,
        refunds,
        tax,
        net_sales: net,
        cash_sales: cash,
        mpesa_sales: mpesa,
        other_sales: other,
        eod_total: eodTotal,
        shift_record: shiftRecord,
        manual_record: manualRecord,
        warnings,
        is_editable: !manualRecord.is_locked,
      });
    } else {
      // 3. Genuinely Missing Date
      warnings.push('MISSING — MANUAL ENTRY REQUIRED');

      dailyRows.push({
        date: dateKey,
        day_name: dayName,
        day_number: day,
        source: 'POS_TRANSACTION',
        status: 'MISSING',
        transaction_count: 0,
        gross_sales: 0,
        discounts: 0,
        refunds: 0,
        tax: 0,
        net_sales: 0,
        cash_sales: 0,
        mpesa_sales: 0,
        other_sales: 0,
        eod_total: 0,
        shift_record: shiftRecord,
        manual_record: undefined,
        warnings,
        is_editable: true,
      });
    }
  }

  // Group into defined Management Weeks (Aug 1–7, Aug 8–14, Aug 15–21, Aug 22–28, Aug 29–31)
  const weekDefinitions = [
    { weekNum: 1, startDay: 1, endDay: 7, label: '01 Aug – 07 Aug' },
    { weekNum: 2, startDay: 8, endDay: 14, label: '08 Aug – 14 Aug' },
    { weekNum: 3, startDay: 15, endDay: 21, label: '15 Aug – 21 Aug' },
    { weekNum: 4, startDay: 22, endDay: 28, label: '22 Aug – 28 Aug' },
    { weekNum: 5, startDay: 29, endDay: daysInMonth, label: `29 Aug – ${String(daysInMonth).padStart(2, '0')} Aug` },
  ];

  const weeks: WeeklySalesSummary[] = [];

  for (const def of weekDefinitions) {
    const currentWeekDays = dailyRows.filter(
      (r) => r.day_number >= def.startDay && r.day_number <= def.endDay
    );
    if (currentWeekDays.length === 0) continue;

    const startDate = currentWeekDays[0].date;
    const endDate = currentWeekDays[currentWeekDays.length - 1].date;

    const weekGross = currentWeekDays.reduce((sum, r) => sum + r.gross_sales, 0);
    const weekDiscounts = currentWeekDays.reduce((sum, r) => sum + r.discounts, 0);
    const weekRefunds = currentWeekDays.reduce((sum, r) => sum + r.refunds, 0);
    const weekTax = currentWeekDays.reduce((sum, r) => sum + r.tax, 0);
    const weekNet = currentWeekDays.reduce((sum, r) => sum + r.net_sales, 0);
    const weekCash = currentWeekDays.reduce((sum, r) => sum + r.cash_sales, 0);
    const weekMpesa = currentWeekDays.reduce((sum, r) => sum + r.mpesa_sales, 0);
    const weekOther = currentWeekDays.reduce((sum, r) => sum + r.other_sales, 0);
    const weekEod = currentWeekDays.reduce((sum, r) => sum + r.eod_total, 0);
    const weekTxCount = currentWeekDays.reduce((sum, r) => sum + r.transaction_count, 0);

    const tradingDays = currentWeekDays.filter((r) => r.eod_total > 0 || r.transaction_count > 0).length;
    const completeDays = currentWeekDays.filter((r) => r.status === 'COMPLETE').length;
    const missingDays = currentWeekDays.filter((r) => r.status === 'MISSING').length;
    const manualDays = currentWeekDays.filter((r) => r.source === 'MANUAL_HISTORICAL').length;
    const recoveredDays = currentWeekDays.filter((r) => r.source === 'RECOVERED').length;

    weeks.push({
      week_number: def.weekNum,
      date_range_label: def.label,
      start_date: startDate,
      end_date: endDate,
      trading_days: tradingDays,
      complete_days: completeDays,
      missing_days: missingDays,
      manual_days: manualDays,
      recovered_days: recoveredDays,
      transaction_count: weekTxCount,
      gross_sales: weekGross,
      discounts: weekDiscounts,
      refunds: weekRefunds,
      tax: weekTax,
      net_sales: weekNet,
      cash_sales: weekCash,
      mpesa_sales: weekMpesa,
      other_sales: weekOther,
      eod_total: weekEod,
      days: [...currentWeekDays],
    });
  }

  // Calculate Month-End Totals
  const totalGross = dailyRows.reduce((sum, r) => sum + r.gross_sales, 0);
  const totalDiscounts = dailyRows.reduce((sum, r) => sum + r.discounts, 0);
  const totalRefunds = dailyRows.reduce((sum, r) => sum + r.refunds, 0);
  const totalTax = dailyRows.reduce((sum, r) => sum + r.tax, 0);
  const totalNet = dailyRows.reduce((sum, r) => sum + r.net_sales, 0);
  const totalCash = dailyRows.reduce((sum, r) => sum + r.cash_sales, 0);
  const totalMpesa = dailyRows.reduce((sum, r) => sum + r.mpesa_sales, 0);
  const totalOther = dailyRows.reduce((sum, r) => sum + r.other_sales, 0);
  const totalEod = dailyRows.reduce((sum, r) => sum + r.eod_total, 0);
  const totalTxCount = dailyRows.reduce((sum, r) => sum + r.transaction_count, 0);

  const totalTradingDays = dailyRows.filter(r => r.eod_total > 0 || r.transaction_count > 0).length;
  const posDerivedDays = dailyRows.filter(r => r.source === 'POS_TRANSACTION' && r.status === 'COMPLETE').length;
  const recoveredDays = dailyRows.filter(r => r.source === 'RECOVERED').length;
  const manualDays = dailyRows.filter(r => r.source === 'MANUAL_HISTORICAL').length;
  const missingDays = dailyRows.filter(r => r.status === 'MISSING').length;

  return {
    month_label: `${MONTH_NAMES[month - 1]} ${year}`,
    year,
    month,
    total_calendar_days: daysInMonth,
    trading_days: totalTradingDays,
    pos_derived_days: posDerivedDays,
    recovered_days: recoveredDays,
    manual_days: manualDays,
    missing_days: missingDays,
    total_transactions: totalTxCount,
    gross_sales: totalGross,
    discounts: totalDiscounts,
    refunds: totalRefunds,
    tax: totalTax,
    net_sales: totalNet,
    cash_sales: totalCash,
    mpesa_sales: totalMpesa,
    other_sales: totalOther,
    total_eod_sales: totalEod,
    weeks,
    daily_rows: dailyRows,
  };
}

/**
 * Generate CSV representation of the August Sales Report
 */
export function generateAugustSalesReportCsv(summary: MonthEndSalesSummary): string {
  const headers = [
    'Date',
    'Day',
    'Gross Sales (KES)',
    'Discounts (KES)',
    'Refunds (KES)',
    'Net Sales (KES)',
    'Cash (KES)',
    'M-Pesa (KES)',
    'Other (KES)',
    'EOD Total (KES)',
    'Transactions',
    'Source',
    'Status',
    'Warnings',
  ];

  const lines: string[] = [headers.join(',')];

  for (const row of summary.daily_rows) {
    const values = [
      JSON.stringify(row.date),
      JSON.stringify(row.day_name),
      row.gross_sales.toFixed(2),
      row.discounts.toFixed(2),
      row.refunds.toFixed(2),
      row.net_sales.toFixed(2),
      row.cash_sales.toFixed(2),
      row.mpesa_sales.toFixed(2),
      row.other_sales.toFixed(2),
      row.eod_total.toFixed(2),
      row.transaction_count,
      JSON.stringify(row.source),
      JSON.stringify(row.status),
      JSON.stringify(row.warnings.join('; ')),
    ];
    lines.push(values.join(','));
  }

  // Month-end summary rows
  lines.push('');
  lines.push('--- AUGUST 2026 MONTH-END SUMMARY ---');
  lines.push(`Total Calendar Days,${summary.total_calendar_days}`);
  lines.push(`Trading Days,${summary.trading_days}`);
  lines.push(`POS-Derived Days,${summary.pos_derived_days}`);
  lines.push(`Manual-Entry Days,${summary.manual_days}`);
  lines.push(`Recovered Days,${summary.recovered_days}`);
  lines.push(`Missing Days,${summary.missing_days}`);
  lines.push(`Total Transactions,${summary.total_transactions}`);
  lines.push(`Total Gross Sales,${summary.gross_sales.toFixed(2)}`);
  lines.push(`Total Discounts,${summary.discounts.toFixed(2)}`);
  lines.push(`Total Refunds,${summary.refunds.toFixed(2)}`);
  lines.push(`Total Net Sales,${summary.net_sales.toFixed(2)}`);
  lines.push(`Total Cash Sales,${summary.cash_sales.toFixed(2)}`);
  lines.push(`Total M-Pesa Sales,${summary.mpesa_sales.toFixed(2)}`);
  lines.push(`Total Other Sales,${summary.other_sales.toFixed(2)}`);
  lines.push(`TOTAL EOD SALES,${summary.total_eod_sales.toFixed(2)}`);

  return lines.join('\n');
}

// ============================================================================
// HISTORICAL SALES FIGURES — READ-ONLY PREPARATION & RECONCILIATION LAYER
// ============================================================================

/**
 * Business-provided historical daily sales figures for August 2026.
 * All 31 calendar days open for business.
 * August 11 has no historical data provided (null) and must remain MISSING_DATA.
 * August 28 actual production sales: KES 81,860 (KES 7,000 and KES 200 were sandbox tests).
 */
export const AUGUST_2026_HISTORICAL_FIGURES: Readonly<Record<string, number | null>> = Object.freeze({
  '2026-08-01': 77170,
  '2026-08-02': 44205,
  '2026-08-03': 13600,
  '2026-08-04': 58200,
  '2026-08-05': 77450,
  '2026-08-06': 69550,
  '2026-08-07': 15690,
  '2026-08-08': 111000,
  '2026-08-09': 38800,
  '2026-08-10': 70900,
  '2026-08-11': null, // NO HISTORICAL DATA PROVIDED — Do not create a zero record!
  '2026-08-12': 40150,
  '2026-08-13': 47800,
  '2026-08-14': 74140,
  '2026-08-15': 50950,
  '2026-08-16': 51150,
  '2026-08-17': 31900,
  '2026-08-18': 36150,
  '2026-08-19': 134650,
  '2026-08-20': 46600,
  '2026-08-21': 56280,
  '2026-08-22': 63500,
  '2026-08-23': 65000,
  '2026-08-24': 52100,
  '2026-08-25': 74850,
  '2026-08-26': 80350,
  '2026-08-27': 57550,
  '2026-08-28': 81860, // Actual production sales. KES 7,000 is excluded sandbox test.
  '2026-08-29': 75980,
  '2026-08-30': 137000,
  '2026-08-31': 20590,
});

/**
 * September 2026 historical business-provided figures.
 * Strictly separated from August reporting.
 */
export const SEPTEMBER_2026_HISTORICAL_FIGURES: Readonly<Record<string, number>> = Object.freeze({
  '2026-09-01': 45060,
  '2026-09-02': 101000,
  '2026-09-03': 28000,
});

/**
 * Calculate the known historical August sales total excluding August 11.
 * Must equal exactly KES 1,855,115.
 */
export function getAugustKnownHistoricalTotal(): number {
  return Object.entries(AUGUST_2026_HISTORICAL_FIGURES).reduce((sum, [date, amount]) => {
    if (date.startsWith('2026-08') && typeof amount === 'number') {
      return sum + amount;
    }
    return sum;
  }, 0);
}

/**
 * Calculate the known September 1–3 historical sales total.
 * Must equal exactly KES 174,060.
 */
export function getSeptemberKnownHistoricalTotal(): number {
  return Object.entries(SEPTEMBER_2026_HISTORICAL_FIGURES).reduce((sum, [date, amount]) => {
    if (date.startsWith('2026-09') && typeof amount === 'number') {
      return sum + amount;
    }
    return sum;
  }, 0);
}

/**
 * Ensure strict month isolation — August and September totals cannot be mixed.
 */
export function validateMonthIsolation(targetMonth: 8 | 9, dateStrings: string[]): boolean {
  const prefix = targetMonth === 8 ? '2026-08' : '2026-09';
  return dateStrings.every((d) => d.startsWith(prefix));
}

/**
 * Create a prepared unapproved HistoricalDailySales record.
 * Status is PENDING_APPROVAL. Never treated as VERIFIED_MANUAL until explicitly approved.
 */
export function createPreparedHistoricalRecord(
  businessDate: string,
  amount: number,
  notes?: string
): HistoricalDailySales {
  return {
    id: `prep-${businessDate}`,
    business_date: businessDate,
    source: 'BUSINESS_PROVIDED_HISTORICAL',
    source_type: 'BUSINESS_PROVIDED_HISTORICAL',
    status: 'UNRESOLVED',
    approval_status: 'PENDING_APPROVAL',
    source_reference: 'Financial Data Owner Supplied Figures (2026-09-04)',
    evidence_notes: notes || 'Historical figure supplied for preparation; pending Financial Data Owner approval',
    preparer: 'Financial Preparation Layer',
    reviewer: 'Financial Data Owner / Business Owner',
    approval_timestamp: undefined,
    audit_trail: [
      {
        action: 'PREPARED_UNAPPROVED',
        timestamp: '2026-09-04T12:00:00.000Z',
        actor: 'Financial Preparation Layer',
        details: `Prepared unapproved historical sales figure KES ${amount.toLocaleString()} for ${businessDate}`,
      },
    ],
    transaction_count: 0, // Invariant: Cannot create POS transactions
    gross_sales: amount,
    discounts: 0,
    refunds: 0,
    tax: 0,
    net_sales: amount,
    cash_sales: amount,
    mpesa_sales: 0,
    other_sales: 0,
    eod_total: amount,
    notes: notes || 'Business-provided historical figure pending approval',
    created_at: '2026-09-04T12:00:00.000Z',
    updated_at: '2026-09-04T12:00:00.000Z',
    sync_status: 'pending',
    is_locked: false,
  };
}

/**
 * Return all 30 prepared unapproved August historical records (excluding August 11).
 */
export function getPreparedAugustHistoricalRecords(): HistoricalDailySales[] {
  const records: HistoricalDailySales[] = [];
  for (const [date, amount] of Object.entries(AUGUST_2026_HISTORICAL_FIGURES)) {
    if (amount !== null && date.startsWith('2026-08')) {
      records.push(createPreparedHistoricalRecord(date, amount));
    }
  }
  return records;
}

/**
 * Return prepared September 1–3 historical records.
 */
export function getPreparedSeptemberHistoricalRecords(): HistoricalDailySales[] {
  const records: HistoricalDailySales[] = [];
  for (const [date, amount] of Object.entries(SEPTEMBER_2026_HISTORICAL_FIGURES)) {
    if (amount !== null && date.startsWith('2026-09')) {
      records.push(createPreparedHistoricalRecord(date, amount, 'September historical figure'));
    }
  }
  return records;
}

/**
 * Verify whether a historical record is officially approved.
 * Invariant: Must possess VERIFIED_MANUAL status and an approved reviewer timestamp.
 */
export function isHistoricalRecordApproved(record: HistoricalDailySales): boolean {
  return (
    record.approval_status === 'VERIFIED_MANUAL' &&
    typeof record.approval_timestamp === 'string' &&
    record.approval_timestamp.length > 0 &&
    typeof record.approved_by === 'string' &&
    record.approved_by.length > 0
  );
}

/**
 * Invariant: Historical figures cannot create synthetic POS transactions.
 */
export function assertNoSyntheticTransactions(records: HistoricalDailySales[]): void {
  for (const r of records) {
    if (r.transaction_count > 0 && r.source === 'BUSINESS_PROVIDED_HISTORICAL') {
      throw new Error(
        `Safety Violation: Historical figure for ${r.business_date} cannot create synthetic POS transactions.`
      );
    }
  }
}

/**
 * Authoritative dual-track reconciliation engine comparing:
 * 1. POS-recovered daily total (with August 28 sandbox tests excluded)
 * 2. Business-provided historical daily total
 * 3. Variance / Difference
 * 4. Final Classification (MATCH / CROSS_VALIDATED, CONFLICTING / INVESTIGATION_REQUIRED, HISTORICAL_PENDING_APPROVAL, POS_RECOVERED_ONLY, MISSING_DATA)
 * 5. Full audit evidence
 */
export function buildDualSourceAugustReconciliation(
  transactions: Transaction[] = [],
  historicalMap: Readonly<Record<string, number | null>> = AUGUST_2026_HISTORICAL_FIGURES
): DualSourceReconciliationRow[] {
  const txByDate = new Map<string, { total: number; count: number }>();

  for (const tx of transactions) {
    if (tx.status === 'voided' || !tx.created_at) continue;
    const dateKey = tx.created_at.slice(0, 10);
    if (!dateKey.startsWith('2026-08')) continue;

    // Critical August 28 Rule:
    // Both KES 7,000 (Cash) and KES 200 (KCB Buni) were sandbox/test executions.
    // They must be excluded from production sales.
    if (dateKey === '2026-08-28') {
      continue;
    }

    const current = txByDate.get(dateKey) || { total: 0, count: 0 };
    current.total += Number(tx.total_amount || 0);
    current.count += 1;
    txByDate.set(dateKey, current);
  }

  const rows: DualSourceReconciliationRow[] = [];

  for (let day = 1; day <= 31; day++) {
    const dateKey = formatDateKey(2026, 8, day);
    const dateObj = new Date(2026, 7, day);
    const dayName = DAY_NAMES[dateObj.getDay()];

    const posData = txByDate.get(dateKey);
    const posRecovered = posData !== undefined && posData.count > 0 ? posData.total : null;
    const posCount = posData ? posData.count : 0;
    const historicalVal = historicalMap[dateKey] !== undefined ? historicalMap[dateKey] : null;

    let diff: number | null = null;
    let finalStatus: DualSourceReconciliationStatus;
    let sourceAvail: SourceAvailability;
    let reconStatus: ReconciliationStatusDimension;
    let evidenceStrength: EvidenceStrength;
    const approvalStatus: AuditApprovalStatus = 'PENDING_APPROVAL';
    const acceptedAmount: number | null = null;
    let evidence = '';

    if (posRecovered !== null && historicalVal !== null) {
      sourceAvail = 'BOTH_PRESENT';
    } else if (posRecovered !== null) {
      sourceAvail = 'POS_PRESENT';
    } else if (historicalVal !== null) {
      sourceAvail = 'HISTORICAL_PRESENT';
    } else {
      sourceAvail = 'NEITHER_PRESENT';
    }

    if (dateKey === '2026-08-28') {
      diff = null;
      finalStatus = 'HISTORICAL_PENDING_APPROVAL';
      reconStatus = 'HISTORICAL_ONLY';
      evidenceStrength = 'BUSINESS_PROVIDED_HISTORICAL';
      evidence = 'POS contained sandbox tests (KES 7,000 + KES 200 excluded); Actual production sales KES 81,860 pending approval';
    } else if (dateKey === '2026-08-11') {
      diff = null;
      finalStatus = posRecovered !== null ? 'POS_RECOVERED_ONLY' : 'MISSING_DATA';
      reconStatus = posRecovered !== null ? 'POS_ONLY' : 'UNRESOLVED';
      evidenceStrength = posRecovered !== null ? 'PRIMARY_POS_COMPLETE' : 'INSUFFICIENT_EVIDENCE';
      evidence =
        posRecovered !== null
          ? `Business provided NO historical data; POS backup contains ${posCount} txns totaling KES ${posRecovered.toLocaleString()} (Pending Approval)`
          : 'No POS data and No historical data';
    } else if (posRecovered !== null && historicalVal !== null) {
      diff = historicalVal - posRecovered;
      if (Math.abs(diff) < 0.01) {
        finalStatus = 'MATCH / CROSS_VALIDATED';
        reconStatus = 'EXACT_MATCH';
        evidenceStrength = 'PRIMARY_POS_COMPLETE';
        evidence = 'POS transactions & business historical figure match exactly';
      } else {
        finalStatus = 'CONFLICTING / INVESTIGATION_REQUIRED';
        reconStatus = 'CONFLICTING';
        evidenceStrength =
          dateKey === '2026-08-29' || dateKey === '2026-08-30'
            ? 'PRIMARY_POS_PARTIAL'
            : 'BUSINESS_PROVIDED_HISTORICAL';
        const sign = diff > 0 ? '+' : '-';
        evidence = `POS has KES ${posRecovered.toLocaleString()}, Business provided KES ${historicalVal.toLocaleString()} (Variance: ${sign}KES ${Math.abs(
          diff
        ).toLocaleString()})`;
      }
    } else if (posRecovered === null && historicalVal !== null) {
      finalStatus = 'HISTORICAL_PENDING_APPROVAL';
      reconStatus = 'HISTORICAL_ONLY';
      evidenceStrength = 'BUSINESS_PROVIDED_HISTORICAL';
      evidence = 'No POS entries recorded in backup; Business supplied historical figure pending approval';
    } else if (posRecovered !== null && historicalVal === null) {
      finalStatus = 'POS_RECOVERED_ONLY';
      reconStatus = 'POS_ONLY';
      evidenceStrength = 'PRIMARY_POS_COMPLETE';
      evidence = `POS has ${posCount} transactions totaling KES ${posRecovered.toLocaleString()}; Business provided no historical data`;
    } else {
      finalStatus = 'MISSING_DATA';
      reconStatus = 'UNRESOLVED';
      evidenceStrength = 'INSUFFICIENT_EVIDENCE';
      evidence = 'Open business day: Neither POS data nor historical data entered';
    }

    rows.push({
      date: dateKey,
      day_name: dayName,
      day_number: day,
      is_open: true, // Operating rule: All 31 days open
      pos_recovered_amount: posRecovered,
      pos_transaction_count: posCount,
      historical_figure: historicalVal,
      difference: diff,
      final_status: finalStatus,
      source_availability: sourceAvail,
      reconciliation_status: reconStatus,
      evidence_strength: evidenceStrength,
      approval_status: approvalStatus,
      accepted_amount: acceptedAmount,
      evidence,
      is_sandbox_excluded: dateKey === '2026-08-28',
    });
  }

  return rows;
}

