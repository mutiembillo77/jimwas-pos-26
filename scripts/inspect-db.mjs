import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== 1. ENUMS IN DATABASE ===');
  const enums = await prisma.$queryRawUnsafe(`
    SELECT t.typname as enum_name, e.enumlabel as enum_value
    FROM pg_type t 
    JOIN pg_enum e ON t.oid = e.enumtypid  
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.typname, e.enumsortorder;
  `);
  console.log(JSON.stringify(enums, null, 2));

  console.log('\n=== 2. TRANSACTIONS TABLE COLUMNS ===');
  const columns = await prisma.$queryRawUnsafe(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions'
    ORDER BY ordinal_position;
  `);
  console.log(JSON.stringify(columns, null, 2));

  console.log('\n=== 3. PAYMENT RELATED TABLES ===');
  const paymentTables = await prisma.$queryRawUnsafe(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND (table_name LIKE '%payment%' OR table_name LIKE '%pay%');
  `);
  console.log(JSON.stringify(paymentTables, null, 2));

  console.log('\n=== 4. PAYMENT TABLE COLUMNS (IF EXISTS) ===');
  const payColumns = await prisma.$queryRawUnsafe(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('payment', 'payments')
    ORDER BY table_name, ordinal_position;
  `);
  console.log(JSON.stringify(payColumns, null, 2));

  console.log('\n=== 5. HISTORICAL PAYMENT METHODS IN TRANSACTIONS ===');
  const distinctMethods = await prisma.$queryRawUnsafe(`
    SELECT payment_method, count(*) as count 
    FROM transactions 
    GROUP BY payment_method;
  `);
  console.log(JSON.stringify(distinctMethods, null, 2));
}

main()
  .catch(err => {
    console.error('Error inspecting database:', err);
  })
  .finally(() => prisma.$disconnect());
