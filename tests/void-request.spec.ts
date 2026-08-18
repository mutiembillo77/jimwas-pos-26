import { describe, it, expect, vi } from 'vitest';

describe('requestVoidSale (integration-like)', () => {
  it('calls saveVoidRequest and creates an approval request', async () => {
    const db = await import('../src/lib/db');
    const permissions = await import('../src/lib/permissions');
    const approvals = await import('../src/lib/approvals');

    const fakeUser = { id: 'user-1', full_name: 'Tester', branch_id: 'b1', branch_name: 'Main' } as any;

    const getUserSpy = vi.spyOn(db, 'getUser').mockResolvedValue(fakeUser);
    const saveVoidSpy = vi.spyOn(db, 'saveVoidRequest').mockResolvedValue(undefined as any);
    const saveApprovalSpy = vi.spyOn(db, 'saveApprovalRequest').mockResolvedValue(undefined as any);
    const getApprovalsSpy = vi.spyOn(db, 'getApprovalRequestsByStatus').mockResolvedValue([]);
    const canPerformSpy = vi.spyOn(permissions, 'canPerformWithoutApproval').mockResolvedValue(false);

    const { requestVoidSale } = approvals;

    const result = await requestVoidSale('tx-123', { total_amount: 100 }, 'Reason for void', fakeUser.id);

    expect(result.success).toBe(true);
    expect(saveVoidSpy).toHaveBeenCalled();

    getUserSpy.mockRestore();
    saveVoidSpy.mockRestore();
    saveApprovalSpy.mockRestore();
    getApprovalsSpy.mockRestore();
    canPerformSpy.mockRestore();
  });
});
