import { useRef, useEffect } from 'react';
import { X, Receipt, ShoppingBag, Truck, CreditCard, ShieldCheck } from 'lucide-react';
import type { Transaction } from '../lib/types';

interface TransactionDetailModalProps {
  transaction: Transaction | null;
  isOpen: boolean;
  onClose: () => void;
}

export function TransactionDetailModal({ transaction, isOpen, onClose }: TransactionDetailModalProps) {
  const modalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !transaction) return null;

  // Safe field resolution preserving historical records without fabrication
  const subtotalText = transaction.subtotal !== undefined 
    ? `KES ${transaction.subtotal.toLocaleString()}` 
    : (transaction.items && transaction.items.length > 0)
      ? `KES ${transaction.items.reduce((s, it) => s + it.subtotal, 0).toLocaleString()}`
      : 'Not recorded';

  const discountText = transaction.discount !== undefined
    ? `KES ${transaction.discount.toLocaleString()}`
    : 'Not recorded';

  const formatDeliveryType = (type?: string) => {
    if (!type) return 'Not recorded';
    if (type === 'none') return 'No Delivery';
    if (type === 'to_cbd') return 'Delivery Fee to CBD';
    if (type === 'from_cbd_300' || type === 'from_cbd') return 'Delivery Fee from CBD (KES 300)';
    if (type === 'from_cbd_500') return 'Delivery Fee from CBD (KES 500)';
    return type;
  };

  const deliveryTypeText = transaction.delivery_type 
    ? formatDeliveryType(transaction.delivery_type) 
    : 'Not recorded';

  const deliveryFeeText = transaction.delivery_fee !== undefined
    ? `KES ${transaction.delivery_fee.toLocaleString()}`
    : 'Not recorded';

  const paymentAccountText = transaction.payment_account || transaction.payment_account_name || 'Not recorded';
  const paymentStatusText = transaction.status ? transaction.status.toUpperCase() : 'Not recorded';
  const transactionStatusText = transaction.status ? transaction.status.toUpperCase() : 'Not recorded';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="transaction-detail-title"
        className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-800 p-6 shadow-2xl text-white max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700 pb-4">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-emerald-500/20 p-2 text-emerald-400">
              <Receipt className="h-6 w-6" />
            </div>
            <div>
              <h3 id="transaction-detail-title" className="text-xl font-bold">
                Transaction Details
              </h3>
              <p className="text-xs text-slate-400">ID: {transaction.id}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-700 hover:text-white transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto py-4 space-y-6">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div className="rounded-lg bg-slate-700/50 p-3 border border-slate-600/50">
              <span className="text-xs text-slate-400 block">Date & Time</span>
              <span className="font-semibold text-slate-200">
                {new Date(transaction.created_at).toLocaleString()}
              </span>
            </div>
            <div className="rounded-lg bg-slate-700/50 p-3 border border-slate-600/50">
              <span className="text-xs text-slate-400 block">Cashier</span>
              <span className="font-semibold text-slate-200">
                {transaction.cashier_name || 'System'}
              </span>
            </div>
            <div className="rounded-lg bg-slate-700/50 p-3 border border-slate-600/50">
              <span className="text-xs text-slate-400 block">Payment Status</span>
              <span className={`font-semibold ${transaction.status === 'completed' || transaction.status === 'success' ? 'text-emerald-400' : 'text-amber-400'}`}>
                {paymentStatusText}
              </span>
            </div>
            <div className="rounded-lg bg-slate-700/50 p-3 border border-slate-600/50">
              <span className="text-xs text-slate-400 block">Transaction Status</span>
              <span className={`font-semibold ${transaction.status === 'completed' || transaction.status === 'success' ? 'text-emerald-400' : 'text-amber-400'}`}>
                {transactionStatusText}
              </span>
            </div>
          </div>

          {/* Delivery & Payment Account Details */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-xl bg-slate-700/30 border border-slate-700 p-4 space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 font-semibold mb-1">
                <Truck className="h-4 w-4" />
                <span>Delivery Information</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Delivery Type:</span>
                <span className="text-white font-medium">{deliveryTypeText}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Delivery Fee:</span>
                <span className="text-amber-300 font-semibold">{deliveryFeeText}</span>
              </div>
            </div>

            <div className="rounded-xl bg-slate-700/30 border border-slate-700 p-4 space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 font-semibold mb-1">
                <CreditCard className="h-4 w-4" />
                <span>Payment Account Information</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Payment Account:</span>
                <span className="text-white font-bold">{paymentAccountText}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Payment Method:</span>
                <span className="text-slate-200 capitalize">{transaction.payment_method?.replace('_', ' ') || 'Not recorded'}</span>
              </div>
              {transaction.mpesa_receipt && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-400">M-Pesa Receipt:</span>
                  <span className="text-emerald-300 font-mono">{transaction.mpesa_receipt}</span>
                </div>
              )}
            </div>
          </div>

          {/* Items Purchased */}
          {transaction.items && transaction.items.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
                <ShoppingBag className="h-4 w-4 text-emerald-400" />
                Merchandise Items ({transaction.items.length})
              </h4>
              <div className="rounded-xl border border-slate-700 bg-slate-700/30 overflow-hidden">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-700/60 text-xs text-slate-400 uppercase">
                    <tr>
                      <th className="p-2.5">Item</th>
                      <th className="p-2.5 text-center">Qty</th>
                      <th className="p-2.5 text-right">Unit Price</th>
                      <th className="p-2.5 text-right">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {transaction.items.map((item, idx) => (
                      <tr key={item.id || idx}>
                        <td className="p-2.5 text-slate-200">{item.product_name}</td>
                        <td className="p-2.5 text-center text-slate-300">{item.quantity}</td>
                        <td className="p-2.5 text-right text-slate-300">KES {item.unit_price.toLocaleString()}</td>
                        <td className="p-2.5 text-right font-medium text-white">KES {item.subtotal.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Financial Summary */}
          <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 space-y-2">
            <h4 className="text-xs uppercase tracking-wider text-slate-400 font-semibold mb-2">Financial Breakdown</h4>
            <div className="flex justify-between text-sm text-slate-300">
              <span>Merchandise Subtotal:</span>
              <span className="font-semibold text-white">{subtotalText}</span>
            </div>
            <div className="flex justify-between text-sm text-slate-300">
              <span>Discount:</span>
              <span className="text-slate-300">{discountText}</span>
            </div>
            <div className="flex justify-between text-sm text-amber-300">
              <span>Delivery Fee:</span>
              <span className="font-semibold">{deliveryFeeText}</span>
            </div>
            <div className="flex justify-between text-base font-bold border-t border-slate-700 pt-2 text-white">
              <span>Final Total:</span>
              <span className="text-emerald-400">KES {transaction.total_amount.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-xs text-slate-400 pt-1">
              <span>Amount Paid:</span>
              <span>KES {transaction.amount_paid.toLocaleString()} (Change: KES {transaction.change_amount.toLocaleString()})</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-700 pt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl bg-slate-700 text-white font-medium hover:bg-slate-600 transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
