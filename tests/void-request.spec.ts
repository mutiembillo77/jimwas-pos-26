import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the entire db module so no real IndexedDB calls are made.
// Every function that any transitive import (approvals → audit → db) uses must be stubbed.
vi.mock('../src/lib/db', () => ({
  generateId: vi.fn(() => 'mock-id-' + Math.random().toString(36).slice(2)),
  getUser: vi.fn(),
  saveVoidRequest: vi.fn().mockResolvedValue(undefined),
  saveApprovalRequest: vi.fn().mockResolvedValue(undefined),
  saveApprovalHistory: vi.fn().mockResolvedValue(undefined),
  getApprovalRequest: vi.fn().mockResolvedValue(null),
  getApprovalRequestsByStatus: vi.fn().mockResolvedValue([]),
  getApprovalRequestsByRequester: vi.fn().mockResolvedValue([]),
  getAllApprovalRequests: vi.fn().mockResolvedValue([]),
  saveRefundRequest: vi.fn().mockResolvedValue(undefined),
  getRefundRequest: vi.fn().mockResolvedValue(null),
  getVoidRequest: vi.fn().mockResolvedValue(null),
  getVoidRequestsByStatus: vi.fn().mockResolvedValue([]),
  getRefundRequestsByStatus: vi.fn().mockResolvedValue([]),
  getTransaction: vi.fn().mockResolvedValue(null),
  getAllProducts: vi.fn().mockResolvedValue([]),
  saveProduct: vi.fn().mockResolvedValue(undefined),
  saveTransaction: vi.fn().mockResolvedValue(undefined),
  // Audit-related db functions (used by src/lib/audit.ts)
  saveAuditLog: vi.fn().mockResolvedValue(undefined),
  getAllAuditLogs: vi.fn().mockResolvedValue([]),
  getAuditLogsByUser: vi.fn().mockResolvedValue([]),
  getAuditLogsByEntity: vi.fn().mockResolvedValue([]),
  getAuditLogsByEventType: vi.fn().mockResolvedValue([]),
}));

// Mock auth so getCurrentUser doesn't need Supabase
vi.mock('../src/lib/auth', () => ({
  getCurrentUser: vi.fn().mockResolvedValue(null),
}));

// Mock permissions
vi.mock('../src/lib/permissions', () => ({
  canPerformWithoutApproval: vi.fn().mockResolvedValue(false),
  getUserPermissions: vi.fn().mockResolvedValue(new Set()),
}));

describe('requestVoidSale (integration-like)', () => {
  const fakeUser = {
    id: 'user-1',
    full_name: 'Tester',
    branch_id: 'b1',
    branch_name: 'Main',
    role_code: 'cashier',
    username: 'tester',
    email: 'tester@jimwas.com',
    is_active: true,
    failed_login_attempts: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sync_status: 'synced' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls saveVoidRequest and creates an approval request', async () => {
    const db = await import('../src/lib/db');
    const permissions = await import('../src/lib/permissions');
    const approvals = await import('../src/lib/approvals');

    (db.getUser as ReturnType<typeof vi.fn>).mockResolvedValue(fakeUser);
    (permissions.canPerformWithoutApproval as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const result = await approvals.requestVoidSale(
      'tx-123',
      { total_amount: 100 } as any,
      'Reason for void',
      fakeUser.id
    );

    expect(result.success).toBe(true);
    expect(db.saveVoidRequest).toHaveBeenCalled();
    expect(db.saveApprovalRequest).toHaveBeenCalled();
    expect(db.saveApprovalHistory).toHaveBeenCalled();
  });
});
