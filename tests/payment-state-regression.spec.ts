import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentRepository } from '../src/payments/repositories/PaymentRepository';
import { formatPhoneNumber } from '../src/payments/providers/KCBBuniProvider';
import type { PrismaClient } from '@prisma/client';

// ============================================================
// SECTION 1: TERMINAL STATE REGRESSION
// PaymentRepository.updateFromCallback() — SUCCESS → FAILED
// ============================================================

describe('PaymentRepository — Terminal State Regression', () => {
  let mockPrisma: { payment: any };

  beforeEach(() => {
    mockPrisma = {
      payment: {
        create: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
    };
  });

  // -------------------------------------------------------
  // TEST 1.1 — REGRESSION DEMONSTRATION
  // A delayed FAILED callback arrives after payment is SUCCESS.
  // Expected secure behavior: status must remain SUCCESS.
  // CURRENT behavior: status is unconditionally overwritten to FAILED.
  // -------------------------------------------------------
  it('1.1 GUARD: updateFromCallback blocks SUCCESS → FAILED transition (terminal-state guard)', async () => {
    const successRecord = {
      id: 'pay-uuid-success-001',
      merchantRequestId: 'TEST-MRQ-REGRESSION',
      status: 'SUCCESS',
    };

    // Existing payment is already SUCCESS
    mockPrisma.payment.findFirst.mockResolvedValue(successRecord);

    const repo = new PaymentRepository(mockPrisma as unknown as PrismaClient);

    // Delayed FAILED callback arrives with same merchantRequestId
    const result = await repo.updateFromCallback('TEST-MRQ-REGRESSION', {
      status: 'FAILED',
      resultDesc: 'Late failure callback',
    });

    // SECURE BEHAVIOR: terminal-state guard short-circuits — update() never called
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();

    // Payment status remains SUCCESS — regression prevented
    expect(result?.status).toBe('SUCCESS');
  });

  // -------------------------------------------------------
  // TEST 1.2 — IDEMPOTENT REPLAY: SUCCESS → SUCCESS (harmless)
  // -------------------------------------------------------
  it('1.2 GUARD: SUCCESS → SUCCESS replay is blocked by terminal guard (update() not called)', async () => {
    const successRecord = {
      id: 'pay-uuid-success-002',
      merchantRequestId: 'TEST-MRQ-REPLAY',
      status: 'SUCCESS',
    };

    mockPrisma.payment.findFirst.mockResolvedValue(successRecord);

    const repo = new PaymentRepository(mockPrisma as unknown as PrismaClient);

    const result = await repo.updateFromCallback('TEST-MRQ-REPLAY', {
      status: 'SUCCESS',
      resultDesc: 'Duplicate success callback',
    });

    // Guard short-circuits — update() is never called even for a harmless SUCCESS replay
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    // Existing SUCCESS record is returned as-is
    expect(result?.status).toBe('SUCCESS');
  });

  // -------------------------------------------------------
  // TEST 1.3 — CANCELLED → FAILED transition (regression)
  // -------------------------------------------------------
  it('1.3 GUARD: updateFromCallback blocks CANCELLED → FAILED transition', async () => {
    const cancelledRecord = {
      id: 'pay-uuid-cancelled-001',
      merchantRequestId: 'TEST-MRQ-CANCELLED',
      status: 'CANCELLED',
    };

    mockPrisma.payment.findFirst.mockResolvedValue(cancelledRecord);

    const repo = new PaymentRepository(mockPrisma as unknown as PrismaClient);

    const result = await repo.updateFromCallback('TEST-MRQ-CANCELLED', { status: 'FAILED' });

    // Guard short-circuits — update() never called
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    // Status remains CANCELLED — regression prevented
    expect(result?.status).toBe('CANCELLED');
  });

  // -------------------------------------------------------
  // TEST 1.6 — SUCCESS → PENDING blocked
  // A PENDING status update (e.g., re-queued job) must not degrade a SUCCESS.
  // -------------------------------------------------------
  it('1.6 GUARD: updateFromCallback blocks SUCCESS → PENDING transition', async () => {
    const successRecord = {
      id: 'pay-uuid-success-003',
      merchantRequestId: 'TEST-MRQ-PENDING-ATTEMPT',
      status: 'SUCCESS',
    };

    mockPrisma.payment.findFirst.mockResolvedValue(successRecord);

    const repo = new PaymentRepository(mockPrisma as unknown as PrismaClient);

    const result = await repo.updateFromCallback('TEST-MRQ-PENDING-ATTEMPT', {
      status: 'PENDING',
    });

    // Guard short-circuits for any SUCCESS record
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    expect(result?.status).toBe('SUCCESS');
  });

  // -------------------------------------------------------
  // TEST 1.4 — Unknown merchantRequestId returns null (pre-existing guard — correct)
  // -------------------------------------------------------
  it('1.4 updateFromCallback returns null for unknown merchantRequestId', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(null);

    const repo = new PaymentRepository(mockPrisma as unknown as PrismaClient);

    const result = await repo.updateFromCallback('UNKNOWN-MRQ', { status: 'FAILED' });

    expect(result).toBeNull();
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------
  // TEST 1.5 — Empty merchantRequestId returns null (pre-existing guard — correct)
  // -------------------------------------------------------
  it('1.5 updateFromCallback returns null for empty merchantRequestId', async () => {
    const repo = new PaymentRepository(mockPrisma as unknown as PrismaClient);

    const result = await repo.updateFromCallback('', { status: 'FAILED' });

    expect(result).toBeNull();
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------
  // TEST 1.7 — PENDING → FAILED allowed (non-terminal transition)
  // Only SUCCESS and CANCELLED are terminal; PENDING/FAILED can still be updated.
  // -------------------------------------------------------
  it('1.7 updateFromCallback ALLOWS PENDING → FAILED (non-terminal state)', async () => {
    const pendingRecord = {
      id: 'pay-uuid-pending-001',
      merchantRequestId: 'TEST-MRQ-PENDING',
      status: 'PENDING',
    };

    mockPrisma.payment.findFirst.mockResolvedValue(pendingRecord);
    mockPrisma.payment.update.mockResolvedValue({ ...pendingRecord, status: 'FAILED' });

    const repo = new PaymentRepository(mockPrisma as unknown as PrismaClient);

    const result = await repo.updateFromCallback('TEST-MRQ-PENDING', { status: 'FAILED' });

    // PENDING is not terminal — update() must fire
    expect(mockPrisma.payment.update).toHaveBeenCalledTimes(1);
    expect(result?.status).toBe('FAILED');
  });

  // -------------------------------------------------------
  // TEST 1.8 — PENDING → SUCCESS allowed (normal completion path)
  // -------------------------------------------------------
  it('1.8 updateFromCallback ALLOWS PENDING → SUCCESS (normal completion)', async () => {
    const pendingRecord = {
      id: 'pay-uuid-pending-002',
      merchantRequestId: 'TEST-MRQ-COMPLETING',
      status: 'PENDING',
    };

    mockPrisma.payment.findFirst.mockResolvedValue(pendingRecord);
    mockPrisma.payment.update.mockResolvedValue({ ...pendingRecord, status: 'SUCCESS' });

    const repo = new PaymentRepository(mockPrisma as unknown as PrismaClient);

    const result = await repo.updateFromCallback('TEST-MRQ-COMPLETING', { status: 'SUCCESS' });

    // Normal completion path — update() must fire
    expect(mockPrisma.payment.update).toHaveBeenCalledTimes(1);
    expect(result?.status).toBe('SUCCESS');
  });
});

// ============================================================
// SECTION 2: DUPLICATE INVOICE CREATION
// createFromInitiation() with same invoiceNumber twice.
// ============================================================

describe('PaymentRepository — Duplicate Invoice Creation', () => {
  it('2.1 createFromInitiation() creates two rows for the same invoiceNumber (no DB-level unique constraint)', async () => {
    let callCount = 0;
    const mockPrisma = {
      payment: {
        create: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve({
            id: `pay-uuid-dup-${callCount}`,
            invoiceNumber: 'INV-DUP-001',
            status: 'PENDING',
          });
        }),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
    };

    const repo = new PaymentRepository(mockPrisma as unknown as PrismaClient);

    // First call
    const result1 = await repo.createFromInitiation({
      provider: 'kcb_buni',
      invoiceNumber: 'INV-DUP-001',
      amount: 500,
    });

    // Second call with identical invoiceNumber (e.g., UI double-click / retry)
    const result2 = await repo.createFromInitiation({
      provider: 'kcb_buni',
      invoiceNumber: 'INV-DUP-001',
      amount: 500,
    });

    // Both calls succeed — two separate rows created (duplicate confirmed)
    expect(mockPrisma.payment.create).toHaveBeenCalledTimes(2);
    expect(result1.id).not.toBe(result2.id);
    expect(result1.invoiceNumber).toBe('INV-DUP-001');
    expect(result2.invoiceNumber).toBe('INV-DUP-001');
  });
});

// ============================================================
// SECTION 3: formatPhoneNumber — edge cases
// ============================================================

describe('formatPhoneNumber — edge cases', () => {
  it('5.1 normalizes local 07xx number (10 digits) to 254 format', () => {
    expect(formatPhoneNumber('0712345678')).toBe('254712345678');
  });

  it('5.2 normalizes 9-digit number (no leading 0) to 254 format', () => {
    expect(formatPhoneNumber('712345678')).toBe('254712345678');
  });

  it('5.3 passes through already-normalized 254 format (12 digits) unchanged', () => {
    expect(formatPhoneNumber('254712345678')).toBe('254712345678');
  });

  it('5.4 empty string returns empty string', () => {
    expect(formatPhoneNumber('')).toBe('');
  });

  it('5.5 strips non-digit characters before normalizing', () => {
    expect(formatPhoneNumber('+254-712-345-678')).toBe('254712345678');
  });

  it('5.6 malformed 11-digit local number falls through without normalization (documented gap)', () => {
    // cleaned = '07123456789' (11 digits)
    // Does NOT match any normalization branch → returned as-is (not normalized)
    const result = formatPhoneNumber('07123456789');
    expect(result).toBe('07123456789');
    // Confirms the gap: 11-digit inputs are not normalized to 254 prefix
    expect(result).not.toMatch(/^254/);
  });

  it('5.7 01xx prefix (non-Safaricom) local 10-digit number is normalized', () => {
    expect(formatPhoneNumber('0112345678')).toBe('254112345678');
  });
});
