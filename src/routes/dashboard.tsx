import { useState, useEffect, useMemo } from 'react';
import { TrendingUp, DollarSign, ShoppingCart, Users, CreditCard, Star, Calendar, FileText, Printer, Download, Search, RefreshCw, X } from 'lucide-react';
import { getAllTransactions, getAllCustomers, getAllInstallmentPlans, getAllProducts } from '../lib/db';
import { getTodaySummary, getWeekSummary, getMonthSummary, formatCurrency } from '../lib/ledger';
import { KCBDashboardWidget } from '../components/MpesaDashboardWidget';
import type { Transaction, Customer, InstallmentPlan, Product } from '../lib/types';

export function DashboardPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [installmentPlans, setInstallmentPlans] = useState<InstallmentPlan[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month'>('today');
  const [searchDate, setSearchDate] = useState('');
  const [searchDay, setSearchDay] = useState('all');
  const [paymentMethod, setPaymentMethod] = useState('all');
  const [paymentAccount, setPaymentAccount] = useState('all');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
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
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    switch (timeRange) {
      case 'today':
        return { start: today, end: now };
      case 'week': {
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);
        return { start: weekAgo, end: now };
      }
      case 'month': {
        const monthAgo = new Date(today);
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        return { start: monthAgo, end: now };
      }
    }
  }, [timeRange]);

  const paymentMethods = useMemo(() => [...new Set(transactions.map((tx) => tx.payment_method))].sort(), [transactions]);
  const paymentAccounts = useMemo(() => [...new Set(transactions.map((tx) => tx.payment_account_id ? `${tx.payment_account_id}|${tx.payment_account_name ?? tx.payment_account_id}` : 'unassigned'))].sort(), [transactions]);
  const filteredTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      if (tx.status === 'voided') return false;
      const txDate = new Date(tx.created_at);
      const localDate = `${txDate.getFullYear()}-${String(txDate.getMonth() + 1).padStart(2, '0')}-${String(txDate.getDate()).padStart(2, '0')}`;
      const dayMatches = searchDay === 'all' || txDate.getDay() === Number(searchDay);
      const dateMatches = !searchDate || localDate === searchDate;
      const accountKey = tx.payment_account_id ? `${tx.payment_account_id}|${tx.payment_account_name ?? tx.payment_account_id}` : 'unassigned';
      return txDate >= dateRange.start && txDate <= dateRange.end && dayMatches && dateMatches && (paymentMethod === 'all' || tx.payment_method === paymentMethod) && (paymentAccount === 'all' || accountKey === paymentAccount);
    });
  }, [transactions, dateRange, searchDate, searchDay, paymentMethod, paymentAccount]);

  const stats = useMemo(() => {
    const totalRevenue = filteredTransactions.reduce((sum, tx) => sum + tx.amount_paid, 0);
    const totalTransactions = filteredTransactions.length;
    const averageTransaction = totalTransactions > 0 ? totalRevenue / totalTransactions : 0;

    const uniqueCustomers = new Set(filteredTransactions.map((tx) => tx.customer_id).filter(Boolean)).size;

    const loyaltyPointsEarned = customers.reduce((sum, c) => sum + c.loyalty_points, 0);
    const activeInstallments = installmentPlans.filter((p) => p.status === 'active').length;
    const pendingInstallmentAmount = installmentPlans
      .filter((p) => p.status === 'active')
      .reduce((sum, p) => sum + (p.total_amount - p.amount_paid), 0);

    return {
      totalRevenue,
      totalTransactions,
      averageTransaction,
      uniqueCustomers,
      loyaltyPointsEarned,
      activeInstallments,
      pendingInstallmentAmount,
    };
  }, [filteredTransactions, customers, installmentPlans]);

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
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 10);
  }, [filteredTransactions]);

  const salesByDay = useMemo(() => {
    const dayStats: Record<string, { date: string; revenue: number; count: number }> = {};

    for (let d = new Date(dateRange.start); d <= dateRange.end; d = new Date(d.getTime() + 86400000)) {
      const dateStr = d.toISOString().split('T')[0];
      dayStats[dateStr] = { date: dateStr, revenue: 0, count: 0 };
    }

    filteredTransactions.forEach((tx) => {
      const txDate = new Date(tx.created_at);
      const dateStr = `${txDate.getFullYear()}-${String(txDate.getMonth() + 1).padStart(2, '0')}-${String(txDate.getDate()).padStart(2, '0')}`;
      if (dayStats[dateStr]) {
        dayStats[dateStr].revenue += tx.amount_paid;
        dayStats[dateStr].count += 1;
      }
    });

    return Object.values(dayStats).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredTransactions, dateRange]);

  const maxRevenue = Math.max(...salesByDay.map((d) => d.revenue), 1);

  const stockByProduct = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const stockLabel = (stock: number, lowStockAlert = 5) => {
    if (stock <= 0) return { label: 'Out of stock', className: 'bg-red-500/15 text-red-300 border-red-500/30' };
    if (stock <= lowStockAlert) return { label: `${stock} in stock`, className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' };
    return { label: `${stock} in stock`, className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
  };

  const openDetailedReport = (print = false) => {
    const generatedAt = new Date();
    const rows = filteredTransactions.flatMap((tx) => (tx.items ?? []).map((item) => {
      const product = stockByProduct.get(item.product_id);
      const stock = product?.stock ?? 0;
      const stockClass = stock <= 0 ? 'out' : stock <= (product?.low_stock_alert || 5) ? 'low' : 'ok';
      const customer = customers.find((entry) => entry.id === tx.customer_id)?.name || 'Walk-in';
      return `<tr><td>${new Date(tx.created_at).toLocaleDateString()}<br><small>${new Date(tx.created_at).toLocaleTimeString()}</small></td><td>${customer}</td><td><strong>${item.product_name}</strong></td><td class="text-right">${item.quantity}</td><td class="text-right">KES ${(item.unit_price ?? 0).toLocaleString()}</td><td class="text-right">KES ${(item.subtotal ?? 0).toLocaleString()}</td><td>${tx.payment_method.replace('_', ' ')}</td><td class="${stockClass}"><strong>${stock}</strong> in stock</td><td>${tx.payment_account_name || tx.payment_account_id || 'None'}</td></tr>`;
    })).join('');
    const html = `<!doctype html><html><head><title>Jimwas POS Detailed Sales Report</title><style>body{font:13px Arial,sans-serif;color:#172033;margin:28px}h1{margin:0 0 4px}p{color:#64748b}.actions{margin:12px 0}.actions button{padding:6px 12px;background:#10b981;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:12px}table{width:100%;border-collapse:collapse;margin-top:16px}th{background:#f3f4f6;padding:8px;text-align:left;font-weight:600;border-bottom:1px solid #d1d5db}td{padding:8px;border-bottom:1px solid #e5e7eb}.out{background:#fee2e2;color:#7f1d1d}.low{background:#fef3c7;color:#78350f}.ok{background:#dcfce7;color:#166534}</style></head><body><h1>Jimwas POS - Detailed Sales Report</h1><p><strong>Generated:</strong> ${generatedAt.toLocaleString()}</p><p><strong>Payment Method:</strong> ${paymentMethod === 'all' ? 'All Methods' : paymentMethod}</p><p><strong>Payment Account:</strong> ${paymentAccount === 'all' ? 'All Accounts' : paymentAccount}</p><table><thead><tr><th>Date & Time</th><th>Customer</th><th>Product</th><th>Qty</th><th>Unit Price</th><th>Total</th><th>Method</th><th>Stock</th><th>Account</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) return;
    reportWindow.document.open();
    reportWindow.document.write(html);
    reportWindow.document.close();
    reportWindow.focus();
    if (print) window.setTimeout(() => reportWindow.print(), 500);
  };

  const lowStockProducts = products.filter(
    (p) => p.stock > 0 && p.stock <= (p.low_stock_alert || 5)
  );
  const outOfStockProducts = products.filter((p) => p.stock === 0);

  return (
    <div className="space-y-6">
      {/* Dashboard Controls */}
      <div className="flex flex-col gap-3 rounded-xl bg-slate-800 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2 bg-slate-700/70 rounded-lg p-1">
          {(['today', 'week', 'month'] as const).map((range) => <button key={range} onClick={() => setTimeRange(range)} className={`px-4 py-2 rounded-md text-sm font-medium transition ${timeRange === range ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:text-white'}`}>{range.charAt(0).toUpperCase() + range.slice(1)}</button>)}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 rounded-lg bg-slate-700 px-3 py-2 text-sm text-slate-300"><Search size={16} /><span className="sr-only">Search by date</span><input type="date" value={searchDate} onChange={(event) => setSearchDate(event.target.value)} className="bg-transparent text-white outline-none" /></label>
          <label className="rounded-lg bg-slate-700 px-3 py-2 text-sm text-slate-300"><span className="sr-only">Filter payment method</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} className="bg-transparent text-white outline-none"><option value="all">All Methods</option>{paymentMethods.map((method) => <option key={method} value={method}>{method.replace('_', ' ').toUpperCase()}</option>)}</select></label>
          <label className="rounded-lg bg-slate-700 px-3 py-2 text-sm text-slate-300"><span className="sr-only">Filter payment account</span><select value={paymentAccount} onChange={(event) => setPaymentAccount(event.target.value)} className="bg-transparent text-white outline-none"><option value="all">All Accounts</option>{paymentAccounts.map((account) => <option key={account} value={account}>{account === 'unassigned' ? 'Unassigned' : account.split('|')[1]}</option>)}</select></label>
          <label className="rounded-lg bg-slate-700 px-3 py-2 text-sm text-slate-300"><span className="sr-only">Search by day</span><select value={searchDay} onChange={(event) => setSearchDay(event.target.value)} className="bg-transparent text-white outline-none"><option value="all">All Days</option><option value="0">Sunday</option><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option></select></label>
          {(searchDate || searchDay !== 'all') && <button onClick={() => { setSearchDate(''); setSearchDay('all'); }} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-slate-200"><X size={16} />Clear</button>}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <p className="text-sm text-slate-400">Showing <span className="font-semibold text-white">{filteredTransactions.length}</span> transactions for the selected period</p>
      </div>
      {/* Main Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="bg-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="w-10 h-10 bg-emerald-600/20 rounded-lg flex items-center justify-center">
              <DollarSign size={20} className="text-emerald-400" />
            </div>
            <TrendingUp size={18} className="text-emerald-400" />
          </div>
          <p className="text-3xl font-bold text-white">KES {stats.totalRevenue.toLocaleString()}</p>
          <p className="text-sm text-slate-400">Total Revenue</p>
        </div>

        <div className="bg-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="w-10 h-10 bg-blue-600/20 rounded-lg flex items-center justify-center">
              <ShoppingCart size={20} className="text-blue-400" />
            </div>
          </div>
          <p className="text-3xl font-bold text-white">{stats.totalTransactions}</p>
          <p className="text-sm text-slate-400">Transactions</p>
        </div>

        <div className="bg-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="w-10 h-10 bg-purple-600/20 rounded-lg flex items-center justify-center">
              <Users size={20} className="text-purple-400" />
            </div>
          </div>
          <p className="text-3xl font-bold text-white">{stats.uniqueCustomers}</p>
          <p className="text-sm text-slate-400">Unique Customers</p>
        </div>

        <div className="bg-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="w-10 h-10 bg-amber-600/20 rounded-lg flex items-center justify-center">
              <DollarSign size={20} className="text-amber-400" />
            </div>
          </div>
          <p className="text-3xl font-bold text-white">KES {Math.round(stats.averageTransaction).toLocaleString()}</p>
          <p className="text-sm text-slate-400">Avg. Transaction</p>
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
          ) : salesByDay.length === 0 || salesByDay.every((day) => day.revenue === 0) ? (
            <div className="h-64 flex items-center justify-center text-slate-400">No sales data for this period</div>
          ) : (
            <div className="flex h-64 items-end gap-1">
              {salesByDay.map((day, i) => {
                const height = (day.revenue / maxRevenue) * 100;
                const date = new Date(`${day.date}T12:00:00`);
                return (
                  <div key={i} className="group flex h-full flex-1 flex-col items-center justify-end gap-1" style={{ minHeight: '100%' }}>
                    <div className="w-full rounded-t bg-emerald-600/60 hover:bg-emerald-600" style={{ height: `${height}%`, minHeight: '4px' }} />
                    <span className="hidden text-xs text-slate-400 group-hover:inline">{date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
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

      {/* Detailed Sales Report with Enhanced Filters */}
      <div className="bg-slate-800 rounded-xl p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4">
          <div className="flex items-center gap-2">
            <FileText size={18} className="text-emerald-400" />
            <div>
              <h3 className="font-medium text-white">Detailed Sales Report</h3>
              <p className="text-xs text-slate-400">Full item descriptions and exact stock as of report generation by accounts and payment methods</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => openDetailedReport(false)} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500"><Download size={16} />Export</button>
            <button onClick={() => openDetailedReport(true)} className="inline-flex items-center gap-2 rounded-lg bg-slate-700 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-600"><Printer size={16} />Print</button>
          </div>
        </div>

        {/* Enhanced Report Filters */}
        <div className="mb-4 flex flex-wrap gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span className="font-medium">Payment Method:</span>
            <select
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value)}
              className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-white focus:border-emerald-500 focus:outline-none"
            >
              <option value="all">All Methods</option>
              {paymentMethods.map((method) => (
                <option key={method} value={method}>
                  {method.replace('_', ' ').toUpperCase()}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span className="font-medium">Payment Account:</span>
            <select
              value={paymentAccount}
              onChange={(event) => setPaymentAccount(event.target.value)}
              className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-white focus:border-emerald-500 focus:outline-none"
            >
              <option value="all">All Accounts</option>
              {paymentAccounts.map((account) => (
                <option key={account} value={account}>
                  {account === 'unassigned' ? 'Unassigned' : account.split('|')[1]}
                </option>
              ))}
            </select>
          </label>

          {(paymentMethod !== 'all' || paymentAccount !== 'all') && (
            <button
              onClick={() => {
                setPaymentMethod('all');
                setPaymentAccount('all');
              }}
              className="ml-auto rounded-lg bg-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-600"
            >
              Clear Filters
            </button>
          )}
        </div>

        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-1 text-emerald-300">✓ Healthy stock</span>
          <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-1 text-amber-300">⚠ Low stock</span>
          <span className="rounded-full border border-red-500/30 bg-red-500/15 px-2 py-1 text-red-300">✗ Out of stock</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px]">
            <thead>
              <tr className="border-b border-slate-700 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Date & Time</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3 text-right">Unit Price</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Payment Method</th>
                <th className="px-4 py-3">Stock Status</th>
                <th className="px-4 py-3">Account</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filteredTransactions.length > 0 ? (
                filteredTransactions.slice(0, 50).flatMap((tx) =>
                  (tx.items ?? []).map((item, idx) => {
                    const product = stockByProduct.get(item.product_id);
                    const stock = product?.stock ?? 0;
                    const customer = customers.find((c) => c.id === tx.customer_id)?.name || 'Walk-in';
                    const accountName = tx.payment_account_name || tx.payment_account_id || 'None';

                    return (
                      <tr key={`${tx.id}-${idx}`} className="hover:bg-slate-700/50">
                        <td className="px-4 py-3 text-sm text-slate-300">
                          {new Date(tx.created_at).toLocaleDateString()}
                          <br />
                          <small>{new Date(tx.created_at).toLocaleTimeString()}</small>
                        </td>
                        <td className="px-4 py-3 text-sm text-white">{customer}</td>
                        <td className="px-4 py-3 text-sm font-medium text-white">
                          {item.product_name}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-slate-300">
                          {item.quantity}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-slate-300">
                          KES {(item.unit_price ?? 0).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-emerald-400">
                          KES {(item.subtotal ?? 0).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-300 capitalize">
                          {tx.payment_method.replace('_', ' ')}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full border px-2 py-1 text-xs font-medium ${
                              stock <= 0
                                ? 'border-red-500/30 bg-red-500/15 text-red-300'
                                : stock <= (product?.low_stock_alert || 5)
                                  ? 'border-amber-500/30 bg-amber-500/15 text-amber-300'
                                  : 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                            }`}
                          >
                            {stock} in stock
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-300">{accountName}</td>
                      </tr>
                    );
                  })
                )
              ) : (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-400">
                    No transactions for the selected filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Transactions */}
      <div className="bg-slate-800 rounded-xl p-4">
        <h3 className="font-medium text-white mb-4 flex items-center gap-2">
          <ShoppingCart size={18} className="text-emerald-400" />
          Recent Transactions
        </h3>
        {recentTransactions.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-sm text-slate-400 border-b border-slate-700">
                  <th className="pb-2">Date</th>
                  <th className="pb-2">Customer</th>
                  <th className="pb-2">Items</th>
                  <th className="pb-2 text-right">Amount</th>
                  <th className="pb-2 text-right">Payment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {recentTransactions.map((tx) => {
                  const customer = customers.find((c) => c.id === tx.customer_id);
                  return (
                    <tr key={tx.id} className="hover:bg-slate-700/50">
                      <td className="py-3 text-sm text-slate-400">
                        {new Date(tx.created_at).toLocaleDateString()}
                      </td>
                      <td className="py-3 text-white">{customer?.name || 'Walk-in'}</td>
                      <td className="py-3 text-slate-400">{tx.items?.length || 0} items</td>
                      <td className="py-3 text-right text-emerald-400 font-medium">
                        KES {tx.total_amount.toLocaleString()}
                      </td>
                      <td className="py-3 text-right">
                        <span className="px-2 py-1 bg-slate-700 rounded text-xs text-slate-300">
                          {tx.payment_method}
                        </span>
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
      </div>

      {/* Inventory Alerts */}
      <div className="bg-slate-800 rounded-xl p-4">
        <h3 className="font-medium text-white mb-4 flex items-center gap-2">
          <Calendar size={18} className="text-amber-400" />
          Inventory Alerts
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-slate-700 rounded-lg p-4">
            <p className="text-sm text-slate-400 mb-2">Low Stock ({'<'}=10)</p>
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
