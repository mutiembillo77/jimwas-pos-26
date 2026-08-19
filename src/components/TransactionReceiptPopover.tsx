import React from 'react';
import { Receipt, Calendar, User, CreditCard, ShoppingBag, CheckCircle2, ShieldAlert, Sparkles, Hash, Phone } from 'lucide-react';
import type { Transaction, Customer } from '../lib/types';
import { resolvePaymentAccountDetails, maskPhoneNumber } from '../lib/print';

interface TransactionReceiptPopoverProps {
  transaction: Transaction;
  customer?: Customer;
  position?: { x: number; y: number } | null;
}

export function TransactionReceiptPopover({ transaction, customer, position }: TransactionReceiptPopoverProps) {
  const accountDetails = resolvePaymentAccountDetails(transaction);
  const phone = customer?.phone || transaction.customer_phone;
  const maskedPhone = maskPhoneNumber(phone);

  // Determine positioning style
  const style: React.CSSProperties = position
    ? {
        position: 'fixed',
        left: `${Math.min(position.x + 20, window.innerWidth - 360)}px`,
        top: `${Math.max(20, Math.min(position.y - 120, window.innerHeight - 520))}px`,
        zIndex: 9999,
      }
    : {
        position: 'absolute',
        right: '100%',
        marginRight: '12px',
        top: '50%',
        transform: 'translateY(-50%)',
        zIndex: 50,
      };

  const formattedDate = new Date(transaction.created_at).toLocaleString('en-KE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const getPaymentBadgeColor = (method: string) => {
    switch (method.toLowerCase()) {
      case 'kcb_buni':
      case 'kcb':
      case 'buni':
      case 'mpesa':
        return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
      case 'ncba':
        return 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30';
      case 'cash':
        return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
      default:
        return 'bg-slate-700 text-slate-300 border-slate-600';
    }
  };

  return (
    <div
      style={style}
      className="w-80 bg-slate-900/95 border border-emerald-500/30 rounded-2xl shadow-2xl p-4 text-xs backdrop-blur-xl text-slate-200 animate-in fade-in zoom-in-95 duration-150 pointer-events-none select-none"
    >
      {/* Receipt Header Card */}
      <div className="relative overflow-hidden bg-gradient-to-r from-emerald-900/40 via-slate-800 to-emerald-950/40 p-3 rounded-xl border border-emerald-500/20 mb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-inner">
              <Receipt size={18} />
            </div>
            <div>
              <h4 className="font-bold text-white tracking-wide text-xs uppercase flex items-center gap-1">
                JIMWAS POS
                <Sparkles size={12} className="text-emerald-400" />
              </h4>
              <p className="text-[10px] text-emerald-400/90 font-mono">OFFICIAL RECEIPT</p>
            </div>
          </div>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
            transaction.status === 'voided' 
              ? 'bg-rose-500/20 text-rose-400 border-rose-500/30' 
              : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
          }`}>
            {transaction.status.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Meta details grid */}
      <div className="space-y-1.5 bg-slate-800/60 p-2.5 rounded-xl border border-slate-700/60 mb-3">
        <div className="flex justify-between items-center text-slate-400 text-[11px]">
          <span className="flex items-center gap-1">
            <Hash size={12} className="text-slate-500" /> Txn ID:
          </span>
          <span className="font-mono text-slate-200 font-medium">{transaction.id.slice(0, 12)}...</span>
        </div>
        <div className="flex justify-between items-center text-slate-400 text-[11px]">
          <span className="flex items-center gap-1">
            <Calendar size={12} className="text-slate-500" /> Date:
          </span>
          <span className="text-slate-200">{formattedDate}</span>
        </div>
        <div className="flex justify-between items-center text-slate-400 text-[11px]">
          <span className="flex items-center gap-1">
            <User size={12} className="text-slate-500" /> Customer:
          </span>
          <span className="text-slate-200 font-medium">
            {customer?.name || transaction.customer_name || 'Walk-in Customer'}
          </span>
        </div>
        {maskedPhone && (
          <div className="flex justify-between items-center text-slate-400 text-[11px]">
            <span className="flex items-center gap-1">
              <Phone size={12} className="text-slate-500" /> Phone:
            </span>
            <span className="text-slate-300 font-mono">{maskedPhone}</span>
          </div>
        )}
        {transaction.sale_type && (
          <div className="flex justify-between items-center text-slate-400 text-[11px]">
            <span className="flex items-center gap-1">
              <ShoppingBag size={12} className="text-slate-500" /> Type:
            </span>
            <span className="capitalize text-emerald-400 font-medium">{transaction.sale_type.replace('_', ' ')}</span>
          </div>
        )}
      </div>

      {/* Dashed Separator */}
      <div className="relative my-2 border-b border-dashed border-slate-700">
        <div className="absolute -left-5 -top-1.5 w-3 h-3 bg-slate-900 rounded-full border-r border-slate-700"></div>
        <div className="absolute -right-5 -top-1.5 w-3 h-3 bg-slate-900 rounded-full border-l border-slate-700"></div>
      </div>

      {/* Purchased Items List */}
      <div className="my-2">
        <div className="flex justify-between text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5 px-1">
          <span>Items ({transaction.items?.length || 0})</span>
          <span>Amount</span>
        </div>
        <div className="max-h-36 overflow-y-auto space-y-1.5 pr-0.5 custom-scrollbar">
          {transaction.items && transaction.items.length > 0 ? (
            transaction.items.map((item, idx) => (
              <div key={idx} className="flex justify-between items-start bg-slate-800/40 p-1.5 rounded-lg border border-slate-800">
                <div className="flex-1 pr-2">
                  <p className="font-medium text-slate-200 text-[11px] line-clamp-1">{item.product_name}</p>
                  <p className="text-[10px] text-slate-400">
                    {item.quantity} × KES {item.unit_price.toLocaleString()}
                  </p>
                </div>
                <span className="font-mono text-emerald-400 font-medium text-[11px]">
                  KES {item.subtotal.toLocaleString()}
                </span>
              </div>
            ))
          ) : (
            <p className="text-center text-slate-500 py-2 text-[11px]">No line items recorded</p>
          )}
        </div>
      </div>

      {/* Dashed Separator */}
      <div className="relative my-2 border-b border-dashed border-slate-700">
        <div className="absolute -left-5 -top-1.5 w-3 h-3 bg-slate-900 rounded-full border-r border-slate-700"></div>
        <div className="absolute -right-5 -top-1.5 w-3 h-3 bg-slate-900 rounded-full border-l border-slate-700"></div>
      </div>

      {/* Payment & Financial Summary */}
      <div className="space-y-1.5 bg-slate-800/80 p-2.5 rounded-xl border border-slate-700">
        <div className="flex justify-between items-center text-xs font-bold text-white">
          <span>TOTAL AMOUNT</span>
          <span className="text-emerald-400 font-mono text-sm">
            KES {transaction.total_amount.toLocaleString()}
          </span>
        </div>
        <div className="flex justify-between items-center text-[11px] text-slate-400">
          <span>Amount Paid:</span>
          <span className="text-slate-200 font-mono">KES {transaction.amount_paid.toLocaleString()}</span>
        </div>
        {transaction.change_amount > 0 && (
          <div className="flex justify-between items-center text-[11px] text-slate-400">
            <span>Change Returned:</span>
            <span className="text-amber-400 font-mono">KES {transaction.change_amount.toLocaleString()}</span>
          </div>
        )}
        <div className="pt-1.5 space-y-1 border-t border-slate-700/50">
          <div className="flex justify-between items-center">
            <span className="text-[11px] text-slate-400 flex items-center gap-1">
              <CreditCard size={12} className="text-slate-400" /> Payment Method:
            </span>
            <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${getPaymentBadgeColor(transaction.payment_method)} uppercase`}>
              {transaction.payment_method}
            </span>
          </div>
          {accountDetails.paybill && (
            <div className="flex justify-between items-center text-[11px] text-slate-400">
              <span>Paybill No.:</span>
              <span className="text-slate-200 font-mono font-medium">{accountDetails.paybill}</span>
            </div>
          )}
          {accountDetails.accountNumber && (
            <div className="flex justify-between items-center text-[11px] text-slate-400">
              <span>A/C No.:</span>
              <span className="text-slate-200 font-mono font-medium">{accountDetails.accountNumber}</span>
            </div>
          )}
        </div>
      </div>

      {/* Footer message */}
      <div className="mt-2 text-center text-[10px] text-slate-500 font-mono">
        ★ Thank you for shopping with us! ★
      </div>
    </div>
  );
}
