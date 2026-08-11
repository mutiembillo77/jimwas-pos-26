import { getDB, generateId, getTransaction, saveTransaction, saveCODPayment, saveCODReceipt, getCODPaymentsByTransaction } from './db';
import { queueForSync } from './sync';
import type { OutboundDelivery, ReconciliationRecord, ReportFilters, ShiftRecord, OfferRule, SupplierFulfillment, Transaction, ReportSchedule, SafeDropRecord, CODPayment, CODReceipt } from './types';
import { logAuditEvent } from './audit';

export async function saveEnterpriseRecord<T extends { id: string }>(store: string, table: string, record: T) {
  const db = await getDB();
  await db.put(store as never, record as never);
  queueForSync(table, 'update', record);
  return record;
}

export async function listEnterpriseRecords<T>(store: string): Promise<T[]> {
  const db = await getDB();
  return (await db.getAll(store as never)) as T[];
}

export async function openShift(input: Pick<ShiftRecord, 'cashier_id' | 'opening_float' | 'branch_id' | 'terminal_id'>): Promise<ShiftRecord> {
  const now = new Date().toISOString();
  const shift: ShiftRecord = { id: generateId(), ...input, opened_at: now, opening_float: Number(input.opening_float) || 0, cash_sales: 0, card_sales: 0, mobile_money_sales: 0, bank_sales: 0, credit_sales: 0, refunds: 0, discounts: 0, tax: 0, gross_sales: 0, net_sales: 0, status: 'open', sync_status: 'pending' };
  return saveEnterpriseRecord('shifts', 'shifts', shift);
}

export async function closeShift(shift: ShiftRecord, cashCount: number, actorId?: string) {
  if (shift.status !== 'open') throw new Error('This shift is already locked.');
  const expected = shift.opening_float + shift.cash_sales - shift.refunds;
  const closed: ShiftRecord = { ...shift, cash_count: cashCount, variance: cashCount - expected, closed_at: new Date().toISOString(), status: 'closed', y_report_at: new Date().toISOString(), z_report_at: new Date().toISOString(), sync_status: 'pending' };
  await saveEnterpriseRecord('shifts', 'shifts', closed);
  await logAuditEvent({ eventType: 'APPROVAL_REQUESTED', entityType: 'shift_close', entityId: shift.id, oldValue: shift, newValue: closed, reason: `Z report generated; variance ${closed.variance}`, userId: actorId });
  return closed;
}

export async function recordSafeDrop(input: Omit<SafeDropRecord, 'id' | 'created_at' | 'sync_status'>) {
  const record: SafeDropRecord = { ...input, id: generateId(), created_at: new Date().toISOString(), sync_status: 'pending' };
  return saveEnterpriseRecord('safe_drops', 'safe_drops', record);
}

export async function markShiftReport(shift: ShiftRecord, kind: 'x' | 'y') {
  const updated = { ...shift, [`${kind}_report_at`]: new Date().toISOString(), sync_status: 'pending' } as ShiftRecord;
  return saveEnterpriseRecord('shifts', 'shifts', updated);
}

export async function matchReconciliation(record: ReconciliationRecord, receivedAmount: number, actorId?: string) {
  const status = receivedAmount === record.expected_amount ? 'matched' : receivedAmount > record.expected_amount ? 'partial' : 'exception';
  const updated = { ...record, received_amount: receivedAmount, status, matched_at: status === 'matched' ? new Date().toISOString() : undefined, sync_status: 'pending' as const };
  await saveEnterpriseRecord('reconciliations', 'reconciliations', updated);
  await logAuditEvent({ eventType: 'SALE_UPDATED', entityType: 'reconciliation', entityId: record.id, oldValue: record, newValue: updated, userId: actorId });
  return updated;
}

const DELIVERY_FLOW: Record<OutboundDelivery['status'], OutboundDelivery['status'][]> = {
  pending: ['packed', 'assigned', 'cancelled'], packed: ['assigned', 'cancelled'], assigned: ['dispatched', 'cancelled'], dispatched: ['in_transit', 'failed', 'cancelled'], in_transit: ['delivered', 'failed', 'returned'], delivered: ['closed', 'returned'], closed: [], returned: [], failed: ['assigned', 'cancelled'], cancelled: [],
};

export async function updateDeliveryStatus(delivery: OutboundDelivery, status: OutboundDelivery['status'], actorId?: string, proof?: Pick<OutboundDelivery, 'proof_type' | 'proof_reference'>) {
  if (delivery.status !== status && !DELIVERY_FLOW[delivery.status].includes(status)) throw new Error(`Cannot move delivery from ${delivery.status} to ${status}.`);
  if (status === 'delivered' && !proof?.proof_reference && !delivery.proof_reference) throw new Error('Delivery proof or reference is required before marking delivered.');
  const now = new Date().toISOString();
  const updated = { ...delivery, ...proof, status, delivered_at: status === 'delivered' ? now : delivery.delivered_at, dispatched_at: ['dispatched', 'in_transit'].includes(status) ? now : delivery.dispatched_at, updated_at: now, sync_status: 'pending' as const };
  await saveEnterpriseRecord('outbound_deliveries', 'outbound_deliveries', updated);
  await logAuditEvent({ eventType: 'SALE_UPDATED', entityType: 'outbound_delivery', entityId: delivery.id, oldValue: delivery, newValue: updated, userId: actorId });
  return updated;
}

export function calculateOfferDiscount(offer: OfferRule, subtotal: number, quantity = 1) {
  if (!offer.is_active || (offer.starts_at && Date.now() < new Date(offer.starts_at).getTime()) || (offer.ends_at && Date.now() > new Date(offer.ends_at).getTime())) return 0;
  if (offer.type === 'percentage') return Math.min(subtotal, subtotal * offer.value / 100);
  if (offer.type === 'fixed') return Math.min(subtotal, offer.value);
  if (offer.type === 'bogo') return quantity > 1 ? Math.min(subtotal, offer.value || subtotal / quantity) : 0;
  if (offer.type === 'multi_buy') return quantity >= 3 ? Math.min(subtotal, offer.value) : 0;
  return 0;
}

export async function createReportSchedule(input: Omit<ReportSchedule, 'id' | 'created_at' | 'sync_status'>) {
  return saveEnterpriseRecord('report_schedules', 'report_schedules', { ...input, id: generateId(), created_at: new Date().toISOString(), sync_status: 'pending' as const });
}

export async function calculateReport(filters: ReportFilters) {
  const db = await getDB();
  const transactions = (await db.getAll('transactions')) as Transaction[];
  const from = new Date(filters.from).getTime();
  const to = new Date(filters.to).getTime();
  const rows = transactions.filter((transaction) => {
    const created = new Date(transaction.created_at).getTime();
    return created >= from && created <= to && (!filters.payment_method || transaction.payment_method === filters.payment_method) && (!filters.customer_id || transaction.customer_id === filters.customer_id) && (!filters.sale_type || transaction.sale_type === filters.sale_type);
  });
  const gross = rows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
  const paid = rows.reduce((sum, row) => sum + Number(row.amount_paid || 0), 0);
  const paymentMix = rows.reduce<Record<string, number>>((mix, row) => { mix[row.payment_method] = (mix[row.payment_method] || 0) + Number(row.total_amount || 0); return mix; }, {});
  return { rows, count: rows.length, gross, paid, averageBasket: rows.length ? gross / rows.length : 0, paymentMix };
}

export async function createDelivery(transaction_id: string, data: Partial<OutboundDelivery> = {}) {
  if (!transaction_id) throw new Error('A linked transaction is required.');
  const fee = Math.max(0, Number(data.delivery_fee ?? 0));
  const paid = Math.max(0, Number(data.delivery_fee_paid ?? 0));
  if (paid > fee) throw new Error('Delivery fee paid cannot exceed the fee due.');
  if (data.recipient_phone && !/^[+\d][\d\s-]{7,}$/.test(data.recipient_phone)) throw new Error('Enter a valid recipient phone number.');
  const now = new Date().toISOString();
  const delivery: OutboundDelivery = { id: generateId(), transaction_id, status: 'pending', delivery_fee: fee, delivery_fee_paid: paid, delivery_fee_status: fee === 0 ? 'waived' : paid >= fee ? 'paid' : paid > 0 ? 'partial' : 'unpaid', cod_status: data.cod_amount ? 'pending' : 'not_applicable', created_at: now, updated_at: now, sync_status: 'pending', ...data };
  return saveEnterpriseRecord('outbound_deliveries', 'outbound_deliveries', delivery);
}

export async function updateDelivery(delivery: OutboundDelivery, patch: Partial<OutboundDelivery>, actorId?: string) {
  const fee = Math.max(0, Number(patch.delivery_fee ?? delivery.delivery_fee ?? 0));
  const paid = Math.max(0, Number(patch.delivery_fee_paid ?? delivery.delivery_fee_paid ?? 0));
  if (paid > fee) throw new Error('Delivery fee paid cannot exceed the fee due.');
  if (patch.recipient_phone && !/^[+\d][\d\s-]{7,}$/.test(patch.recipient_phone)) throw new Error('Enter a valid recipient phone number.');
  const updated = { ...delivery, ...patch, delivery_fee: fee, delivery_fee_paid: paid, delivery_fee_status: fee === 0 ? 'waived' : paid >= fee ? 'paid' : paid > 0 ? 'partial' : 'unpaid', updated_at: new Date().toISOString(), sync_status: 'pending' as const };
  await saveEnterpriseRecord('outbound_deliveries', 'outbound_deliveries', updated);
  await logAuditEvent({ eventType: 'SALE_UPDATED', entityType: 'outbound_delivery', entityId: delivery.id, oldValue: delivery, newValue: updated, userId: actorId });
  return updated;
}

export async function collectCODPayment(input: { transactionId: string; amountReceived: number; paymentMethod: string; paymentAccountId?: string | null; paymentAccountName?: string | null; reference?: string; notes?: string; deviceId?: string }) {
  const transaction = await getTransaction(input.transactionId);
  if (!transaction || transaction.payment_method !== 'cod') throw new Error('COD transaction not found.');
  const received = Number(input.amountReceived);
  if (!Number.isFinite(received) || received <= 0) throw new Error('Enter a valid payment amount.');
  const previousPayments = await getCODPaymentsByTransaction(transaction.id);
  const previouslyPaid = previousPayments.reduce((sum, payment) => sum + payment.amount_applied, 0);
  const outstanding = Math.max(0, transaction.total_amount - previouslyPaid);
  if (outstanding <= 0) throw new Error('This COD order is already fully paid.');
  const applied = Math.min(received, outstanding);
  const paymentId = generateId();
  const now = new Date().toISOString();
  const payment: CODPayment = { id: paymentId, transaction_id: transaction.id, amount: received, amount_applied: applied, change_amount: received - applied, payment_method: input.paymentMethod, payment_account_id: input.paymentAccountId ?? null, payment_account_name: input.paymentAccountName ?? null, reference: input.reference, notes: input.notes, created_at: now, device_id: input.deviceId ?? generateId(), sync_status: 'pending' };
  await saveCODPayment(payment);
  const totalPaid = previouslyPaid + applied;
  const updated: Transaction = { ...transaction, amount_paid: totalPaid, change_amount: payment.change_amount, balance_amount: Math.max(0, transaction.total_amount - totalPaid), cod_status: totalPaid >= transaction.total_amount ? 'PAID' : 'PARTIALLY_PAID', status: totalPaid >= transaction.total_amount ? 'completed' : 'pending', sync_status: 'pending' };
  await saveTransaction(updated);
  const deliveries = await listEnterpriseRecords<OutboundDelivery>('outbound_deliveries');
  const delivery = deliveries.find((item) => item.transaction_id === transaction.id);
  if (delivery) await saveEnterpriseRecord('outbound_deliveries', 'outbound_deliveries', { ...delivery, cod_collected: totalPaid, cod_status: totalPaid >= transaction.total_amount ? 'collected' : 'pending', sync_status: 'pending', updated_at: now });
  const receipt: CODReceipt = { id: generateId(), receipt_number: `RCP-${now.slice(0, 10).replace(/-/g, '')}-${paymentId.slice(0, 8).toUpperCase()}`, transaction_id: transaction.id, payment_id: payment.id, receipt_type: 'cod_payment', amount: applied, issued_at: now, sync_status: 'pending' };
  await saveCODReceipt(receipt);
  await logAuditEvent({ eventType: 'COD_PAYMENT_COLLECTED', entityType: 'cod_payment', entityId: payment.id, oldValue: transaction, newValue: { transaction: updated, payment, receipt }, userId: input.deviceId });
  if (updated.cod_status === 'PAID') await logAuditEvent({ eventType: 'COD_SETTLED', entityType: 'transaction', entityId: transaction.id, oldValue: transaction, newValue: updated, userId: input.deviceId });
  await logAuditEvent({ eventType: 'COD_RECEIPT_GENERATED', entityType: 'cod_receipt', entityId: receipt.id, newValue: receipt, userId: input.deviceId });
  return { transaction: updated, payment, receipt };
}

export async function createReconciliation(data: Omit<ReconciliationRecord, 'id' | 'created_at' | 'sync_status'>) {
  return saveEnterpriseRecord('reconciliations', 'reconciliations', { ...data, id: generateId(), created_at: new Date().toISOString(), sync_status: 'pending' });
}

export async function saveOffer(data: Omit<OfferRule, 'id' | 'sync_status'>) {
  return saveEnterpriseRecord('offers', 'offers', { ...data, id: generateId(), sync_status: 'pending' });
}

export async function saveSupplierFulfillment(data: Omit<SupplierFulfillment, 'id' | 'created_at' | 'sync_status'>) {
  return saveEnterpriseRecord('supplier_fulfillments', 'supplier_fulfillments', { ...data, id: generateId(), created_at: new Date().toISOString(), sync_status: 'pending' });
}
