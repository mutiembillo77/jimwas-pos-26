import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Supabase URL or Key missing in environment.');
  process.exit(1);
}

const supabase = createClient(url, key);

async function main() {
  console.log('=== CHECKING SUPABASE TABLES ===');
  
  // 1. Transactions columns sample
  const { data: txSample, error: txErr } = await supabase.from('transactions').select('*').limit(3);
  if (txErr) console.error('Transactions query error:', txErr.message);
  else console.log('Transactions columns present:', Object.keys(txSample?.[0] || {}));

  // 2. Check payment table
  const { data: payData, error: payErr } = await supabase.from('payment').select('*').limit(1);
  if (payErr) console.log('Payment table check error (expected if table does not exist in db):', payErr.message);
  else console.log('Payment table exists. Columns:', Object.keys(payData?.[0] || {}));

  // 3. Check payments table
  const { data: paysData, error: paysErr } = await supabase.from('payments').select('*').limit(1);
  if (paysErr) console.log('Payments table check error:', paysErr.message);
  else console.log('Payments table exists. Columns:', Object.keys(paysData?.[0] || {}));

  // 4. Distinct payment_methods in transactions
  const { data: txs, error: txsErr } = await supabase.from('transactions').select('payment_method');
  if (txsErr) console.error('Error querying payment_method:', txsErr.message);
  else {
    const counts = (txs || []).reduce((acc, row) => {
      acc[row.payment_method] = (acc[row.payment_method] || 0) + 1;
      return acc;
    }, {});
    console.log('Distinct payment_method counts in DB:', counts);
  }
}

main().catch(console.error);
