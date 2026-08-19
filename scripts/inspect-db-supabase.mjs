import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let value = match[2] || '';
    value = value.trim().replace(/^['"](.*)['"]$/, '$1');
    env[match[1]] = value;
  }
});

const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY;

console.log('Supabase URL:', url);
const supabase = createClient(url, key);

async function main() {
  console.log('=== 1. CHECKING TABLE EXISTENCE & ROW COUNTS ===');
  const tables = [
    'transactions', 'transaction_items', 'products', 'customers',
    'stock_movements', 'audit_logs', 'roles', 'permissions', 'users', 
    'payment_accounts', 'installment_payments', 'installment_plans',
    'payment', 'payments', 'kcb_payments', 'cod_payments', 'cod_receipts',
    'approval_requests', 'approval_history', 'deliveries', 'delivery_items'
  ];

  for (const t of tables) {
    try {
      const { data, count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
      if (error) {
        console.log(`Table [${t}]: NOT FOUND / ERROR (${error.message} - code: ${error.code})`);
      } else {
        console.log(`Table [${t}]: EXISTS, row count = ${count}`);
      }
    } catch (e) {
      console.log(`Table [${t}]: EXCEPTION (${e.message})`);
    }
  }

  console.log('\n=== 2. VERIFYING INDIVIDUAL COLUMNS ON transactions TABLE ===');
  const txColumnsToTest = [
    'id', 'receipt_number', 'user_id', 'customer_id', 'total_amount',
    'payment_method', 'payment_status', 'created_at', 'updated_at',
    'sync_status', 'local_id', 'payment_timing', 'is_cod', 'cod_status', 'mpesa_receipt'
  ];

  for (const col of txColumnsToTest) {
    const { error } = await supabase.from('transactions').select(col).limit(1);
    if (error) {
      console.log(`transactions.${col}: MISSING (${error.message})`);
    } else {
      console.log(`transactions.${col}: EXISTS`);
    }
  }

  console.log('\n=== 3. CHECKING payment TABLE SPECIFICALLY ===');
  const { error: payErr } = await supabase.from('payment').select('*').limit(1);
  if (payErr) {
    console.log(`payment table query: ERROR (${payErr.message})`);
  } else {
    console.log('payment table EXISTS');
  }

  console.log('\n=== 4. CHECKING payment_accounts TABLE COLUMNS ===');
  const payAccCols = ['id', 'name', 'account_type', 'is_active', 'balance', 'created_at'];
  for (const col of payAccCols) {
    const { error } = await supabase.from('payment_accounts').select(col).limit(1);
    if (error) {
      console.log(`payment_accounts.${col}: MISSING (${error.message})`);
    } else {
      console.log(`payment_accounts.${col}: EXISTS`);
    }
  }
}

main().catch(console.error);
