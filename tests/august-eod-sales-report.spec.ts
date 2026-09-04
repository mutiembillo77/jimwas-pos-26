import { describe, it, expect } from 'vitest';
import {
  AUGUST_2026_HISTORICAL_FIGURES,
  SEPTEMBER_2026_HISTORICAL_FIGURES,
  assertNoSyntheticTransactions,
  buildDailySalesReport,
  buildDualSourceAugustReconciliation,
  createPreparedHistoricalRecord,
  formatDateKey,
  generateAugustSalesReportCsv,
  getAugustKnownHistoricalTotal,
  getPreparedAugustHistoricalRecords,
  getSeptemberKnownHistoricalTotal,
  isHistoricalRecordApproved,
  validateManualSalesEntry,
  validateMonthIsolation,
} from '../src/lib/eod-reporting';
import type { HistoricalDailySales, Transaction } from '../src/lib/types';

describe('August 2026 EOD Sales Report & Reconciliation Engine', () => {
  it('should generate all 31 calendar days for August 2026 without skipping any date', () => {
    const report = buildDailySalesReport([], [], [], 2026, 8);

    expect(report.month_label).toBe('August 2026');
    expect(report.year).toBe(2026);
    expect(report.month).toBe(8);
    expect(report.total_calendar_days).toBe(31);
    expect(report.daily_rows).toHaveLength(31);

    // Verify day sequence from 1 to 31
    for (let day = 1; day <= 31; day++) {
      const expectedDate = formatDateKey(2026, 8, day);
      const row = report.daily_rows[day - 1];
      expect(row.day_number).toBe(day);
      expect(row.date).toBe(expectedDate);
    }
  });

  it('should strictly classify empty dates as MISSING rather than VERIFIED_ZERO or closed', () => {
    const report = buildDailySalesReport([], [], [], 2026, 8);

    expect(report.missing_days).toBe(31);
    expect(report.trading_days).toBe(0);

    for (const row of report.daily_rows) {
      expect(row.status).toBe('MISSING');
      expect(row.warnings).toContain('MISSING — MANUAL ENTRY REQUIRED');
      expect(row.is_editable).toBe(true);
    }
  });

  it('should accurately aggregate POS transactions into daily EOD totals', () => {
    const mockTransactions: Transaction[] = [
      {
        id: 'tx-aug06-1',
        total_amount: 50000,
        amount_paid: 50000,
        payment_method: 'cash',
        status: 'completed',
        created_at: '2026-08-06T10:00:00Z',
        items: [],
      },
      {
        id: 'tx-aug06-2',
        total_amount: 16650,
        amount_paid: 16650,
        payment_method: 'cash',
        status: 'completed',
        created_at: '2026-08-06T14:30:00Z',
        items: [],
      },
      {
        id: 'tx-aug06-void',
        total_amount: 10000,
        amount_paid: 0,
        payment_method: 'cash',
        status: 'voided', // Should be ignored in EOD net totals
        created_at: '2026-08-06T15:00:00Z',
        items: [],
      },
    ];

    const report = buildDailySalesReport(mockTransactions, [], [], 2026, 8);
    const aug06Row = report.daily_rows.find((r) => r.date === '2026-08-06');

    expect(aug06Row).toBeDefined();
    expect(aug06Row?.transaction_count).toBe(2);
    expect(aug06Row?.gross_sales).toBe(66650);
    expect(aug06Row?.cash_sales).toBe(66650);
    expect(aug06Row?.net_sales).toBe(66650);
    expect(aug06Row?.eod_total).toBe(66650);
    expect(aug06Row?.source).toBe('POS_TRANSACTION');
    expect(aug06Row?.status).toBe('COMPLETE');
  });

  it('should correctly prioritize and format RECOVERED historical records', () => {
    const mockRecoveredRecord: HistoricalDailySales = {
      id: 'rec-2026-08-26',
      business_date: '2026-08-26',
      source: 'RECOVERED',
      status: 'RECONCILED',
      transaction_count: 17,
      gross_sales: 80350,
      discounts: 0,
      refunds: 0,
      tax: 0,
      net_sales: 80350,
      cash_sales: 80350,
      mpesa_sales: 0,
      other_sales: 0,
      eod_total: 80350,
      notes: 'Recovered from backup 2026-08-31 & cross-verified with PDF',
      created_at: '2026-09-03T12:00:00Z',
      updated_at: '2026-09-03T12:00:00Z',
      sync_status: 'synced',
    };

    const report = buildDailySalesReport([], [], [mockRecoveredRecord], 2026, 8);
    const aug26Row = report.daily_rows.find((r) => r.date === '2026-08-26');

    expect(aug26Row).toBeDefined();
    expect(aug26Row?.source).toBe('RECOVERED');
    expect(aug26Row?.status).toBe('RECONCILED');
    expect(aug26Row?.gross_sales).toBe(80350);
    expect(aug26Row?.cash_sales).toBe(80350);
    expect(aug26Row?.transaction_count).toBe(17);
  });

  describe('Validation Engine (validateManualSalesEntry)', () => {
    it('should validate complete and mathematically sound manual historical entries', () => {
      const validEntry: Partial<HistoricalDailySales> = {
        business_date: '2026-08-01',
        gross_sales: 10000,
        discounts: 500,
        refunds: 0,
        net_sales: 9500,
        cash_sales: 9500,
        mpesa_sales: 0,
        other_sales: 0,
      };

      const result = validateManualSalesEntry(validEntry, 0);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should flag negative sales or invalid discounts', () => {
      const invalidEntry: Partial<HistoricalDailySales> = {
        business_date: '2026-08-02',
        gross_sales: -100,
        discounts: 200,
        refunds: -50,
      };

      const result = validateManualSalesEntry(invalidEntry, 0);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Gross sales cannot be negative.');
      expect(result.errors).toContain('Refunds cannot be negative.');
      expect(result.errors).toContain('Discounts cannot exceed gross sales.');
    });

    it('should warn when payment breakdown mismatches net sales', () => {
      const mismatchEntry: Partial<HistoricalDailySales> = {
        business_date: '2026-08-03',
        gross_sales: 10000,
        discounts: 0,
        refunds: 0,
        net_sales: 10000,
        cash_sales: 5000,
        mpesa_sales: 3000, // Total 8,000 != 10,000
        other_sales: 0,
      };

      const result = validateManualSalesEntry(mismatchEntry, 0);
      expect(result.warnings.some((w) => w.includes('does not match Net Sales'))).toBe(true);
    });

    it('should issue a warning when attempting manual entry for dates with existing POS transactions', () => {
      const entry: Partial<HistoricalDailySales> = {
        business_date: '2026-08-06',
        gross_sales: 66650,
        net_sales: 66650,
        cash_sales: 66650,
      };

      const result = validateManualSalesEntry(entry, 12);
      expect(result.warnings.some((w) => w.includes('POS transaction data (12 transactions) already exists'))).toBe(true);
    });
  });

  it('should group 31 days into 5 business weeks and compute weekly rollups', () => {
    const report = buildDailySalesReport([], [], [], 2026, 8);

    expect(report.weeks.length).toBeGreaterThanOrEqual(5);

    // Verify all days in month are covered by the weeks
    const allWeekDays = report.weeks.flatMap((w) => w.days);
    expect(allWeekDays).toHaveLength(31);
    expect(allWeekDays[0].date).toBe('2026-08-01');
    expect(allWeekDays[30].date).toBe('2026-08-31');
  });

  it('should generate properly structured CSV with audit metadata', () => {
    const report = buildDailySalesReport([], [], [], 2026, 8);
    const csv = generateAugustSalesReportCsv(report);

    expect(csv).toContain('Date,Day,Gross Sales (KES)');
    expect(csv).toContain('--- AUGUST 2026 MONTH-END SUMMARY ---');
    expect(csv).toContain('"2026-08-01"');
    expect(csv).toContain('"2026-08-31"');
    expect(csv).toContain('Total Calendar Days,31');
    expect(csv).toContain('TOTAL EOD SALES,0.00');
  });

  // ==========================================================================
  // READ-ONLY HISTORICAL PREPARATION & DUAL-SOURCE RECONCILIATION TESTS
  // ==========================================================================

  describe('Historical Sales Figures — Read-Only Preparation & Invariants', () => {
    it('should accurately calculate known historical August sales as KES 1,855,115 (30 days, excl Aug 11)', () => {
      const knownTotal = getAugustKnownHistoricalTotal();
      expect(knownTotal).toBe(1855115);
    });

    it('should strictly keep August 11 as null / unresolved in the historical dataset (no auto zero)', () => {
      expect(AUGUST_2026_HISTORICAL_FIGURES['2026-08-11']).toBeNull();
      const preparedRecords = getPreparedAugustHistoricalRecords();
      const aug11Record = preparedRecords.find((r) => r.business_date === '2026-08-11');
      expect(aug11Record).toBeUndefined(); // Must not create an approved or zero record for Aug 11
    });

    it('should enforce August 28 production sales as KES 81,860 with KES 7,000 sandbox excluded', () => {
      expect(AUGUST_2026_HISTORICAL_FIGURES['2026-08-28']).toBe(81860);

      const reconciliation = buildDualSourceAugustReconciliation([
        {
          id: 'tx-aug28-sandbox-cash',
          total_amount: 7000,
          amount_paid: 7000,
          payment_method: 'cash',
          status: 'completed',
          created_at: '2026-08-28T16:00:00Z',
          items: [],
        },
        {
          id: 'tx-aug28-sandbox-kcb',
          total_amount: 200,
          amount_paid: 200,
          payment_method: 'kcb_buni',
          status: 'completed',
          created_at: '2026-08-28T17:04:35Z',
          items: [],
        },
      ]);

      const aug28Row = reconciliation.find((r) => r.date === '2026-08-28');
      expect(aug28Row).toBeDefined();
      expect(aug28Row?.is_sandbox_excluded).toBe(true);
      expect(aug28Row?.pos_recovered_amount).toBeNull(); // KES 7,000 and KES 200 excluded
      expect(aug28Row?.historical_figure).toBe(81860);
      expect(aug28Row?.final_status).toBe('HISTORICAL_PENDING_APPROVAL');
    });

    it('should record September 1–3 as KES 174,060 and isolate September from August', () => {
      const septTotal = getSeptemberKnownHistoricalTotal();
      expect(septTotal).toBe(174060);
      expect(SEPTEMBER_2026_HISTORICAL_FIGURES['2026-09-01']).toBe(45060);
      expect(SEPTEMBER_2026_HISTORICAL_FIGURES['2026-09-02']).toBe(101000);
      expect(SEPTEMBER_2026_HISTORICAL_FIGURES['2026-09-03']).toBe(28000);

      // Verify strict month isolation
      const augDates = Object.keys(AUGUST_2026_HISTORICAL_FIGURES);
      const septDates = Object.keys(SEPTEMBER_2026_HISTORICAL_FIGURES);

      expect(validateMonthIsolation(8, augDates)).toBe(true);
      expect(validateMonthIsolation(9, septDates)).toBe(true);
      expect(validateMonthIsolation(8, septDates)).toBe(false); // September cannot pass August validation
    });

    it('should enforce that historical figures cannot create synthetic POS transactions or mutate inventory', () => {
      const preparedRecords = getPreparedAugustHistoricalRecords();
      expect(preparedRecords).toHaveLength(30);

      for (const record of preparedRecords) {
        expect(record.transaction_count).toBe(0); // Zero synthetic transactions
        expect(record.source).toBe('BUSINESS_PROVIDED_HISTORICAL');
        expect(record.source_type).toBe('BUSINESS_PROVIDED_HISTORICAL');
      }

      // Invariant assertion function does not throw on valid preparation records
      expect(() => assertNoSyntheticTransactions(preparedRecords)).not.toThrow();

      // Invariant assertion throws if someone sets a fake transaction count
      const fakeRecord: HistoricalDailySales = {
        ...preparedRecords[0],
        transaction_count: 5,
      };
      expect(() => assertNoSyntheticTransactions([fakeRecord])).toThrow(/cannot create synthetic POS transactions/);
    });

    it('should enforce that unapproved historical figures cannot be treated as approved financial records', () => {
      const prepared = createPreparedHistoricalRecord('2026-08-01', 77170);

      expect(prepared.approval_status).toBe('PENDING_APPROVAL');
      expect(prepared.approval_timestamp).toBeUndefined();
      expect(isHistoricalRecordApproved(prepared)).toBe(false);

      // Only officially signed-off records pass approval verification
      const approved: HistoricalDailySales = {
        ...prepared,
        approval_status: 'VERIFIED_MANUAL',
        approved_by: 'owner-charles',
        approval_timestamp: '2026-09-04T15:00:00Z',
      };
      expect(isHistoricalRecordApproved(approved)).toBe(true);
    });

    it('should perform dual-source conflict & match detection accurately across all 31 days', () => {
      // Mock recovered transactions for Aug 13 (match), Aug 26 (match), Aug 06 (conflict)
      const mockTxns: Transaction[] = [
        // Aug 13 exact match: 47,800
        {
          id: 'tx-aug13',
          total_amount: 47800,
          amount_paid: 47800,
          payment_method: 'cash',
          status: 'completed',
          created_at: '2026-08-13T12:00:00Z',
          items: [],
        },
        // Aug 26 exact match: 80,350
        {
          id: 'tx-aug26',
          total_amount: 80350,
          amount_paid: 80350,
          payment_method: 'cash',
          status: 'completed',
          created_at: '2026-08-26T12:00:00Z',
          items: [],
        },
        // Aug 06 conflict: POS has 66,650 vs Historical has 69,550
        {
          id: 'tx-aug06',
          total_amount: 66650,
          amount_paid: 66650,
          payment_method: 'cash',
          status: 'completed',
          created_at: '2026-08-06T12:00:00Z',
          items: [],
        },
        // Aug 11: POS has 47,700, Historical has no data
        {
          id: 'tx-aug11',
          total_amount: 47700,
          amount_paid: 47700,
          payment_method: 'cash',
          status: 'completed',
          created_at: '2026-08-11T12:00:00Z',
          items: [],
        },
      ];

      const reconciliation = buildDualSourceAugustReconciliation(mockTxns);
      expect(reconciliation).toHaveLength(31);

      // Aug 26 match check
      const aug26 = reconciliation.find((r) => r.date === '2026-08-26');
      expect(aug26?.pos_recovered_amount).toBe(80350);
      expect(aug26?.historical_figure).toBe(80350);
      expect(aug26?.difference).toBe(0);
      expect(aug26?.final_status).toBe('MATCH / CROSS_VALIDATED');

      // Aug 13 match check
      const aug13 = reconciliation.find((r) => r.date === '2026-08-13');
      expect(aug13?.pos_recovered_amount).toBe(47800);
      expect(aug13?.historical_figure).toBe(47800);
      expect(aug13?.difference).toBe(0);
      expect(aug13?.final_status).toBe('MATCH / CROSS_VALIDATED');

      // Aug 06 conflict check
      const aug06 = reconciliation.find((r) => r.date === '2026-08-06');
      expect(aug06?.pos_recovered_amount).toBe(66650);
      expect(aug06?.historical_figure).toBe(69550);
      expect(aug06?.difference).toBe(2900);
      expect(aug06?.final_status).toBe('CONFLICTING / INVESTIGATION_REQUIRED');

      // Aug 11 POS only check
      const aug11 = reconciliation.find((r) => r.date === '2026-08-11');
      expect(aug11?.pos_recovered_amount).toBe(47700);
      expect(aug11?.historical_figure).toBeNull();
      expect(aug11?.final_status).toBe('POS_RECOVERED_ONLY');
    });
  });
});
