import { useState, useEffect, useMemo } from 'react';
import {
  TrendingUp,
  Package,
  Users,
  DollarSign,
  Calendar,
  Share2,
  Award,
  Layers,
  ArrowUpRight,
  RefreshCw,
  ShoppingBag,
  Percent,
  Truck,
  HelpCircle,
} from 'lucide-react';
import { getAllTransactions, getAllCustomers, getAllProducts } from '../lib/db';
import { subscribeToDataChanges } from '../lib/sync';
import {
  calculateAuthoritativeAnalytics,
  isValidSalesTransaction,
  currency,
} from '../lib/reporting';
import type {
  Transaction,
  Customer,
  Product,
  AuthoritativeAnalyticsSummary,
  FastMovingProduct,
} from '../lib/types';

export function AnalyticsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Period controls
  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month' | 'custom'>('month');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');

  // Fast-moving ranking toggle
  const [rankingMode, setRankingMode] = useState<'units' | 'revenue'>('units');

  useEffect(() => {
    loadData();

    const unsubscribe = subscribeToDataChanges(({ table }) => {
      if (['transactions', 'customers', 'products', '*'].includes(table)) {
        loadData();
      }
    });
    return () => unsubscribe();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    const [txs, custs, prods] = await Promise.all([
      getAllTransactions(),
      getAllCustomers(),
      getAllProducts(),
    ]);
    setTransactions(txs);
    setCustomers(custs);
    setProducts(prods);
    setIsLoading(false);
  };

  // Reconciled date range calculation matching Dashboard
  const dateRange = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    if (timeRange === 'custom' && customStartDate && customEndDate) {
      const sParts = customStartDate.split('-');
      const eParts = customEndDate.split('-');
      const start = new Date(parseInt(sParts[0], 10), parseInt(sParts[1], 10) - 1, parseInt(sParts[2], 10), 0, 0, 0, 0);
      const end = new Date(parseInt(eParts[0], 10), parseInt(eParts[1], 10) - 1, parseInt(eParts[2], 10), 23, 59, 59, 999);
      return { start, end };
    }

    switch (timeRange) {
      case 'today':
        return { start: todayStart, end: todayEnd };
      case 'week': {
        const weekAgo = new Date(todayStart);
        weekAgo.setDate(weekAgo.getDate() - 6);
        return { start: weekAgo, end: todayEnd };
      }
      case 'month':
      default: {
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        return { start: monthStart, end: todayEnd };
      }
    }
  }, [timeRange, customStartDate, customEndDate]);

  // Filter valid transactions strictly matching period
  const periodTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      if (!isValidSalesTransaction(tx)) return false;
      if (!tx.created_at) return false;
      const txDate = new Date(tx.created_at);
      return txDate >= dateRange.start && txDate <= dateRange.end;
    });
  }, [transactions, dateRange]);

  // Derive authoritative analytics summary downstream of reporting layer
  const analytics: AuthoritativeAnalyticsSummary = useMemo(() => {
    return calculateAuthoritativeAnalytics(periodTransactions, customers, products, dateRange);
  }, [periodTransactions, customers, products, dateRange]);

  // Fast-moving products sorted according to selected ranking
  const sortedFastMoving = useMemo(() => {
    return [...analytics.fast_moving_products].sort((a, b) => {
      if (rankingMode === 'units') {
        return a.rank_by_units - b.rank_by_units;
      }
      return a.rank_by_revenue - b.rank_by_revenue;
    });
  }, [analytics.fast_moving_products, rankingMode]);

  return (
    <div className="min-h-full bg-slate-900 text-slate-100 p-6 space-y-8">
      {/* Header & Period Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <TrendingUp className="w-6 h-6" />
            </span>
            <h1 className="text-2xl font-bold text-white tracking-tight">Analytics & Customer Intelligence</h1>
          </div>
          <p className="text-slate-400 text-sm mt-1">
            Authoritative derivations of sales velocity, merchandise performance, and customer acquisition channels.
          </p>
        </div>

        {/* Period Selector Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg bg-slate-800 p-1 border border-slate-700">
            <button
              onClick={() => setTimeRange('today')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                timeRange === 'today' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-white'
              }`}
            >
              Today
            </button>
            <button
              onClick={() => setTimeRange('week')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                timeRange === 'week' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-white'
              }`}
            >
              This Week
            </button>
            <button
              onClick={() => setTimeRange('month')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                timeRange === 'month' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-white'
              }`}
            >
              This Month
            </button>
            <button
              onClick={() => setTimeRange('custom')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                timeRange === 'custom' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-white'
              }`}
            >
              Custom Range
            </button>
          </div>

          <button
            onClick={loadData}
            title="Refresh Data"
            className="p-2 rounded-lg bg-slate-800 text-slate-400 hover:text-white border border-slate-700 transition"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Custom Date Pickers */}
      {timeRange === 'custom' && (
        <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-semibold text-slate-300">Custom Date Range:</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400">From:</label>
            <input
              type="date"
              value={customStartDate}
              onChange={(e) => setCustomStartDate(e.target.value)}
              className="bg-slate-700 border border-slate-600 text-white text-xs rounded-lg px-2.5 py-1.5 focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400">To:</label>
            <input
              type="date"
              value={customEndDate}
              onChange={(e) => setCustomEndDate(e.target.value)}
              className="bg-slate-700 border border-slate-600 text-white text-xs rounded-lg px-2.5 py-1.5 focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <span className="text-xs text-slate-400 ml-auto">
            Analysis Period: <strong className="text-white">{analytics.period.total_days}</strong> calendar days
          </span>
        </div>
      )}

      {/* SECTION A: KPI SUMMARY CARDS */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wider uppercase text-slate-400">
            A. Financial & Operational KPIs
          </h2>
          <span className="text-xs text-slate-500">
            Reconciled with Authoritative Dashboard ({analytics.period.start} to {analytics.period.end})
          </span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {/* Net Sales */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
              <span>Total Net Sales</span>
              <DollarSign className="w-4 h-4 text-emerald-400" />
            </div>
            <p className="text-lg font-bold text-white tracking-tight">{currency(analytics.kpis.total_sales)}</p>
            <p className="text-[10px] text-slate-400 mt-1">Authoritative Sales</p>
          </div>

          {/* Subtotal */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
              <span>Merchandise</span>
              <ShoppingBag className="w-4 h-4 text-cyan-400" />
            </div>
            <p className="text-lg font-bold text-white tracking-tight">{currency(analytics.kpis.merchandise_subtotal)}</p>
            <p className="text-[10px] text-slate-400 mt-1">Subtotal Excl. Delivery</p>
          </div>

          {/* Discounts */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
              <span>Total Discounts</span>
              <Percent className="w-4 h-4 text-amber-400" />
            </div>
            <p className="text-lg font-bold text-white tracking-tight">{currency(analytics.kpis.total_discounts)}</p>
            <p className="text-[10px] text-slate-400 mt-1">Discounts Applied</p>
          </div>

          {/* Delivery Fees */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
              <span>Delivery Fees</span>
              <Truck className="w-4 h-4 text-indigo-400" />
            </div>
            <p className="text-lg font-bold text-white tracking-tight">{currency(analytics.kpis.total_delivery_fees)}</p>
            <p className="text-[10px] text-slate-400 mt-1">Logistics / Shipping</p>
          </div>

          {/* Completed Transactions */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
              <span>Completed Sales</span>
              <Package className="w-4 h-4 text-blue-400" />
            </div>
            <p className="text-lg font-bold text-white tracking-tight">{analytics.kpis.completed_transactions}</p>
            <p className="text-[10px] text-slate-400 mt-1">Transactions Count</p>
          </div>

          {/* Average Transaction Value */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
              <span>Avg Transaction</span>
              <ArrowUpRight className="w-4 h-4 text-emerald-400" />
            </div>
            <p className="text-lg font-bold text-white tracking-tight">{currency(analytics.kpis.average_transaction_value)}</p>
            <p className="text-[10px] text-slate-400 mt-1">ATV</p>
          </div>

          {/* Unique Transacting Customers */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
              <span>Active Buyers</span>
              <Users className="w-4 h-4 text-purple-400" />
            </div>
            <p className="text-lg font-bold text-white tracking-tight">{analytics.customer_intelligence.unique_customers}</p>
            <p className="text-[10px] text-slate-400 mt-1">Transacting Buyers</p>
          </div>
        </div>
      </section>

      {/* SECTION B: FAST-MOVING PRODUCTS */}
      <section className="space-y-3 bg-slate-800/60 border border-slate-800 rounded-2xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white">B. Fast-Moving Products / Components</h2>
              <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded font-mono">
                {analytics.fast_moving_products.length} Products
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Delivery fees and non-merchandise line items are strictly excluded.
              Velocity 1 = Units Sold ÷ {analytics.period.total_days} Period Days | Velocity 2 = Units Sold ÷ Active Selling Days.
            </p>
          </div>

          {/* Ranking Toggle */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Rank By:</span>
            <div className="inline-flex rounded-lg bg-slate-800 p-1 border border-slate-700">
              <button
                onClick={() => setRankingMode('units')}
                className={`px-3 py-1 text-xs font-semibold rounded ${
                  rankingMode === 'units' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Units Sold
              </button>
              <button
                onClick={() => setRankingMode('revenue')}
                className={`px-3 py-1 text-xs font-semibold rounded ${
                  rankingMode === 'revenue' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Revenue
              </button>
            </div>
          </div>
        </div>

        {/* Fast-Moving Table */}
        <div className="overflow-x-auto rounded-xl border border-slate-700/80 bg-slate-900/60">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-800/90 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-700">
              <tr>
                <th className="px-4 py-3 text-center w-12">#</th>
                <th className="px-4 py-3">Product Name</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Units Sold</th>
                <th className="px-4 py-3 text-right">
                  Period Velocity
                  <span className="block text-[10px] font-normal normal-case text-slate-500">Units / Day</span>
                </th>
                <th className="px-4 py-3 text-right">
                  Active Velocity
                  <span className="block text-[10px] font-normal normal-case text-slate-500">Units / Active Day</span>
                </th>
                <th className="px-4 py-3 text-right">Revenue</th>
                <th className="px-4 py-3 text-right">Sales Share</th>
                <th className="px-4 py-3 text-center">Tx Count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {sortedFastMoving.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                    No qualifying product sales recorded during this reporting period.
                  </td>
                </tr>
              ) : (
                sortedFastMoving.map((p, idx) => {
                  const currentRank = rankingMode === 'units' ? p.rank_by_units : p.rank_by_revenue;
                  return (
                    <tr key={p.product_id} className="hover:bg-slate-800/50 transition">
                      <td className="px-4 py-3 text-center font-bold text-slate-400">
                        {currentRank <= 3 ? (
                          <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                            currentRank === 1 ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' :
                            currentRank === 2 ? 'bg-slate-300/20 text-slate-200 border border-slate-300/30' :
                            'bg-amber-700/20 text-amber-500 border border-amber-700/30'
                          }`}>
                            {currentRank}
                          </span>
                        ) : (
                          currentRank
                        )}
                      </td>
                      <td className="px-4 py-3 font-medium text-white">
                        {p.product_name}
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded text-[11px] bg-slate-800 text-slate-300 border border-slate-700">
                          {p.category}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-white">
                        {p.units_sold.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right text-emerald-400 font-mono">
                        {p.velocity_period_days.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right text-cyan-400 font-mono">
                        {p.velocity_active_days.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-white">
                        {currency(p.revenue)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300">
                        {p.sales_share.toFixed(1)}%
                      </td>
                      <td className="px-4 py-3 text-center text-slate-400">
                        {p.transaction_count}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* SECTION C: PRODUCT / CATEGORY PERFORMANCE */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Category Performance */}
        <div className="bg-slate-800/60 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-indigo-400" />
              <h2 className="text-base font-bold text-white">Category Sales Performance</h2>
            </div>
            <span className="text-xs text-slate-400">Grouped Breakdown</span>
          </div>

          <div className="space-y-3">
            {analytics.category_performance.length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center">No categories recorded.</p>
            ) : (
              analytics.category_performance.map((c) => (
                <div key={c.category} className="bg-slate-800/80 border border-slate-700/60 rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-white">{c.category}</span>
                    <span className="text-slate-300 font-bold">{currency(c.revenue)} ({c.sales_share.toFixed(1)}%)</span>
                  </div>
                  <div className="w-full bg-slate-700/60 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-indigo-500 h-full rounded-full transition-all duration-300"
                      style={{ width: `${Math.min(100, Math.max(2, c.sales_share))}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>{c.units_sold.toLocaleString()} units sold</span>
                    <span>{c.transaction_count} transactions</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Top Products Leaderboard */}
        <div className="bg-slate-800/60 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Award className="w-5 h-5 text-amber-400" />
              <h2 className="text-base font-bold text-white">Top 5 Products by Revenue</h2>
            </div>
            <span className="text-xs text-slate-400">Highest Contribution</span>
          </div>

          <div className="space-y-3">
            {analytics.fast_moving_products.slice(0, 5).length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center">No products sold in this period.</p>
            ) : (
              analytics.fast_moving_products
                .sort((a, b) => b.revenue - a.revenue)
                .slice(0, 5)
                .map((p, idx) => (
                  <div key={p.product_id} className="flex items-center justify-between p-3 rounded-xl bg-slate-800/80 border border-slate-700/60">
                    <div className="flex items-center gap-3">
                      <span className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold text-slate-300">
                        {idx + 1}
                      </span>
                      <div>
                        <p className="text-xs font-medium text-white">{p.product_name}</p>
                        <p className="text-[11px] text-slate-400">{p.category} • {p.units_sold} units</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-bold text-white">{currency(p.revenue)}</p>
                      <p className="text-[11px] text-emerald-400 font-semibold">{p.sales_share.toFixed(1)}% share</p>
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>
      </section>

      {/* SECTION D: CUSTOMER INTELLIGENCE */}
      <section className="bg-slate-800/60 border border-slate-800 rounded-2xl p-6 space-y-6">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-400" />
            <h2 className="text-base font-bold text-white">D. Customer Intelligence</h2>
          </div>
          <span className="text-xs text-slate-400">
            {analytics.customer_intelligence.total_customers} Total Registered in Database
          </span>
        </div>

        {/* Customer Metrics Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          <div className="bg-slate-800/80 border border-slate-700/60 rounded-xl p-4">
            <p className="text-xs text-slate-400">Active Buyers</p>
            <p className="text-xl font-bold text-white mt-1">{analytics.customer_intelligence.unique_customers}</p>
            <p className="text-[10px] text-slate-500 mt-1">Purchased in period</p>
          </div>

          <div className="bg-slate-800/80 border border-slate-700/60 rounded-xl p-4">
            <p className="text-xs text-slate-400">New Customers</p>
            <p className="text-xl font-bold text-emerald-400 mt-1">{analytics.customer_intelligence.new_customers}</p>
            <p className="text-[10px] text-slate-500 mt-1">Registered in period</p>
          </div>

          <div className="bg-slate-800/80 border border-slate-700/60 rounded-xl p-4">
            <p className="text-xs text-slate-400">Returning Customers</p>
            <p className="text-xl font-bold text-cyan-400 mt-1">{analytics.customer_intelligence.returning_customers}</p>
            <p className="text-[10px] text-slate-500 mt-1">Prior registered clients</p>
          </div>

          <div className="bg-slate-800/80 border border-slate-700/60 rounded-xl p-4">
            <p className="text-xs text-slate-400">Repeat Purchase Rate</p>
            <p className="text-xl font-bold text-purple-400 mt-1">{analytics.customer_intelligence.repeat_purchase_rate.toFixed(1)}%</p>
            <p className="text-[10px] text-slate-500 mt-1">≥ 2 sales in period</p>
          </div>

          <div className="bg-slate-800/80 border border-slate-700/60 rounded-xl p-4">
            <p className="text-xs text-slate-400">Avg Customer Spend</p>
            <p className="text-xl font-bold text-white mt-1">{currency(analytics.customer_intelligence.average_customer_spend)}</p>
            <p className="text-[10px] text-slate-500 mt-1">Per active customer</p>
          </div>

          <div className="bg-slate-800/80 border border-slate-700/60 rounded-xl p-4">
            <p className="text-xs text-slate-400">Purchase Frequency</p>
            <p className="text-xl font-bold text-white mt-1">{analytics.customer_intelligence.purchase_frequency.toFixed(1)}</p>
            <p className="text-[10px] text-slate-500 mt-1">Sales per buyer</p>
          </div>
        </div>

        {/* Top Customers Leaderboard */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Top Customers by Period Spend
          </h3>
          <div className="overflow-x-auto rounded-xl border border-slate-700/80 bg-slate-900/60">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-800/90 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-700">
                <tr>
                  <th className="px-4 py-3">Customer Name</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Acquisition Channel</th>
                  <th className="px-4 py-3 text-center">Transactions</th>
                  <th className="px-4 py-3 text-right">Period Spend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {analytics.customer_intelligence.top_customers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                      No customer sales recorded for this period.
                    </td>
                  </tr>
                ) : (
                  analytics.customer_intelligence.top_customers.map((c) => (
                    <tr key={c.customer_id} className="hover:bg-slate-800/40 transition">
                      <td className="px-4 py-3 font-medium text-white">{c.customer_name}</td>
                      <td className="px-4 py-3 text-slate-400 font-mono">{c.customer_phone || '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
                          c.customer_source === 'UNKNOWN' ? 'bg-slate-800 text-slate-400 border-slate-700' :
                          'bg-emerald-950/60 text-emerald-400 border-emerald-800/50'
                        }`}>
                          {c.customer_source ? c.customer_source.replace('_', ' ') : 'UNKNOWN'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center font-semibold text-white">{c.transaction_count}</td>
                      <td className="px-4 py-3 text-right font-bold text-white">{currency(c.total_spent)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* SECTION E: CUSTOMER SOURCE / ACQUISITION INTELLIGENCE */}
      <section className="bg-slate-800/60 border border-slate-800 rounded-2xl p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2">
            <Share2 className="w-5 h-5 text-emerald-400" />
            <h2 className="text-base font-bold text-white">E. Customer Acquisition Channel Intelligence</h2>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-amber-400/90 bg-amber-500/10 px-2.5 py-1 rounded-lg border border-amber-500/20">
            <HelpCircle className="w-3.5 h-3.5" />
            <span>Strict explicit attribution: Missing source is classified as Unknown / Unrecorded.</span>
          </div>
        </div>

        {/* Visual Share Distribution Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Channel Sales Distribution</span>
            <span>Total Sales: {currency(analytics.kpis.total_sales)}</span>
          </div>
          <div className="w-full h-3 rounded-full bg-slate-700/60 flex overflow-hidden">
            {analytics.customer_sources.map((s, idx) => {
              if (s.sales_share <= 0) return null;
              const colors = [
                'bg-emerald-500',
                'bg-teal-500',
                'bg-cyan-500',
                'bg-blue-500',
                'bg-indigo-500',
                'bg-purple-500',
                'bg-slate-500',
              ];
              return (
                <div
                  key={s.source}
                  title={`${s.label}: ${s.sales_share.toFixed(1)}%`}
                  className={`${colors[idx % colors.length]} h-full transition-all`}
                  style={{ width: `${s.sales_share}%` }}
                />
              );
            })}
          </div>
        </div>

        {/* Source Table */}
        <div className="overflow-x-auto rounded-xl border border-slate-700/80 bg-slate-900/60">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-800/90 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-700">
              <tr>
                <th className="px-4 py-3">Acquisition Channel</th>
                <th className="px-4 py-3 text-center">Active Customers</th>
                <th className="px-4 py-3 text-center">Completed Transactions</th>
                <th className="px-4 py-3 text-right">Attributed Sales</th>
                <th className="px-4 py-3 text-right">Sales Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {analytics.customer_sources.map((s) => (
                <tr key={s.source} className="hover:bg-slate-800/40 transition">
                  <td className="px-4 py-3 font-semibold text-white flex items-center gap-2">
                    <span className={`w-2.5 h-2.5 rounded-full ${
                      s.source === 'UNKNOWN' ? 'bg-slate-500' :
                      s.source === 'WALK_IN' ? 'bg-emerald-400' :
                      s.source === 'WHATSAPP' ? 'bg-teal-400' :
                      s.source === 'FACEBOOK' ? 'bg-blue-400' :
                      s.source === 'INSTAGRAM' ? 'bg-purple-400' :
                      s.source === 'REFERRAL' ? 'bg-amber-400' :
                      'bg-indigo-400'
                    }`} />
                    {s.label}
                  </td>
                  <td className="px-4 py-3 text-center font-medium text-slate-300">
                    {s.customer_count}
                  </td>
                  <td className="px-4 py-3 text-center font-medium text-slate-300">
                    {s.transaction_count}
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-white">
                    {currency(s.sales)}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-emerald-400">
                    {s.sales_share.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
