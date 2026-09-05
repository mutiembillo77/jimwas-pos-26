import { useState, useEffect, useMemo } from 'react';
import { TrendingUp, DollarSign, ShoppingCart, Users, CreditCard, Star, Calendar, Receipt, FileText, Printer, Download, Search, RefreshCw, Truck } from 'lucide-react';
import { getAllTransactions, getAllCustomers, getAllInstallmentPlans, getAllProducts, getBusinessSettings, getReceiptSettings } from '../lib/db';
import { subscribeToDataChanges } from '../lib/sync';
import { KCBDashboardWidget } from '../components/MpesaDashboardWidget';
import { TransactionReceiptPopover } from '../components/TransactionReceiptPopover';
import {
  calculateAuthoritativeDashboardKPIs,
  calculateDailyTransactions,
  resolveTransactionPaymentAccount,
  isValidSalesTransaction,
} from '../lib/reporting';
import { previewCombinedDashboardReport } from '../lib/print';
import { useAuth } from '../context/AuthContext';
import type { Transaction, Customer, InstallmentPlan, Product } from '../lib/types';

export function DashboardPage() {
  const { user } = useAuth();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [installmentPlans, setInstallmentPlans] = useState<InstallmentPlan[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month'>('today');
  const [hoveredTx, setHoveredTx] = useState<Transaction | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [searchDate, setSearchDate] = useState('');
  const [searchDay, setSearchDay] = useState('all');
  const [paymentMethod, setPaymentMethod] = useState('all');
  const [paymentAccount, setPaymentAccount] = useState('all');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();

    const unsubscribe = subscribeToDataChanges(({ table }) => {
      if (['transactions', 'customers', 'installment_plans', 'products', '*'].includes(table)) {
        loadData();
      }
    });
    return () => unsubscribe();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    const [txData, custData, planData, prodData] = await Promise.all([
      getAllTransactions(),
      getAllCustomers(),
      getAllInstallmentPlans(),
      getAllProducts(),
    ]);
    setTransactions(txData);
    setCustomers(custData);
    setInstallmentPlans(planData);
    setProducts(prodData);
    setIsLoading(false);
  };

  const dateRange = useMemo(() => {
    const now = new Date();
    if (searchDate) {
      const parts = searchDate.split('-');
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10) - 1;
      const d = parseInt(parts[2], 10);
      const start = new Date(y, m, d, 0, 0, 0, 0);
      const end = new Date(y, m, d, 23, 59, 59, 999);
      return { start, end };
    }

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    switch (timeRange) {
      case 'today':
        return { start: todayStart, end: todayEnd };
      case 'week': {
        const weekAgo = new Date(todayStart);
        weekAgo.setDate(weekAgo.getDate() - 6);
        return { start: weekAgo, end: todayEnd };
      }
      case 'month': {
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        return { start: monthStart, end: todayEnd };
      }
    }
  }, [timeRange, searchDate]);

  const paymentMethods = useMemo(() => [...new Set(transactions.map((tx) => tx.payment_method))].sort(), [transactions]);

  const filteredTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      if (!isValidSalesTransaction(tx)) return false;
      const txDate = new Date(tx.created_at);
      if (txDate < dateRange.start || txDate > dateRange.end) return false;

      const localDate = `${txDate.getFullYear()}-${String(txDate.getMonth() + 1).padStart(2, '0')}-${String(txDate.getDate()).padStart(2, '0')}`;
      const dayMatches = searchDay === 'all' || txDate.getDay() === Number(searchDay);
      const dateMatches = !searchDate || localDate === searchDate;
      if (!dayMatches || !dateMatches) return false;

      if (paymentMethod !== 'all' && tx.payment_method !== paymentMethod) return false;

      const acc = resolveTransactionPaymentAccount(tx);
      if (paymentAccount !== 'all' && acc !== paymentAccount) return false;

      return true;
    });
  }, [transactions, dateRange, searchDate, searchDay, paymentMethod, paymentAccount]);

  // Authoritative Dashboard KPIs and Daily Summaries derived from single reporting engine
  const kpis = useMemo(() => calculateAuthoritativeDashboardKPIs(filteredTransactions), [filteredTransactions]);
  const dailySummaries = useMemo(() => calculateDailyTransactions(filteredTransactions, dateRange), [filteredTransactions, dateRange]);

  const stats = useMemo(() => {
    const loyaltyPointsEarned = customers.reduce((sum, c) => sum + c.loyalty_points, 0);
    const activeInstallments = installmentPlans.filter((p) => p.status === 'active').length;
    const pendingInstallmentAmount = installmentPlans
      .filter((p) => p.status === 'active')
      .reduce((sum, p) => sum + (p.total_amount - p.amount_paid), 0);

    return {
      loyaltyPointsEarned,
      activeInstallments,
      pendingInstallmentAmount,
    };
  }, [customers, installmentPlans]);

  const topSellingProducts = useMemo(() => {
    const productSales: Record<string, { name: string; quantity: number; revenue: number }> = {};

    filteredTransactions.forEach((tx) => {
      tx.items?.forEach((item) => {
        if (!productSales[item.product_id]) {
          productSales[item.product_id] = { name: item.product_name, quantity: 0, revenue: 0 };
        }
        productSales[item.product_id].quantity += item.quantity;
        productSales[item.product_id].revenue += item.subtotal;
      });
    });

    return Object.entries(productSales)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
  }, [filteredTransactions]);

  const recentTransactions = useMemo(() => {
    return [...filteredTransactions]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [filteredTransactions]);

  const maxRevenue = Math.max(...dailySummaries.map((d) => d.totalSales), 1);

  const stockByProduct = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const stockLabel = (stock: number, lowStockAlert = 5) => {
    if (stock <= 0) return { label: 'Out of stock', className: 'bg-red-500/15 text-red-300 border-red-500/30' };
    if (stock <= lowStockAlert) return { label: `${stock} in stock`, className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' };
    return { label: `${stock} in stock`, className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
  };

  const handlePrintCombinedReport = async () => {
    const [business, receipt] = await Promise.all([
      getBusinessSettings(),
      getReceiptSettings(),
    ]);

    const periodLabel = searchDate
      ? `Date: ${searchDate}`
      : timeRange === 'today'
      ? `Today (${dateRange.start.toLocaleDateString()})`
      : timeRange === 'week'
      ? `This Week (${dateRange.start.toLocaleDateString()} – ${dateRange.end.toLocaleDateString()})`
      : `This Month (${dateRange.start.toLocaleDateString()} – ${dateRange.end.toLocaleDateString()})`;

    previewCombinedDashboardReport({
      business: business || {
        id: 'business',
        business_name: 'Jimwas Hardware & Electricals',
        currency: 'KES',
        currency_symbol: 'KES',
        business_phone: '',
        show_tax_on_receipt: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sync_status: 'synced',
      },
      receipt,
      periodLabel,
      generatedAt: new Date(),
      cashierName: user?.full_name || user?.username || 'Cashier',
      kpis,
      dailySummaries,
      detailedTransactions: filteredTransactions,
      customers,
      products,
    });
  };

  return (
    <div className="space-y-6">
      {/* Dashboard Controls */}
      <div className="flex flex-col gap-3 rounded-xl bg-slate-800 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2 bg-slate-700/70 rounded-lg p-1">
          {(['today', 'week', 'month'] as const).map((range) => (
            <button
              key={range}
              onClick={() => {
                setTimeRange(range);
                setSearchDate('');
              }}
              className={`px-4 py-2 rounded-md text-sm font-medium transition ${
                timeRange === range && !searchDate ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {range === 'today' ? 'Today' : range === 'week' ? 'This Week' : 'This Month'}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 rounded-lg bg-slate-700 px-3 py-2 text-sm text-slate-300">
            <Search size={16} />
            <span className="sr-only">Search by date</span>
            <input
              type="date"
              value={searchDate}
              onChange={(event) => setSearchDate(event.target.value)}
              className="bg-transparent text-white outline-none"
            />
          </label>
          <label className="rounded-lg bg-slate-700 px-3 py-2 text-sm text-slate-300">
            <span className="sr-only">Filter payment method</span>
            <select
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value)}
              className="bg-transparent text-white outline-none"
            >
              <option value="all">All methods</option>
              {paymentMethods.map((method) => (
                <option key={method} value={method}>
                  {method.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="rounded-lg bg-slate-700 px-3 py-2 text-sm text-slate-300">
            <span className="sr-only">Filter payment account</span>
            <select
              value={paymentAccount}
              onChange={(event) => setPaymentAccount(event.target.value)}
              className="bg-transparent text-white outline-none"
            >
              <option value="all">All accounts</option>
              <option value="CASH">CASH</option>
              <option value="MPESA">MPESA</option>
              <option value="KCB">KCB</option>
              <option value="NCBA">NCBA</option>
              <option value="UNASSIGNED">Unassigned / Legacy</option>
            </select>
          </label>
          <label className="rounded-lg bg-slate-700 px-3 py-2 text-sm text-slate-300">
            <span className="sr-only">Search by day</span>
            <select
              value={searchDay}
              onChange={(event) => setSearchDay(event.target.value)}
              className="bg-transparent text-white outline-none"
            >
              <option value="all">All days</option>
              <option value="1">Monday</option>
              <option value="2">Tuesday</option>
              <option value="3">Wednesday</option>
              <option value="4">Thursday</option>
              <option value="5">Friday</option>
              <option value="6">Saturday</option>
              <option value="0">Sunday</option>
            </select>
          </label>
          {(searchDate || searchDay !== 'all' || paymentMethod !== 'all' || paymentAccount !== 'all') && (
            <button
              onClick={() => {
                setSearchDate('');
                setSearchDay('all');
                setPaymentMethod('all');
                setPaymentAccount('all');
              }}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-700"
            >
              <RefreshCw size={15} /> Clear
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">
          Showing <span className="font-semibold text-white">{kpis.totalTransactions}</span> valid transactions for the selected period
        </p>
        <div className="flex gap-2">
          <button
            onClick={handlePrintCombinedReport}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-700 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-600 transition"
          >
            <Printer size={16} /> Print Report
          </button>
          <button
            onClick={handlePrintCombinedReport}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition"
          >
            <Download size={16} /> Generate PDF Report
          </button>
        </div>
      </div>

      {/* Main Authoritative Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/60">
          <div className="flex items-center justify-between mb-2">
            <div className="w-10 h-10 bg-emerald-600/20 rounded-lg flex items-center justify-center">
              <DollarSign size={20} className="text-emerald-400" />
            </div>
            <TrendingUp size={18} className="text-emerald-400" />
          </div>
          <p className="text-3xl font-bold text-white">KES {kpis.totalSales.toLocaleString()}</p>
          <p className="text-sm text-slate-400">Total Net Sales</p>
          <div className="mt-2 text-xs text-slate-500 flex justify-between">
            <span>Subtotal: KES {kpis.subtotal.toLocaleString()}</span>
            {kpis.totalDeliveryFees > 0 && <span className="text-amber-400">+ Delivery: KES {kpis.totalDeliveryFees.toLocaleString()}</span>}
          </div>
        </div>

        <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/60">
          <div className="flex items-center justify-between mb-2">
            <div className="w-10 h-10 bg-blue-600/20 rounded-lg flex items-center justify-center">
              <ShoppingCart size={20} className="text-blue-400" />
            </div>
          </div>
          <p className="text-3xl font-bold text-white">{kpis.totalTransactions}</p>
          <p className="text-sm text-slate-400">Completed Transactions</p>
          <p className="mt-2 text-xs text-slate-500">Excludes voided and failed transactions</p>
        </div>

        <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/60">
          <div className="flex items-center justify-between mb-2">
            <div className="w-10 h-10 bg-amber-600/20 rounded-lg flex items-center justify-center">
              <DollarSign size={20} className="text-amber-400" />
            </div>
          </div>
          <p className="text-3xl font-bold text-white">KES {Math.round(kpis.averageTransactionValue).toLocaleString()}</p>
          <p className="text-sm text-slate-400">Avg. Transaction Value</p>
          <p className="mt-2 text-xs text-slate-500">Total Sales &divide; Transaction Count</p>
        </div>

        <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/60">
          <div className="flex items-center justify-between mb-2">
            <div className="w-10 h-10 bg-purple-600/20 rounded-lg flex items-center justify-center">
              <Truck size={20} className="text-purple-400" />
            </div>
          </div>
          <p className="text-3xl font-bold text-white">KES {kpis.totalDeliveryFees.toLocaleString()}</p>
          <p className="text-sm text-slate-400">Delivery Fees</p>
          <p className="mt-2 text-xs text-slate-500">Tracked separately &bull; Stock unaffected</p>
        </div>
      </div>

      {/* Payment Account Breakdown — Section 4 & 8 */}
      <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/60">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-white flex items-center gap-2">
            <CreditCard size={18} className="text-blue-400" />
            Payment Account Distribution (Authoritative)
          </h3>
          <span className="text-xs text-emerald-400 font-semibold bg-emerald-950/40 border border-emerald-800 px-2.5 py-0.5 rounded-full">
            Reconciled: KES {kpis.paymentAccounts.totalAmount.toLocaleString()} (100%)
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {(['CASH', 'MPESA', 'KCB', 'NCBA'] as const).map((accKey) => {
            const acc = kpis.paymentAccounts[accKey];
            return (
              <div key={accKey} className="bg-slate-700/50 rounded-lg p-3 border border-slate-600/60">
                <div className="flex justify-between items-center text-xs font-semibold text-slate-300 mb-1">
                  <span>{acc.label}</span>
                  <span className="text-slate-400">{acc.percentage}%</span>
                </div>
                <p className="text-xl font-bold text-white">KES {acc.amount.toLocaleString()}</p>
                <div className="flex justify-between items-center text-xs text-slate-400 mt-2">
                  <span>{acc.count} {acc.count === 1 ? 'sale' : 'sales'}</span>
                  <div className="w-20 bg-slate-600 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-emerald-500 h-full rounded-full"
                      style={{ width: `${Math.min(100, acc.percentage)}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {kpis.paymentAccounts.UNASSIGNED && kpis.paymentAccounts.UNASSIGNED.amount > 0 && (
          <div className="mt-3 p-2 rounded bg-amber-950/30 border border-amber-800/40 text-xs text-amber-300 flex justify-between items-center">
            <span>Historical Unassigned Records: {kpis.paymentAccounts.UNASSIGNED.count} sales</span>
            <span className="font-bold">KES {kpis.paymentAccounts.UNASSIGNED.amount.toLocaleString()}</span>
          </div>
        )}
      </div>

      {/* Daily Sales Breakdown — Scrollable Cards (Section 6 & 7) */}
      <div className="bg-slate-800 rounded-xl p-4 border border-slate-700/60">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-2">
          <div>
            <h3 className="font-medium text-white flex items-center gap-2">
              <Calendar size={18} className="text-emerald-400" />
              Daily Sales Breakdown ({dailySummaries.length} Days in Period)
            </h3>
            <p className="text-xs text-slate-400">
              Scroll through all calendar days in the selected period &bull; Accessible via mouse, touch, and keyboard
            </p>
          </div>
          <span className="text-xs bg-slate-700/60 text-emerald-300 font-medium px-2.5 py-1 rounded-full border border-slate-600">
            Total Period Sales: KES {kpis.totalSales.toLocaleString()}
          </span>
        </div>

        <div
          className="max-h-[560px] overflow-y-auto pr-2 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 rounded-lg"
          tabIndex={0}
          role="region"
          aria-label="Daily sales cards scroll area"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 p-1">
            {dailySummaries.map((day) => (
              <div
                key={day.date}
                className={`rounded-xl border p-3.5 transition-all ${
                  day.transactionCount > 0
                    ? 'border-slate-700 bg-slate-700/40 hover:border-slate-500 hover:bg-slate-700/60'
                    : 'border-slate-800/80 bg-slate-800/40 opacity-75'
                }`}
              >
                <div className="flex items-center justify-between border-b border-slate-700/70 pb-2 mb-2.5">
                  <span className="font-semibold text-white text-sm">{day.dayLabel}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      day.transactionCount > 0
                        ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/30'
                        : 'bg-slate-700/50 text-slate-400'
                    }`}
                  >
                    {day.transactionCount} {day.transactionCount === 1 ? 'sale' : 'sales'}
                  </span>
                </div>

                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between items-baseline">
                    <span className="text-slate-400">Net Sales:</span>
                    <span className="text-sm font-bold text-emerald-400">
                      KES {day.totalSales.toLocaleString()}
                    </span>
                  </div>

                  <div className="flex justify-between text-slate-400">
                    <span>Products Subtotal:</span>
                    <span className="text-slate-300">KES {day.subtotal.toLocaleString()}</span>
                  </div>

                  {day.deliveryFees > 0 && (
                    <div className="flex justify-between text-amber-300">
                      <span>Delivery Fees:</span>
                      <span>KES {day.deliveryFees.toLocaleString()}</span>
                    </div>
                  )}

                  {day.discounts > 0 && (
                    <div className="flex justify-between text-rose-300">
                      <span>Discounts:</span>
                      <span>-KES {day.discounts.toLocaleString()}</span>
                    </div>
                  )}

                  {/* Payment Accounts Badges */}
                  {day.transactionCount > 0 && (
                    <div className="pt-2 mt-2 border-t border-slate-700/60 flex flex-wrap gap-1.5">
                      {day.paymentAccounts.CASH > 0 && (
                        <span className="bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded border border-slate-600/60">
                          Cash: {day.paymentAccounts.CASH.toLocaleString()}
                        </span>
                      )}
                      {day.paymentAccounts.MPESA > 0 && (
                        <span className="bg-emerald-950/40 text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-600/40">
                          Mpesa: {day.paymentAccounts.MPESA.toLocaleString()}
                        </span>
                      )}
                      {day.paymentAccounts.KCB > 0 && (
                        <span className="bg-blue-950/40 text-blue-300 px-1.5 py-0.5 rounded border border-blue-600/40">
                          KCB: {day.paymentAccounts.KCB.toLocaleString()}
                        </span>
                      )}
                      {day.paymentAccounts.NCBA > 0 && (
                        <span className="bg-purple-950/40 text-purple-300 px-1.5 py-0.5 rounded border border-purple-600/40">
                          NCBA: {day.paymentAccounts.NCBA.toLocaleString()}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="bg-slate-800 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-amber-600/20 rounded-lg flex items-center justify-center">
              <Star size={20} className="text-amber-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">{stats.loyaltyPointsEarned.toLocaleString()}</p>
              <p className="text-sm text-slate-400">Loyalty Points Issued</p>
            </div>
          </div>
        </div>

        <div className="bg-slate-800 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600/20 rounded-lg flex items-center justify-center">
              <CreditCard size={20} className="text-blue-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">{stats.activeInstallments}</p>
              <p className="text-sm text-slate-400">Active Installment Plans</p>
            </div>
          </div>
        </div>

        <div className="bg-slate-800 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-600/20 rounded-lg flex items-center justify-center">
              <DollarSign size={20} className="text-emerald-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">KES {stats.pendingInstallmentAmount.toLocaleString()}</p>
              <p className="text-sm text-slate-400">Pending Installment Balance</p>
            </div>
          </div>
        </div>
      </div>

      {/* M-Pesa Dashboard Widget */}
      <KCBDashboardWidget timeRange={timeRange} />

      {/* Charts and Tables */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Sales Chart */}
        <div className="bg-slate-800 rounded-xl p-4">
          <h3 className="font-medium text-white mb-4 flex items-center gap-2">
            <TrendingUp size={18} className="text-emerald-400" />
            Sales Overview
          </h3>
          {isLoading ? (
            <p className="h-64 flex items-center justify-center text-slate-400">Loading sales data...</p>
          ) : dailySummaries.length === 0 || dailySummaries.every((day) => day.totalSales === 0) ? (
            <div className="h-64 flex flex-col items-center justify-center gap-2 text-slate-400">
              <TrendingUp size={28} className="text-slate-600" />
              <p>No sales recorded for this period</p>
              <p className="text-xs">Try another date or day filter.</p>
            </div>
          ) : (
            <div className="h-64 flex items-end gap-1.5 border-b border-slate-700 pb-1 overflow-x-auto">
              {dailySummaries.map((day, i) => {
                const height = (day.totalSales / maxRevenue) * 100;
                return (
                  <div key={i} className="group flex h-full flex-1 min-w-[28px] flex-col items-center justify-end gap-1">
                    <div className="relative flex w-full flex-1 items-end">
                      <div
                        className="w-full rounded-t bg-emerald-600 transition-all group-hover:bg-emerald-400"
                        style={{ height: `${Math.max(height, 3)}%` }}
                        title={`KES ${day.totalSales.toLocaleString()}`}
                      />
                      <span className="absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-950 px-2 py-1 text-xs text-white group-hover:block z-10">
                        KES {day.totalSales.toLocaleString()}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-400 truncate max-w-full">{day.shortDayName}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Top Products */}
        <div className="bg-slate-800 rounded-xl p-4">
          <h3 className="font-medium text-white mb-4 flex items-center gap-2">
            <TrendingUp size={18} className="text-emerald-400" />
            Top Selling Products
          </h3>
          {topSellingProducts.length > 0 ? (
            <div className="space-y-3">
              {topSellingProducts.map((product, index) => (
                <div key={product.id} className="flex items-center gap-3">
                  <span className="w-6 h-6 bg-emerald-600/20 rounded flex items-center justify-center text-emerald-400 text-sm font-medium">
                    {index + 1}
                  </span>
                  <div className="flex-1">
                    <p className="text-white">{product.name}</p>
                    <p className="text-xs text-slate-400">{product.quantity} sold</p>
                  </div>
                  <p className="text-emerald-400 font-medium">KES {product.revenue.toLocaleString()}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-slate-400 py-8">No sales data for this period</p>
          )}
        </div>
      </div>

      {/* Detailed Sales Report Table (Section 10 & 11) */}
      <div className="bg-slate-800 rounded-xl p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4">
          <div className="flex items-center gap-2">
            <FileText size={18} className="text-emerald-400" />
            <div>
              <h3 className="font-medium text-white">Detailed Sales Report (Itemized Lines)</h3>
              <p className="text-xs text-slate-400">
                Authoritative transaction breakdown reconciling directly to Dashboard KPIs
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrintCombinedReport}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition"
            >
              <Download size={16} /> Generate Combined PDF
            </button>
            <button
              onClick={handlePrintCombinedReport}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-700 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-600 transition"
            >
              <Printer size={16} /> Print Combined Report
            </button>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-1 text-emerald-300">Healthy stock</span>
          <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-1 text-amber-300">Low stock</span>
          <span className="rounded-full border border-red-500/30 bg-red-500/15 px-2 py-1 text-red-300">Out of stock</span>
        </div>

        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
          <table className="w-full min-w-[900px]">
            <thead className="sticky top-0 bg-slate-800 border-b border-slate-700 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="pb-3">Date &amp; time</th>
                <th className="pb-3">Customer</th>
                <th className="pb-3">Full item description</th>
                <th className="pb-3 text-center">Qty</th>
                <th className="pb-3">Current stock</th>
                <th className="pb-3 text-right">Amount</th>
                <th className="pb-3 text-right">Payment method</th>
                <th className="pb-3 text-right">Delivery / C.O.D.</th>
                <th className="pb-3 text-right">Account</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filteredTransactions.flatMap((tx) =>
                (tx.items ?? []).map((item) => {
                  const product = stockByProduct.get(item.product_id);
                  const stock = stockLabel(product?.stock ?? 0, product?.low_stock_alert || 5);
                  const account = tx.payment_account || (tx.payment_account_name ? tx.payment_account_name : resolveTransactionPaymentAccount(tx));

                  return (
                    <tr key={`${tx.id}-${item.id}`} className="text-sm hover:bg-slate-700/40">
                      <td className="py-3 text-slate-300">
                        {new Date(tx.created_at).toLocaleDateString()}
                        <br />
                        <span className="text-xs text-slate-500">{new Date(tx.created_at).toLocaleTimeString()}</span>
                      </td>
                      <td className="py-3 text-white">
                        {customers.find((customer) => customer.id === tx.customer_id)?.name || 'Walk-in'}
                      </td>
                      <td className="py-3 text-white">
                        <div>{item.product_name}</div>
                        <div className="text-xs text-slate-500">KES {item.unit_price.toLocaleString()} each</div>
                      </td>
                      <td className="py-3 text-center text-slate-300">{item.quantity}</td>
                      <td className="py-3">
                        <span className={`rounded-full border px-2 py-1 text-xs ${stock.className}`}>
                          {stock.label}
                        </span>
                      </td>
                      <td className="py-3 text-right text-emerald-400 font-semibold">
                        KES {item.subtotal.toLocaleString()}
                      </td>
                      <td className="py-3 text-right text-slate-300 uppercase text-xs">
                        {tx.payment_method}
                      </td>
                      <td className="py-3 text-right text-xs">
                        {tx.payment_method === 'cod' ? (
                          <span className={tx.cod_status === 'PAID' ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
                            {tx.cod_status === 'PAID' ? 'COD Paid' : 'COD Pending'}
                          </span>
                        ) : tx.delivery_fee ? (
                          <span className="text-amber-300">KES {tx.delivery_fee.toLocaleString()} fee</span>
                        ) : (
                          <span className="text-slate-500">None</span>
                        )}
                      </td>
                      <td className="py-3 text-right text-xs font-semibold text-blue-300">
                        {account}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {filteredTransactions.length === 0 && (
            <p className="py-8 text-center text-slate-400">No detailed transactions for this period</p>
          )}
        </div>
      </div>

      {/* Recent Transactions with Receipt Hover Popover */}
      <div className="bg-slate-800 rounded-xl p-4 relative">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium text-white flex items-center gap-2">
            <ShoppingCart size={18} className="text-emerald-400" />
            Recent Transactions
          </h3>
          <span className="text-xs text-slate-400 flex items-center gap-1.5 bg-slate-700/50 px-2.5 py-1 rounded-lg border border-slate-700">
            <Receipt size={14} className="text-emerald-400 animate-pulse" />
            Hover items to view transaction receipt
          </span>
        </div>
        {recentTransactions.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-sm text-slate-400 border-b border-slate-700">
                  <th className="pb-2">Date</th>
                  <th className="pb-2">Customer</th>
                  <th className="pb-2">Items</th>
                  <th className="pb-2 text-right">Amount</th>
                  <th className="pb-2 text-right">Method</th>
                  <th className="pb-2 text-right">Delivery / C.O.D.</th>
                  <th className="pb-2 text-right">Account</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {recentTransactions.slice(0, 15).map((tx) => {
                  const customer = customers.find((c) => c.id === tx.customer_id);
                  const account = tx.payment_account || (tx.payment_account_name ? tx.payment_account_name : resolveTransactionPaymentAccount(tx));

                  return (
                    <tr
                      key={tx.id}
                      onMouseEnter={(e) => {
                        setHoveredTx(tx);
                        setHoverPos({ x: e.clientX, y: e.clientY });
                      }}
                      onMouseMove={(e) => {
                        setHoverPos({ x: e.clientX, y: e.clientY });
                      }}
                      onMouseLeave={() => {
                        setHoveredTx(null);
                        setHoverPos(null);
                      }}
                      className="hover:bg-slate-700/60 transition-colors cursor-pointer group"
                    >
                      <td className="py-3 text-sm text-slate-400 group-hover:text-slate-200">
                        {new Date(tx.created_at).toLocaleDateString()}
                      </td>
                      <td className="py-3 text-white font-medium">{customer?.name || 'Walk-in'}</td>
                      <td className="py-3 text-slate-400">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-700/60 text-slate-300 text-xs group-hover:bg-emerald-500/20 group-hover:text-emerald-300 transition-colors">
                          <Receipt size={12} className="opacity-70" />
                          {tx.items?.length || 0} items
                        </span>
                      </td>
                      <td className="py-3 text-right text-emerald-400 font-semibold">
                        KES {tx.total_amount.toLocaleString()}
                      </td>
                      <td className="py-3 text-right">
                        <span className="px-2 py-1 bg-slate-700 rounded text-xs text-slate-300 group-hover:bg-slate-600 transition-colors uppercase">
                          {tx.payment_method}
                        </span>
                      </td>
                      <td className="py-3 text-right text-xs">
                        {tx.payment_method === 'cod' ? (
                          <span className={tx.cod_status === 'PAID' ? 'text-emerald-400' : 'text-amber-400'}>
                            {tx.cod_status === 'PAID' ? 'Paid' : 'Pending'}
                          </span>
                        ) : tx.delivery_fee ? (
                          <span className="text-amber-300">KES {tx.delivery_fee.toLocaleString()}</span>
                        ) : (
                          <span className="text-slate-500">None</span>
                        )}
                      </td>
                      <td className="py-3 text-right text-xs font-semibold text-blue-300">
                        {account}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-center text-slate-400 py-8">No transactions for this period</p>
        )}

        {/* Hover Receipt Pop-over */}
        {hoveredTx && (
          <TransactionReceiptPopover
            transaction={hoveredTx}
            customer={customers.find((c) => c.id === hoveredTx.customer_id)}
            position={hoverPos}
          />
        )}
      </div>

      {/* Inventory Alerts */}
      <div className="bg-slate-800 rounded-xl p-4">
        <h3 className="font-medium text-white mb-4 flex items-center gap-2">
          <Calendar size={18} className="text-amber-400" />
          Inventory Alerts
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-slate-700 rounded-lg p-4">
            <p className="text-sm text-slate-400 mb-2">Low Stock ({'<='}10)</p>
            <div className="space-y-2">
              {products
                .filter((p) => p.stock > 0 && p.stock <= (p.low_stock_alert || 5))
                .slice(0, 5)
                .map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-sm">
                    <span className="text-white">{p.name}</span>
                    <span className="text-amber-400">{p.stock} left</span>
                  </div>
                ))}
              {products.filter((p) => p.stock > 0 && p.stock <= 10).length === 0 && (
                <p className="text-sm text-slate-400">All products have adequate stock</p>
              )}
            </div>
          </div>
          <div className="bg-slate-700 rounded-lg p-4">
            <p className="text-sm text-slate-400 mb-2">Out of Stock</p>
            <div className="space-y-2">
              {products
                .filter((p) => p.stock === 0)
                .slice(0, 5)
                .map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-sm">
                    <span className="text-white">{p.name}</span>
                    <span className="text-red-400">Out of stock</span>
                  </div>
                ))}
              {products.filter((p) => p.stock === 0).length === 0 && (
                <p className="text-sm text-slate-400">No products out of stock</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
