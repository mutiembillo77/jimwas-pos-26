import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

// Force-load .env.vercel.production explicitly (overrides already-loaded vars)
dotenv.config({ path: path.resolve(process.cwd(), '.env.vercel.production'), override: true });

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing supabase credentials. SUPABASE_URL:", supabaseUrl ? "[set]" : "[missing]", "SUPABASE_SERVICE_ROLE_KEY:", supabaseKey ? "[set]" : "[missing]");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function countTable(table: string) {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (error) {
    console.error(`Error querying ${table}:`, error.message);
    return 'Error';
  }
  return count;
}

async function main() {
  const tables = [
    'transactions',
    'transaction_items',
    'payment',
    'kcb_payments',
    'reconciliations',
    'ledger_entries',
    'stock_movements',
    'shifts',
    'refund_requests',
    'void_requests',
    'installment_plans',
    'installment_payments',
    'expenses'
  ];

  for (const table of tables) {
    const count = await countTable(table);
    console.log(`${table}: ${count}`);
  }
}

main();
