import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    const txCount = await prisma.transactions.count();
    const payCount = await prisma.payment.count();
    const ledgerCount = await prisma.ledger_entries.count();
    console.log(`Transactions: ${txCount}`);
    console.log(`Payments: ${payCount}`);
    console.log(`Ledger Entries: ${ledgerCount}`);
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
