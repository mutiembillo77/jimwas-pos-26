import { PrismaClient } from '@prisma/client';
import { PaymentMethod, PaymentStatus } from '../../types/payment';

export type { PaymentStatus };

export class PaymentRepository {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async createFromInitiation(args: {
    provider: PaymentMethod | string;
    merchantRequestId?: string;
    checkoutRequestId?: string;
    providerTransactionId?: string;
    phoneNumber?: string;
    amount: number | string;
    invoiceNumber: string;
    status?: PaymentStatus;
    raw?: any;
  }) {
    return this.prisma.payment.create({
      data: {
        provider: args.provider,
        providerTransactionId: args.providerTransactionId,
        merchantRequestId: args.merchantRequestId,
        checkoutRequestId: args.checkoutRequestId,
        phoneNumber: args.phoneNumber || '',
        amount: Number(args.amount),
        invoiceNumber: args.invoiceNumber,
        status: args.status ?? 'PENDING',
        callbackPayload: args.raw ?? null,
      },
    });
  }

  async findByMerchantRequestId(merchantRequestId: string) {
    if (!merchantRequestId) return null;
    return this.prisma.payment.findFirst({ where: { merchantRequestId } });
  }

  async updateFromCallback(merchantRequestId: string, updates: Partial<Record<string, any>>) {
    const existing = await this.findByMerchantRequestId(merchantRequestId);
    if (!existing) return null;
    // Terminal-state guard: do not regress a completed or cancelled payment.
    // A delayed / duplicate callback must not overwrite a SUCCESS or CANCELLED record.
    if (['SUCCESS', 'CANCELLED'].includes(existing.status)) return existing;
    return this.prisma.payment.update({ where: { id: existing.id }, data: updates });
  }

  async findByInvoice(invoiceNumber: string) {
    return this.prisma.payment.findFirst({ where: { invoiceNumber } });
  }
}
