import postgres from 'postgres';
import url from 'url';

const directUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!directUrl) {
  console.error('No DIRECT_URL or DATABASE_URL found.');
  process.exit(1);
}

// Parse connection URL safely (masking credentials)
const parsedUrl = new URL(directUrl);
const connectionInfo = {
  provider: 'PostgreSQL / Supabase',
  host: parsedUrl.hostname,
  port: parsedUrl.port || '5432',
  database: parsedUrl.pathname.replace(/^\//, ''),
  ssl: parsedUrl.searchParams.get('sslmode') || 'require',
  isPooler: parsedUrl.port === '6543' || parsedUrl.hostname.includes('pooler'),
  isDirect: parsedUrl.port === '5432' && !parsedUrl.hostname.includes('pooler'),
};

console.log('=== 1. CONNECTION DETAILS ===');
console.log(JSON.stringify(connectionInfo, null, 2));

const sql = postgres(directUrl, { ssl: 'require', max: 1 });

async function inspect() {
  // 2. All tables in public schema
  console.log('\n=== 2. PUBLIC TABLES AND VIEWS ===');
  const tables = await sql`
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_type, table_name;
  `;
  console.log(JSON.stringify(tables, null, 2));

  // 3. Transactions table columns
  console.log('\n=== 3. TRANSACTIONS TABLE COLUMNS ===');
  const txColumns = await sql`
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions'
    ORDER BY ordinal_position;
  `;
  console.log(JSON.stringify(txColumns, null, 2));

  // 4. Installment payments & other payment tables columns
  console.log('\n=== 4. PAYMENT-RELATED TABLES COLUMNS ===');
  const payRelatedColumns = await sql`
    SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('payment', 'payments', 'installment_payments', 'payment_accounts')
    ORDER BY table_name, ordinal_position;
  `;
  console.log(JSON.stringify(payRelatedColumns, null, 2));

  // 5. Enums
  console.log('\n=== 5. ENUMS AND CUSTOM TYPES ===');
  const enums = await sql`
    SELECT t.typname as enum_name, e.enumlabel as enum_value, e.enumsortorder
    FROM pg_type t 
    JOIN pg_enum e ON t.oid = e.enumtypid  
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.typname, e.enumsortorder;
  `;
  console.log(JSON.stringify(enums, null, 2));

  // 6. Constraints (PK, FK, Unique, Check)
  console.log('\n=== 6. CONSTRAINTS ON PAYMENT & TRANSACTION TABLES ===');
  const constraints = await sql`
    SELECT 
      tc.table_name, 
      tc.constraint_name, 
      tc.constraint_type,
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      rc.update_rule,
      rc.delete_rule
    FROM information_schema.table_constraints AS tc 
    LEFT JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    LEFT JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    LEFT JOIN information_schema.referential_constraints AS rc
      ON tc.constraint_name = rc.constraint_name
    WHERE tc.table_schema = 'public'
      AND tc.table_name IN ('transactions', 'transaction_items', 'installment_payments', 'installment_plans', 'payment', 'payments')
    ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name;
  `;
  console.log(JSON.stringify(constraints, null, 2));

  // 7. Indexes
  console.log('\n=== 7. INDEXES ON PAYMENT & TRANSACTION TABLES ===');
  const indexes = await sql`
    SELECT 
      tablename, 
      indexname, 
      indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' 
      AND tablename IN ('transactions', 'transaction_items', 'installment_payments', 'installment_plans', 'payment', 'payments')
    ORDER BY tablename, indexname;
  `;
  console.log(JSON.stringify(indexes, null, 2));

  // 8. RLS and Policies
  console.log('\n=== 8. RLS AND POLICIES ===');
  const rlsStatus = await sql`
    SELECT 
      c.relname as table_name,
      c.relrowsecurity as rls_enabled,
      c.relforcerowsecurity as rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    ORDER BY c.relname;
  `;
  console.log(JSON.stringify(rlsStatus, null, 2));

  const policies = await sql`
    SELECT 
      schemaname,
      tablename,
      policyname,
      permissive,
      roles,
      cmd,
      qual,
      with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname;
  `;
  console.log(JSON.stringify(policies, null, 2));

  // 9. Triggers
  console.log('\n=== 9. TRIGGERS ===');
  const triggers = await sql`
    SELECT 
      event_object_table as table_name,
      trigger_name,
      event_manipulation as event,
      action_timing as timing,
      action_statement as statement
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
    ORDER BY event_object_table, trigger_name;
  `;
  console.log(JSON.stringify(triggers, null, 2));

  // 10. Table Row Counts
  console.log('\n=== 10. TABLE ROW COUNTS ===');
  const tableNames = tables.filter(t => t.table_type === 'BASE TABLE').map(t => t.table_name);
  const rowCounts = {};
  for (const name of tableNames) {
    try {
      const res = await sql`SELECT count(*)::int as count FROM ${sql(name)}`;
      rowCounts[name] = res[0].count;
    } catch (e) {
      rowCounts[name] = `Error: ${e.message}`;
    }
  }
  console.log(JSON.stringify(rowCounts, null, 2));
}

inspect()
  .catch(err => console.error('Inspection query error:', err))
  .finally(async () => {
    await sql.end();
  });
