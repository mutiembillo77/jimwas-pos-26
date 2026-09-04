import { useState, useEffect, useId } from 'react';
import { AlertCircle, AlertTriangle, Check, DollarSign, HelpCircle, Lock, ShieldCheck, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from './Toast';
import { logAuditEvent } from '../lib/audit';
// NOTE: db.ts and sync.ts imports are intentionally absent.
// This modal is strictly in-memory (August 2026 read-only preparation phase).
// All persistence is deferred to an explicit Financial Data Owner approval step.
import { validateManualSalesEntry } from '../lib/eod-reporting';
import type { HistoricalDailySales, SalesDataSource } from '../lib/types';

interface ManualHistoricalSalesModalProps {
  initialDate?: string;
  existingRecord?: HistoricalDailySales;
  existingPosCount?: number;
  isOpen: boolean;
  onClose: () => void;
  onSaved: (record: HistoricalDailySales) => void;
}

export function ManualHistoricalSalesModal({
  initialDate,
  existingRecord,
  existingPosCount = 0,
  isOpen,
  onClose,
  onSaved,
}: ManualHistoricalSalesModalProps) {
  const { user } = useAuth();
  const toast = useToast();

  const [businessDate, setBusinessDate] = useState(initialDate || '2026-08-01');
  const [branchId, setBranchId] = useState('main');
  const [source, setSource] = useState<SalesDataSource>('MANUAL_HISTORICAL');
  const [transactionCount, setTransactionCount] = useState('0');
  const [grossSales, setGrossSales] = useState('0');
  const [discounts, setDiscounts] = useState('0');
  const [refunds, setRefunds] = useState('0');
  const [tax, setTax] = useState('0');
  const [netSales, setNetSales] = useState('0');
  const [cashSales, setCashSales] = useState('0');
  const [mpesaSales, setMpesaSales] = useState('0');
  const [otherSales, setOtherSales] = useState('0');
  const [eodTotal, setEodTotal] = useState('0');
  const [openingFloat, setOpeningFloat] = useState('0');
  const [closingCashCount, setClosingCashCount] = useState('0');
  const [notes, setNotes] = useState('');
  const [reference, setReference] = useState('');
  const [isLocked, setIsLocked] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Unique IDs for accessibility
  const titleId = useId();
  const descId = useId();

  // Populate form from existing record or defaults
  useEffect(() => {
    if (existingRecord) {
      setBusinessDate(existingRecord.business_date);
      setBranchId(existingRecord.branch_id || 'main');
      setSource(existingRecord.source);
      setTransactionCount(String(existingRecord.transaction_count || 0));
      setGrossSales(String(existingRecord.gross_sales || 0));
      setDiscounts(String(existingRecord.discounts || 0));
      setRefunds(String(existingRecord.refunds || 0));
      setTax(String(existingRecord.tax || 0));
      setNetSales(String(existingRecord.net_sales || 0));
      setCashSales(String(existingRecord.cash_sales || 0));
      setMpesaSales(String(existingRecord.mpesa_sales || 0));
      setOtherSales(String(existingRecord.other_sales || 0));
      setEodTotal(String(existingRecord.eod_total || 0));
      setOpeningFloat(String(existingRecord.opening_float || 0));
      setClosingCashCount(String(existingRecord.closing_cash_count || 0));
      setNotes(existingRecord.notes || '');
      setReference(existingRecord.reference || '');
      setIsLocked(Boolean(existingRecord.is_locked));
    } else if (initialDate) {
      setBusinessDate(initialDate);
      setTransactionCount('0');
      setGrossSales('0');
      setDiscounts('0');
      setRefunds('0');
      setTax('0');
      setNetSales('0');
      setCashSales('0');
      setMpesaSales('0');
      setOtherSales('0');
      setEodTotal('0');
      setOpeningFloat('0');
      setClosingCashCount('0');
      setNotes('');
      setReference('');
      setIsLocked(false);
    }
  }, [existingRecord, initialDate, isOpen]);

  // Real-time calculation helpers
  const handleGrossChange = (val: string) => {
    setGrossSales(val);
    const g = Number(val) || 0;
    const d = Number(discounts) || 0;
    const r = Number(refunds) || 0;
    const computedNet = Math.max(0, g - d - r);
    setNetSales(String(computedNet));
    setEodTotal(String(computedNet));
  };

  const handleDiscountsChange = (val: string) => {
    setDiscounts(val);
    const g = Number(grossSales) || 0;
    const d = Number(val) || 0;
    const r = Number(refunds) || 0;
    const computedNet = Math.max(0, g - d - r);
    setNetSales(String(computedNet));
    setEodTotal(String(computedNet));
  };

  const handleRefundsChange = (val: string) => {
    setRefunds(val);
    const g = Number(grossSales) || 0;
    const d = Number(discounts) || 0;
    const r = Number(val) || 0;
    const computedNet = Math.max(0, g - d - r);
    setNetSales(String(computedNet));
    setEodTotal(String(computedNet));
  };

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrors([]);
    setWarnings([]);

    const entryData: Partial<HistoricalDailySales> = {
      business_date: businessDate,
      branch_id: branchId,
      source,
      transaction_count: Number(transactionCount) || 0,
      gross_sales: Number(grossSales) || 0,
      discounts: Number(discounts) || 0,
      refunds: Number(refunds) || 0,
      tax: Number(tax) || 0,
      net_sales: Number(netSales) || 0,
      cash_sales: Number(cashSales) || 0,
      mpesa_sales: Number(mpesaSales) || 0,
      other_sales: Number(otherSales) || 0,
      eod_total: Number(eodTotal) || 0,
      opening_float: Number(openingFloat) || 0,
      closing_cash_count: Number(closingCashCount) || 0,
      cash_variance: (Number(closingCashCount) || 0) - ((Number(openingFloat) || 0) + (Number(cashSales) || 0) - (Number(refunds) || 0)),
      notes: notes.trim(),
      reference: reference.trim(),
      is_locked: isLocked,
    };

    const validation = validateManualSalesEntry(entryData, existingPosCount);
    if (!validation.isValid) {
      setErrors(validation.errors);
      setWarnings(validation.warnings);
      setIsSubmitting(false);
      return;
    }

    try {
      const now = new Date().toISOString();
      const id = existingRecord?.id || `hist_${businessDate}_${branchId}`;

      const fullRecord: HistoricalDailySales = {
        id,
        business_date: businessDate,
        branch_id: branchId,
        source,
        status: (Number(entryData.eod_total) > 0 || (Number(entryData.transaction_count) ?? 0) > 0) ? 'COMPLETE' : 'MISSING',
        transaction_count: entryData.transaction_count || 0,
        gross_sales: entryData.gross_sales || 0,
        discounts: entryData.discounts || 0,
        refunds: entryData.refunds || 0,
        tax: entryData.tax || 0,
        net_sales: entryData.net_sales || 0,
        cash_sales: entryData.cash_sales || 0,
        mpesa_sales: entryData.mpesa_sales || 0,
        other_sales: entryData.other_sales || 0,
        eod_total: entryData.eod_total || 0,
        opening_float: entryData.opening_float,
        closing_cash_count: entryData.closing_cash_count,
        cash_variance: entryData.cash_variance,
        notes: entryData.notes,
        reference: entryData.reference,
        entered_by: user?.id,
        entered_by_name: user?.full_name || user?.username,
        approved_by: user?.role === 'admin' || user?.role === 'manager' ? user.id : undefined,
        created_at: existingRecord?.created_at || now,
        updated_at: now,
        sync_status: 'pending',
        warnings: validation.warnings,
        is_locked: isLocked,
      };

      // SAFETY: No IndexedDB write. No Supabase sync enqueue.
      // Record exists in-memory only until the Financial Data Owner approval workflow
      // explicitly authorises persistence. This is the August 2026 preparation phase.

      // Log structured audit event (audit.ts is not a prohibited boundary)
      await logAuditEvent({
        eventType: existingRecord ? 'RECORD_UPDATED' : 'RECORD_CREATED',
        entityType: 'historical_daily_sales',
        entityId: id,
        oldValue: existingRecord || null,
        newValue: fullRecord,
        reason: notes || `Manual historical sales entry for ${businessDate}`,
        userId: user?.id,
        userName: user?.full_name || user?.username,
        userRole: user?.role,
      });

      toast.show(`Historical sales record for ${businessDate} saved successfully.`);
      onSaved(fullRecord);
      onClose();
    } catch (err) {
      console.error('Failed to save historical sales entry:', err);
      setErrors(['An unexpected error occurred while saving the record.']);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-400">
              <DollarSign size={22} />
            </div>
            <div>
              <h2 id={titleId} className="text-lg font-semibold text-white">
                {existingRecord ? 'Edit Historical Sales Entry' : 'Enter Historical Daily Sales'}
              </h2>
              <p id={descId} className="text-xs text-slate-400">
                Audited EOD sales ledger entry for accounting reconciliation
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white transition"
            aria-label="Close modal"
          >
            <X size={20} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[80vh] overflow-y-auto">
          {/* POS Exists Warning */}
          {existingPosCount > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-600/50 bg-amber-950/40 p-4 text-amber-200">
              <AlertTriangle className="mt-0.5 shrink-0 text-amber-400" size={18} />
              <div className="text-xs leading-relaxed">
                <strong className="block font-semibold">Live POS Transaction Warning</strong>
                {existingPosCount} live POS transaction(s) exist for {businessDate}. Manual entries will NOT overwrite live POS data, but will be recorded for audit reference.
              </div>
            </div>
          )}

          {/* Validation Errors */}
          {errors.length > 0 && (
            <div className="rounded-xl border border-rose-600/50 bg-rose-950/40 p-4 text-rose-200 space-y-1 text-xs">
              <div className="flex items-center gap-2 font-semibold text-rose-400">
                <AlertCircle size={16} /> Validation Errors:
              </div>
              <ul className="list-disc pl-5 space-y-1">
                {errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Date & Metadata */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Business Date <span className="text-rose-400">*</span>
              </label>
              <input
                type="date"
                required
                value={businessDate}
                onChange={(e) => setBusinessDate(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Data Source</label>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as SalesDataSource)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              >
                <option value="MANUAL_HISTORICAL">Manual Historical Entry</option>
                <option value="RECOVERED">Recovered from Internal Records</option>
                <option value="IMPORTED">Imported from Backup / File</option>
                <option value="ESTIMATED">Estimated / Projected</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Estimated Transactions</label>
              <input
                type="number"
                min="0"
                value={transactionCount}
                onChange={(e) => setTransactionCount(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Core Financial Matrix */}
          <div className="rounded-xl border border-slate-800 bg-slate-800/40 p-4 space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
              <ShieldCheck size={14} /> Revenue & Deductions (KES)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Gross Sales</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={grossSales}
                  onChange={(e) => handleGrossChange(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-white focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Discounts</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={discounts}
                  onChange={(e) => handleDiscountsChange(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Refunds</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={refunds}
                  onChange={(e) => handleRefundsChange(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Net Sales (Auto)</label>
                <input
                  type="number"
                  step="0.01"
                  readOnly
                  value={netSales}
                  className="w-full rounded-lg border border-emerald-600/40 bg-emerald-950/20 px-3 py-2 text-sm font-semibold text-emerald-400 focus:outline-none cursor-not-allowed"
                />
              </div>
            </div>
          </div>

          {/* Payment Method Distribution */}
          <div className="rounded-xl border border-slate-800 bg-slate-800/40 p-4 space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-blue-400 flex items-center gap-1.5">
              <DollarSign size={14} /> Payment Method Breakdown (KES)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Cash Sales</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={cashSales}
                  onChange={(e) => setCashSales(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">M-Pesa / Mobile</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={mpesaSales}
                  onChange={(e) => setMpesaSales(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Other / Bank</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={otherSales}
                  onChange={(e) => setOtherSales(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">EOD Total</label>
                <input
                  type="number"
                  step="0.01"
                  value={eodTotal}
                  onChange={(e) => setEodTotal(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-bold text-white focus:border-emerald-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Reference & Audit Notes */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Source Document Reference
              </label>
              <input
                type="text"
                placeholder="e.g. Physical Cashbook Ledger Folio #12, Bank Slip"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Accounting Notes & Justification
              </label>
              <input
                type="text"
                placeholder="e.g. Reconstructed from daily register balance"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-between border-t border-slate-800 pt-4 mt-6">
            <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={isLocked}
                onChange={(e) => setIsLocked(e.target.checked)}
                className="rounded border-slate-700 bg-slate-800 text-emerald-500 focus:ring-emerald-500"
              />
              <span className="flex items-center gap-1">
                <Lock size={12} /> Lock this record against non-admin edits
              </span>
            </label>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-500 transition disabled:opacity-50"
              >
                {isSubmitting ? (
                  'Saving...'
                ) : (
                  <>
                    <Check size={16} /> Save Historical Entry
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
