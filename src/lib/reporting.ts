import { getAllCustomers, getAllProducts, getAllTransactions, getAllUsers } from './db';
import { getDB } from './db';
import type { Customer, OutboundDelivery, Product, Transaction } from './types';
import type { User } from './security-types';

export type ReportKind = 'sales' | 'financial' | 'inventory' | 'delivery' | 'customer' | 'user';

export interface ReportData {
  transactions: Transaction[];
  customers: Customer[];
  products: Product[];
  deliveries: OutboundDelivery[];
  users: User[];
}

export async function loadReportData(): Promise<ReportData> {
  const db = await getDB();
  const [transactions, customers, products, deliveries, users] = await Promise.all([
    getAllTransactions(),
    getAllCustomers(),
    getAllProducts(),
    db.getAll('outbound_deliveries') as Promise<OutboundDelivery[]>,
    getAllUsers(),
  ]);
  return { transactions, customers, products, deliveries, users };
}

export function inRange(date: string, from: string, to: string) {
  const value = new Date(date).getTime();
  return value >= new Date(`${from}T00:00:00`).getTime() && value <= new Date(`${to}T23:59:59`).getTime();
}

export function currency(value: number) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(value);
}

export function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
