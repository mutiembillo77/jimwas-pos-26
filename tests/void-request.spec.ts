import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('requestVoidSale (integration-like)', () => {
  it('calls saveVoidRequest and creates an approval request', async () => {
    // This test is illustrative and uses simple spies. The project may require more setup for full integration.
    const db = await import('../src/lib/db');
    const approvals = await import('../src/lib/approvals');

    const fakeUser = { id: 'user-1', full_name: 'Tester', branch_id: 'b1', branch_name: 'Main' } as any;

    // Spy on DB save
    const getUserSpy = vi.spyOn(db, 'getUser').mockResolvedValue(fakeUser as any);
    const saveVoidSpy = vi.spyOn(db, 'saveVoidRequest').mockResolvedValue(undefined as any);

    // Spy on createApprovalRequest called by requestVoidSale
    const createApprovalSpy = vi.spyOn(approvals as any, 'createApprovalRequest').mockResolvedValue({ success: true, request: { id: 'apr-1' } });

    const { requestVoidSale } = approvals;

    const result = await requestVoidSale('tx-123', { total_amount: 100 }, 'Reason for void', fakeUser.id);

    expect(result.success).toBe(true);
    expect(saveVoidSpy).toHaveBeenCalled();
    expect(createApprovalSpy).toHaveBeenCalled();

    // restore
    getUserSpy.mockRestore();
    saveVoidSpy.mockRestore();
    createApprovalSpy.mockRestore();
  });
});
