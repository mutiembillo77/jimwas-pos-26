import { useState, useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Edit3,
  FileSpreadsheet,
  Filter,
  Layers,
  Plus,
  Printer,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { getAllTransactions } from '../lib/db';
// NOTE: enterprise.ts import intentionally removed — prohibited boundary (uses db.ts + sync.ts internally).
// Shift records are not required for the August 2026 dual-source reconciliation view.
import {
  AUGUST_2026_HISTORICAL_FIGURES,
  SEPTEMBER_2026_HISTORICAL_FIGURES,
  buildDailySalesReport,
  buildDualSourceAugustReconciliation,
  generateAugustSalesReportCsv,
  getAugustKnownHistoricalTotal,
  getSeptemberKnownHistoricalTotal,
} from '../lib/eod-reporting';
import { ManualHistoricalSalesModal } from './ManualHistoricalSalesModal';
import type {
  DailySalesRow,
  HistoricalDailySales,
  MonthEndSalesSummary,
  ShiftRecord,
  Transaction,
} from '../lib/types';

const money = (value: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(value);

export function AugustSalesReportView() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [shifts] = useState<ShiftRecord[]>([]);
  const [manualEntries, setManualEntries] = useState<HistoricalDailySales[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Tab: 'reconciliation' (dual-track POS vs Historical) or 'ledger' (daily rows & weekly rollups)
  const [activeTab, setActiveTab] = useState<'reconciliation' | 'ledger'>('reconciliation');

  // Filters
  const [sourceFilter, setSourceFilter] = useState<string>('ALL');
  const [reconciliationStatusFilter, setReconciliationStatusFilter] = useState<string>('ALL');
  const [selectedWeek, setSelectedWeek] = useState<number | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalInitialDate, setModalInitialDate] = useState<string>('2026-08-01');
  const [modalExistingRecord, setModalExistingRecord] = useState<HistoricalDailySales | undefined>(undefined);
  const [modalExistingPosCount, setModalExistingPosCount] = useState<number>(0);

  const loadData = async () => {
    setIsLoading(true);
    try {
      // NOTE: Shifts not loaded — enterprise.ts removed (prohibited boundary).
      // NOTE: getAllHistoricalDailySales does not exist in HEAD db.ts.
      // manualEntries is populated in-memory via onSaved during this preparation phase.
      const txs = await getAllTransactions();
      setTransactions(txs);
    } catch (err) {
      console.error('Failed to load August sales report data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  // Compute 31-day authoritative August report summary
  const summary: MonthEndSalesSummary = useMemo(() => {
    return buildDailySalesReport(transactions, shifts, manualEntries, 2026, 8);
  }, [transactions, shifts, manualEntries]);

  // Filtered rows for the daily matrix
  const filteredDailyRows = useMemo(() => {
    return summary.daily_rows.filter((row) => {
      // Source filter
      if (sourceFilter !== 'ALL') {
        if (sourceFilter === 'MISSING' && row.status !== 'MISSING') return false;
        if (sourceFilter !== 'MISSING' && row.source !== sourceFilter) return false;
      }
      // Week filter
      if (selectedWeek !== 'ALL') {
        const matchingWeek = summary.weeks.find((w) => w.week_number === selectedWeek);
        if (matchingWeek && !matchingWeek.days.some((d) => d.date === row.date)) return false;
      }
      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const dateMatch = row.date.includes(q);
        const dayMatch = row.day_name.toLowerCase().includes(q);
        const sourceMatch = row.source.toLowerCase().includes(q);
        const noteMatch = row.manual_record?.notes?.toLowerCase().includes(q) || false;
        if (!dateMatch && !dayMatch && !sourceMatch && !noteMatch) return false;
      }
      return true;
    });
  }, [summary, sourceFilter, selectedWeek, searchQuery]);

  // Dual-source reconciliation rows (POS recovered vs Business provided historical)
  const dualReconciliationRows = useMemo(() => {
    return buildDualSourceAugustReconciliation(transactions, AUGUST_2026_HISTORICAL_FIGURES);
  }, [transactions]);

  const filteredDualRows = useMemo(() => {
    return dualReconciliationRows.filter((row) => {
      if (reconciliationStatusFilter !== 'ALL' && row.final_status !== reconciliationStatusFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const dateMatch = row.date.includes(q);
        const dayMatch = row.day_name.toLowerCase().includes(q);
        const statusMatch = row.final_status.toLowerCase().includes(q);
        const evidenceMatch = row.evidence.toLowerCase().includes(q);
        if (!dateMatch && !dayMatch && !statusMatch && !evidenceMatch) return false;
      }
      return true;
    });
  }, [dualReconciliationRows, reconciliationStatusFilter, searchQuery]);

  const knownAugustHistoricalTotal = getAugustKnownHistoricalTotal(); // KES 1,855,115
  const knownSeptemberTotal = getSeptemberKnownHistoricalTotal(); // KES 174,060
  const matchCount = useMemo(() => dualReconciliationRows.filter((r) => r.final_status === 'MATCH / CROSS_VALIDATED').length, [dualReconciliationRows]);
  const conflictCount = useMemo(() => dualReconciliationRows.filter((r) => r.final_status === 'CONFLICTING / INVESTIGATION_REQUIRED').length, [dualReconciliationRows]);
  const pendingApprovalCount = useMemo(() => dualReconciliationRows.filter((r) => r.final_status === 'HISTORICAL_PENDING_APPROVAL').length, [dualReconciliationRows]);
  const posOnlyCount = useMemo(() => dualReconciliationRows.filter((r) => r.final_status === 'POS_RECOVERED_ONLY').length, [dualReconciliationRows]);
  const totalPosProduction = useMemo(() => dualReconciliationRows.reduce((sum, r) => sum + (r.pos_recovered_amount || 0), 0), [dualReconciliationRows]);

  // Open modal for a specific day
  const handleOpenModalForDay = (row: DailySalesRow) => {
    setModalInitialDate(row.date);
    setModalExistingRecord(row.manual_record);
    setModalExistingPosCount(row.transaction_count);
    setIsModalOpen(true);
  };

  // Export CSV
  const handleExportCsv = () => {
    const csvContent = generateAugustSalesReportCsv(summary);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Jimwas_POS_August_2026_Sales_Report_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Actions */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">
            <Calendar size={14} /> Official Accounting Ledger
          </div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-white">
            August 2026 Sales & EOD Reconciliation Report
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Daily trading breakdowns, weekly rollups, data completeness matrix, and verified End-of-Day totals.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void loadData()}
            disabled={isLoading}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50 transition"
          >
            <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 transition"
          >
            <Printer size={16} /> Print / PDF
          </button>
          <button
            onClick={handleExportCsv}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 transition"
          >
            <FileSpreadsheet size={16} className="text-emerald-400" /> Export CSV
          </button>
          <button
            onClick={() => {
              setModalInitialDate('2026-08-01');
              setModalExistingRecord(undefined);
              setModalExistingPosCount(0);
              setIsModalOpen(true);
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 shadow-lg shadow-emerald-900/30 transition"
          >
            <Plus size={16} /> Enter Missing Day
          </button>
        </div>
      </div>

      {/* View Switcher Tabs */}
      <div className="flex border-b border-slate-800">
        <button
          onClick={() => setActiveTab('reconciliation')}
          className={`flex items-center gap-2 border-b-2 px-5 py-3 text-sm font-semibold transition ${
            activeTab === 'reconciliation'
              ? 'border-emerald-500 text-emerald-400 bg-emerald-950/20'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <ShieldCheck size={16} /> Dual-Source Reconciliation (POS vs Historical)
        </button>
        <button
          onClick={() => setActiveTab('ledger')}
          className={`flex items-center gap-2 border-b-2 px-5 py-3 text-sm font-semibold transition ${
            activeTab === 'ledger'
              ? 'border-emerald-500 text-emerald-400 bg-emerald-950/20'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers size={16} /> 31-Day Financial Ledger & Weekly Rollups
        </button>
      </div>

      {activeTab === 'reconciliation' ? (
        <div className="space-y-6">
          {/* Read-only preparation banner */}
          {/* Read-only audit evidence banner */}
          <div className="rounded-2xl border border-amber-500/40 bg-amber-950/20 p-5">
            <div className="flex items-start gap-3">
              <ShieldAlert className="mt-0.5 text-amber-400 shrink-0" size={20} />
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-amber-300 uppercase tracking-wider">
                  Forensic Audit & Report Interpretation Layer — Read-Only Evidence Standard
                </h3>
                <p className="text-xs leading-relaxed text-amber-200/80">
                  <strong>31/31 August calendar days have been classified; only 9 are currently exact source matches.</strong> Classification does not equal accounting verification.
                  Operating Rule: All 31 calendar days were OPEN business days. Absence of POS data does not mean zero sales.
                  August 28 actual production sales: KES 81,860 (KES 7,000 Cash and KES 200 KCB Buni sandbox tests excluded).
                  August 11 recovered POS shows KES 47,700 (POS_ONLY, PENDING_APPROVAL; no accounting figure inferred; business historical figure missing).
                </p>
              </div>
            </div>
          </div>

          {/* Key Totals Cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-emerald-600/30 bg-gradient-to-br from-emerald-950/40 via-slate-900 to-slate-900 p-5 shadow-xl">
              <p className="text-xs font-medium uppercase tracking-wider text-emerald-400">Known Historical Subtotal</p>
              <p className="mt-2 text-3xl font-extrabold text-white">{money(knownAugustHistoricalTotal)}</p>
              <p className="mt-2 text-xs text-slate-400 border-t border-slate-800/80 pt-2">
                Covering 30 of 31 August days (excl Aug 11)
              </p>
            </div>

            <div className="rounded-2xl border border-rose-500/30 bg-slate-900/80 p-5 shadow-xl">
              <p className="text-xs font-medium uppercase tracking-wider text-rose-400">August 11 Evidence</p>
              <p className="mt-2 text-2xl font-bold text-rose-300">POS: KES 47,700</p>
              <p className="mt-2 text-xs text-slate-400 border-t border-slate-800/80 pt-2">
                POS_ONLY · PENDING_APPROVAL (Historical missing)
              </p>
            </div>

            <div className="rounded-2xl border border-blue-500/30 bg-slate-900/80 p-5 shadow-xl">
              <p className="text-xs font-medium uppercase tracking-wider text-blue-400">Final August Sales Total</p>
              <p className="mt-2 text-2xl font-extrabold text-amber-300">NOT YET DETERMINED</p>
              <p className="mt-2 text-xs text-slate-400 border-t border-slate-800/80 pt-2">
                Accounting certification: NOT READY
              </p>
            </div>

            <div className="rounded-2xl border border-purple-500/30 bg-slate-900/80 p-5 shadow-xl">
              <p className="text-xs font-medium uppercase tracking-wider text-purple-400">Recovered POS Aggregate</p>
              <p className="mt-2 text-3xl font-extrabold text-purple-300">{money(totalPosProduction)}</p>
              <p className="mt-2 text-xs text-slate-400 border-t border-slate-800/80 pt-2">
                Incomplete aggregate; subject to source coverage
              </p>
            </div>
          </div>

          {/* Reconciliation Audit Summary Metrics */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-emerald-800/40 bg-slate-900/60 p-3 text-center">
              <span className="text-[11px] uppercase tracking-wider text-emerald-400 font-semibold block">Exact Source Matches</span>
              <strong className="text-xl font-extrabold text-white mt-1 block">{matchCount} days</strong>
              <span className="text-[10px] text-slate-400">POS & Historical agree (e.g. Aug 26)</span>
            </div>
            <div className="rounded-xl border border-amber-800/40 bg-slate-900/60 p-3 text-center">
              <span className="text-[11px] uppercase tracking-wider text-amber-400 font-semibold block">Conflicting / Investigation</span>
              <strong className="text-xl font-extrabold text-white mt-1 block">{conflictCount} days</strong>
              <span className="text-[10px] text-slate-400">Includes partial POS Aug 29–30</span>
            </div>
            <div className="rounded-xl border border-blue-800/40 bg-slate-900/60 p-3 text-center">
              <span className="text-[11px] uppercase tracking-wider text-blue-400 font-semibold block">Historical Only</span>
              <strong className="text-xl font-extrabold text-white mt-1 block">{pendingApprovalCount} days</strong>
              <span className="text-[10px] text-slate-400">POS absent (excl sandbox Aug 28)</span>
            </div>
            <div className="rounded-xl border border-purple-800/40 bg-slate-900/60 p-3 text-center">
              <span className="text-[11px] uppercase tracking-wider text-purple-400 font-semibold block">POS Only (Aug 11)</span>
              <strong className="text-xl font-extrabold text-white mt-1 block">{posOnlyCount} day</strong>
              <span className="text-[10px] text-slate-400">POS present; Historical missing</span>
            </div>
          </div>

          {/* Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <Filter size={14} /> Reconciliation Status Filter:
              <select
                value={reconciliationStatusFilter}
                onChange={(e) => setReconciliationStatusFilter(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-white focus:outline-none"
              >
                <option value="ALL">All 31 Days (Classified)</option>
                <option value="MATCH / CROSS_VALIDATED">Exact Match ({matchCount})</option>
                <option value="CONFLICTING / INVESTIGATION_REQUIRED">Conflicting ({conflictCount})</option>
                <option value="HISTORICAL_PENDING_APPROVAL">Historical Only ({pendingApprovalCount})</option>
                <option value="POS_RECOVERED_ONLY">POS Only (1)</option>
              </select>
            </label>

            <div className="relative min-w-[260px]">
              <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search date, status, evidence..."
                className="w-full rounded-lg border border-slate-700 bg-slate-800 py-1.5 pl-9 pr-3 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
          </div>

          {/* 31-Day Four-Dimensional Evidence Table */}
          <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80 shadow-2xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-950/80 text-[11px] uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="px-3 py-3">Date</th>
                    <th className="px-3 py-3 text-right">Historical</th>
                    <th className="px-3 py-3 text-right">POS Recv</th>
                    <th className="px-3 py-3 text-right">Difference</th>
                    <th className="px-3 py-3">Source Avail</th>
                    <th className="px-3 py-3">Reconciliation</th>
                    <th className="px-3 py-3">Evidence Strength</th>
                    <th className="px-3 py-3">Approval</th>
                    <th className="px-3 py-3 text-right">Accepted</th>
                    <th className="px-4 py-3">Traceability / Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {filteredDualRows.map((row) => {
                    return (
                      <tr key={row.date} className="hover:bg-slate-800/40 transition">
                        <td className="px-3 py-3 font-semibold text-white whitespace-nowrap">
                          {row.date} ({row.day_name})
                        </td>
                        <td className="px-3 py-3 text-right whitespace-nowrap">
                          {row.historical_figure !== null ? (
                            <span className="text-emerald-300 font-bold">KES {row.historical_figure.toLocaleString()}</span>
                          ) : (
                            <span className="text-rose-400 font-bold">MISSING</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right whitespace-nowrap">
                          {row.pos_recovered_amount !== null ? (
                            <span className="text-white font-medium">KES {row.pos_recovered_amount.toLocaleString()}</span>
                          ) : (
                            <span className="text-slate-500 font-sans">ABSENT</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right whitespace-nowrap">
                          {row.difference !== null ? (
                            <span className={`font-bold ${row.difference === 0 ? 'text-emerald-400' : row.difference > 0 ? 'text-amber-400' : 'text-rose-400'}`}>
                              {row.difference >= 0 ? '+KES ' : '-KES '}
                              {Math.abs(row.difference).toLocaleString()}
                            </span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap font-sans text-[11px]">
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300 font-medium">
                            {row.source_availability}
                          </span>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap font-sans text-[11px]">
                          {row.reconciliation_status === 'EXACT_MATCH' && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-950/80 px-2 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-600/40">
                              <CheckCircle2 size={11} /> EXACT_MATCH
                            </span>
                          )}
                          {row.reconciliation_status === 'CONFLICTING' && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-amber-950/80 px-2 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-600/40">
                              <AlertTriangle size={11} /> CONFLICTING
                            </span>
                          )}
                          {row.reconciliation_status === 'HISTORICAL_ONLY' && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-blue-950/80 px-2 py-0.5 text-[10px] font-bold text-blue-300 border border-blue-600/40">
                              <Clock size={11} /> HISTORICAL_ONLY
                            </span>
                          )}
                          {row.reconciliation_status === 'POS_ONLY' && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-purple-950/80 px-2 py-0.5 text-[10px] font-bold text-purple-300 border border-purple-600/40">
                              <ShieldCheck size={11} /> POS_ONLY
                            </span>
                          )}
                          {row.reconciliation_status === 'UNRESOLVED' && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-rose-950/80 px-2 py-0.5 text-[10px] font-bold text-rose-300 border border-rose-600/40">
                              <AlertTriangle size={11} /> UNRESOLVED
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap font-sans text-[10px] text-slate-300">
                          {row.evidence_strength}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap font-sans text-[10px]">
                          <span className="text-amber-400 font-semibold">{row.approval_status}</span>
                        </td>
                        <td className="px-3 py-3 text-right whitespace-nowrap font-sans text-[11px] text-slate-400">
                          {row.accepted_amount !== null ? `KES ${row.accepted_amount.toLocaleString()}` : 'None (Pending)'}
                        </td>
                        <td className="px-4 py-3 font-sans text-xs text-slate-400 max-w-xs truncate" title={row.evidence}>
                          {row.evidence}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="border-t-2 border-slate-700 bg-slate-950 text-xs font-bold text-white">
                  <tr>
                    <td className="px-3 py-3 font-sans">SUBTOTALS / EVIDENCE</td>
                    <td className="px-3 py-3 text-right text-emerald-400">KES {knownAugustHistoricalTotal.toLocaleString()}*</td>
                    <td className="px-3 py-3 text-right text-purple-300">KES {totalPosProduction.toLocaleString()}**</td>
                    <td className="px-3 py-3 text-right text-amber-300">Variance</td>
                    <td colSpan={6} className="px-3 py-3 font-sans text-[11px] text-slate-400 font-normal">
                      *Known historical-source subtotal (30/31 days; excl Aug 11). **Recovered POS aggregate (incomplete; excl sandbox Aug 28). Final August Sales: NOT YET DETERMINED.
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* September Historical Reference Card (Isolated) */}
          <div className="rounded-2xl border border-purple-600/30 bg-slate-900/60 p-5 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-bold text-purple-300 uppercase tracking-wider">
                  September 2026 Historical Sales Reference (Strictly Isolated)
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Business-provided figures for September 1–3. Strictly preserved separately and not mixed into August reporting.
                </p>
              </div>
              <div className="text-right">
                <span className="text-xs text-slate-400 block">Total Sept 1–3</span>
                <strong className="text-lg font-bold text-white">{money(knownSeptemberTotal)}</strong>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
              {Object.entries(SEPTEMBER_2026_HISTORICAL_FIGURES).map(([date, amount]) => (
                <div key={date} className="rounded-xl border border-slate-800 bg-slate-800/40 p-3 flex justify-between items-center">
                  <div>
                    <span className="text-xs font-semibold text-white">{date}</span>
                    <span className="block text-[10px] text-slate-400">Business Supplied</span>
                  </div>
                  <strong className="text-sm font-bold text-purple-300">{money(amount)}</strong>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Month-End Executive Summary Cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Total EOD Sales */}
        <div className="rounded-2xl border border-emerald-600/30 bg-gradient-to-br from-emerald-950/40 via-slate-900 to-slate-900 p-5 shadow-xl">
          <p className="text-xs font-medium uppercase tracking-wider text-emerald-400">Total August EOD Sales</p>
          <p className="mt-2 text-3xl font-extrabold text-white">{money(summary.total_eod_sales)}</p>
          <div className="mt-3 flex items-center justify-between text-xs text-slate-400 border-t border-slate-800/80 pt-2">
            <span>Gross: {money(summary.gross_sales)}</span>
            <span>Discounts: {money(summary.discounts)}</span>
          </div>
        </div>

        {/* Payment Distribution */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl">
          <p className="text-xs font-medium uppercase tracking-wider text-blue-400">Payment Method Mix</p>
          <div className="mt-2 space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Cash:</span>
              <span className="font-semibold text-white">{money(summary.cash_sales)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">M-Pesa / Mobile:</span>
              <span className="font-semibold text-white">{money(summary.mpesa_sales)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Other / Bank:</span>
              <span className="font-semibold text-white">{money(summary.other_sales)}</span>
            </div>
          </div>
        </div>

        {/* Trading Days & Volume */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl">
          <p className="text-xs font-medium uppercase tracking-wider text-amber-400">Trading Activity</p>
          <p className="mt-2 text-3xl font-extrabold text-white">
            {summary.trading_days} <span className="text-sm font-normal text-slate-400">/ 31 days</span>
          </p>
          <p className="mt-3 text-xs text-slate-400 border-t border-slate-800/80 pt-2">
            {summary.total_transactions} total transactions recorded
          </p>
        </div>

        {/* Data Completeness & Integrity */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl">
          <p className="text-xs font-medium uppercase tracking-wider text-purple-400">Data Completeness</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-slate-800/60 p-2 text-center">
              <span className="block text-slate-400 text-[10px] uppercase">POS Live</span>
              <strong className="text-emerald-400 font-bold text-sm">{summary.pos_derived_days}d</strong>
            </div>
            <div className="rounded-lg bg-slate-800/60 p-2 text-center">
              <span className="block text-slate-400 text-[10px] uppercase">Manual</span>
              <strong className="text-blue-400 font-bold text-sm">{summary.manual_days}d</strong>
            </div>
            <div className="rounded-lg bg-slate-800/60 p-2 text-center">
              <span className="block text-slate-400 text-[10px] uppercase">Recovered</span>
              <strong className="text-amber-400 font-bold text-sm">{summary.recovered_days}d</strong>
            </div>
            <div className="rounded-lg bg-slate-800/60 p-2 text-center">
              <span className="block text-slate-400 text-[10px] uppercase">Missing</span>
              <strong className={`font-bold text-sm ${summary.missing_days > 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                {summary.missing_days}d
              </strong>
            </div>
          </div>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Source Filter */}
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <Filter size={14} /> Source:
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-white focus:outline-none"
            >
              <option value="ALL">All Sources</option>
              <option value="POS_TRANSACTION">POS Transaction</option>
              <option value="MANUAL_HISTORICAL">Manual Historical</option>
              <option value="RECOVERED">Recovered Internal</option>
              <option value="MISSING">Missing Only</option>
            </select>
          </label>

          {/* Week Filter */}
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <Layers size={14} /> Week:
            <select
              value={selectedWeek}
              onChange={(e) => setSelectedWeek(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-white focus:outline-none"
            >
              <option value="ALL">All 6 Weeks</option>
              {summary.weeks.map((w) => (
                <option key={w.week_number} value={w.week_number}>
                  Week {w.week_number} ({w.date_range_label})
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Search Input */}
        <div className="relative min-w-[240px]">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
          <input
            type="text"
            placeholder="Search dates, notes, status..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 py-1.5 pl-9 pr-3 text-xs text-white placeholder:text-slate-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Weekly Rollups Accordion */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
          <Layers size={16} /> August Weekly Rollups
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {summary.weeks.map((week) => {
            return (
              <div
                key={week.week_number}
                className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 space-y-3 hover:border-slate-700 transition"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-white text-sm">Week {week.week_number}</h3>
                    <p className="text-xs text-slate-400">{week.date_range_label}</p>
                  </div>
                  <span className="rounded-lg bg-emerald-950/60 border border-emerald-800/40 px-2.5 py-1 text-xs font-bold text-emerald-300">
                    {money(week.eod_total)}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs border-t border-slate-800/80 pt-2">
                  <div>
                    <span className="text-slate-500">Trading Days:</span>{' '}
                    <span className="text-slate-300 font-medium">{week.trading_days} / {week.days.length}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Transactions:</span>{' '}
                    <span className="text-slate-300 font-medium">{week.transaction_count}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Cash:</span>{' '}
                    <span className="text-slate-300 font-medium">{money(week.cash_sales)}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">M-Pesa:</span>{' '}
                    <span className="text-slate-300 font-medium">{money(week.mpesa_sales)}</span>
                  </div>
                </div>

                {/* Completeness bar */}
                <div className="flex items-center justify-between text-[11px] pt-1 text-slate-400">
                  <span className="flex items-center gap-1 text-emerald-400">
                    <CheckCircle2 size={12} /> {week.complete_days + week.manual_days + week.recovered_days} active
                  </span>
                  {week.missing_days > 0 ? (
                    <span className="flex items-center gap-1 text-rose-400">
                      <AlertTriangle size={12} /> {week.missing_days} missing
                    </span>
                  ) : (
                    <span className="text-emerald-400 font-medium">100% Reconciled</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Authoritative 31-Day Daily Breakdown Matrix */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
            <Calendar size={16} /> Daily Sales & EOD Matrix (1–31 August 2026)
          </h2>
          <span className="text-xs text-slate-500">
            Showing {filteredDailyRows.length} of {summary.daily_rows.length} dates
          </span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/90 shadow-xl">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 uppercase tracking-wider text-[11px]">
                <th className="py-3.5 px-4">Date</th>
                <th className="py-3.5 px-3">Source</th>
                <th className="py-3.5 px-3">Status</th>
                <th className="py-3.5 px-3 text-right">Gross Sales</th>
                <th className="py-3.5 px-3 text-right">Discounts</th>
                <th className="py-3.5 px-3 text-right">Refunds</th>
                <th className="py-3.5 px-3 text-right">Net Sales</th>
                <th className="py-3.5 px-3 text-right">Cash</th>
                <th className="py-3.5 px-3 text-right">M-Pesa</th>
                <th className="py-3.5 px-4 text-right font-bold text-white">EOD Total</th>
                <th className="py-3.5 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-slate-200">
              {filteredDailyRows.map((row) => {
                const isSunday = row.day_name === 'Sun';
                const isMissing = row.status === 'MISSING';
                const isManual = row.source === 'MANUAL_HISTORICAL';
                const isPos = row.source === 'POS_TRANSACTION' && !isMissing;

                return (
                  <tr
                    key={row.date}
                    className={`hover:bg-slate-800/60 transition ${
                      isMissing ? 'bg-rose-950/10' : isSunday ? 'bg-slate-900/30' : ''
                    }`}
                  >
                    {/* Date */}
                    <td className="py-3 px-4 font-mono font-medium">
                      <div className="flex items-center gap-2">
                        <span className={`w-8 font-bold ${isSunday ? 'text-amber-400' : 'text-slate-300'}`}>
                          {row.day_name}
                        </span>
                        <span className="text-white font-semibold">{row.date}</span>
                      </div>
                    </td>

                    {/* Source Badge */}
                    <td className="py-3 px-3">
                      {isPos && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-950/80 border border-emerald-800 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                          POS LIVE
                        </span>
                      )}
                      {isManual && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-950/80 border border-blue-800 px-2 py-0.5 text-[10px] font-semibold text-blue-300">
                          MANUAL
                        </span>
                      )}
                      {row.source === 'RECOVERED' && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-950/80 border border-amber-800 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                          RECOVERED
                        </span>
                      )}
                      {isMissing && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-950/80 border border-rose-800 px-2 py-0.5 text-[10px] font-semibold text-rose-300">
                          MISSING
                        </span>
                      )}
                    </td>

                    {/* Status */}
                    <td className="py-3 px-3">
                      {isMissing ? (
                        <span className="text-rose-400 font-medium flex items-center gap-1 text-[11px]">
                          <AlertTriangle size={12} /> Unresolved
                        </span>
                      ) : (
                        <span className="text-emerald-400 font-medium flex items-center gap-1 text-[11px]">
                          <CheckCircle2 size={12} /> {row.status}
                        </span>
                      )}
                    </td>

                    {/* Financial Figures */}
                    <td className="py-3 px-3 text-right font-mono">{money(row.gross_sales)}</td>
                    <td className="py-3 px-3 text-right font-mono text-slate-400">
                      {row.discounts > 0 ? money(row.discounts) : '—'}
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-slate-400">
                      {row.refunds > 0 ? money(row.refunds) : '—'}
                    </td>
                    <td className="py-3 px-3 text-right font-mono font-medium text-slate-200">
                      {money(row.net_sales)}
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-slate-300">{money(row.cash_sales)}</td>
                    <td className="py-3 px-3 text-right font-mono text-slate-300">{money(row.mpesa_sales)}</td>

                    {/* EOD Sales Total */}
                    <td className="py-3 px-4 text-right font-mono font-bold text-emerald-400 text-sm">
                      {money(row.eod_total)}
                    </td>

                    {/* Action */}
                    <td className="py-3 px-4 text-center">
                      {isMissing ? (
                        <button
                          onClick={() => handleOpenModalForDay(row)}
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-600/20 border border-emerald-500/40 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-600 hover:text-white transition"
                        >
                          <Plus size={12} /> Enter
                        </button>
                      ) : isManual ? (
                        <button
                          onClick={() => handleOpenModalForDay(row)}
                          className="inline-flex items-center gap-1 rounded-md bg-slate-800 border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-700 hover:text-white transition"
                        >
                          <Edit3 size={12} /> Edit
                        </button>
                      ) : (
                        <span className="text-[11px] text-slate-500 font-mono">Verified</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {/* Table Footer Totals */}
            <tfoot>
              <tr className="border-t-2 border-slate-700 bg-slate-950 font-bold text-white text-xs">
                <td className="py-4 px-4" colSpan={3}>
                  AUGUST 2026 MONTH-END TOTALS ({summary.trading_days} Trading Days)
                </td>
                <td className="py-4 px-3 text-right font-mono">{money(summary.gross_sales)}</td>
                <td className="py-4 px-3 text-right font-mono">{money(summary.discounts)}</td>
                <td className="py-4 px-3 text-right font-mono">{money(summary.refunds)}</td>
                <td className="py-4 px-3 text-right font-mono">{money(summary.net_sales)}</td>
                <td className="py-4 px-3 text-right font-mono">{money(summary.cash_sales)}</td>
                <td className="py-4 px-3 text-right font-mono">{money(summary.mpesa_sales)}</td>
                <td className="py-4 px-4 text-right font-mono text-emerald-400 text-sm">
                  {money(summary.total_eod_sales)}
                </td>
                <td className="py-4 px-4"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
      </>
      )}

      {/* Manual Entry Modal */}
      <ManualHistoricalSalesModal
        isOpen={isModalOpen}
        initialDate={modalInitialDate}
        existingRecord={modalExistingRecord}
        existingPosCount={modalExistingPosCount}
        onClose={() => setIsModalOpen(false)}
        onSaved={(record) =>
          // Modal is in-memory only — no IndexedDB write occurred.
          // Merge record into local state directly so the UI updates immediately.
          setManualEntries((prev) => [
            ...prev.filter((e) => e.id !== record.id),
            record,
          ])
        }
      />
    </div>
  );
}
