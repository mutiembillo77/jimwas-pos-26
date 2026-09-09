import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Role, User, RoleCode, Permission, OfflineAuthSnapshot } from '../src/lib/security-types';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '../src/lib/security-types';
import { canAccessRoute, getRouteConfig } from '../src/lib/rbac-config';

// In-memory backing store for IndexedDB mock
let rolesStore = new Map<string, Role>();
let usersStore = new Map<string, User>();
let permissionsStore = new Map<string, Permission>();
let offlineSnapshot: OfflineAuthSnapshot | null = null;

vi.mock('../src/lib/db', () => ({
  getDB: vi.fn().mockResolvedValue({}),
  generateId: vi.fn(() => 'mock-uuid-' + Math.random().toString(36).slice(2)),
  getAllRoles: vi.fn(async () => Array.from(rolesStore.values())),
  getRole: vi.fn(async (id: string) => rolesStore.get(id)),
  getRoleByCode: vi.fn(async (code: string) => Array.from(rolesStore.values()).find(r => r.code === code)),
  saveRole: vi.fn(async (role: Role) => { rolesStore.set(role.id, { ...role }); }),
  deleteRole: vi.fn(async (id: string) => { rolesStore.delete(id); }),
  getAllUsers: vi.fn(async () => Array.from(usersStore.values())),
  getUser: vi.fn(async (id: string) => usersStore.get(id)),
  getUserByUsername: vi.fn(async (username: string) => Array.from(usersStore.values()).find(u => u.username === username)),
  saveUser: vi.fn(async (user: User) => { usersStore.set(user.id, { ...user }); }),
  getAllPermissions: vi.fn(async () => Array.from(permissionsStore.values())),
  savePermission: vi.fn(async (perm: Permission) => { permissionsStore.set(perm.id, { ...perm }); }),
  getOfflineAuthSnapshot: vi.fn(async () => offlineSnapshot),
  saveOfflineAuthSnapshot: vi.fn(async (snap: OfflineAuthSnapshot) => { offlineSnapshot = snap; }),
  clearOfflineAuthSnapshot: vi.fn(async () => { offlineSnapshot = null; }),
}));

// Import modules under test after mocking db
import { normalizeSystemRolesAndUsers } from '../src/lib/security-seed';
import {
  getUserPermissions,
  hasPermission,
  getRolePermissions,
  canPerformWithoutApproval,
  clearAllPermissionCache
} from '../src/lib/permissions';

describe('JIMWAS POS — RBAC Role-ID Consistency & Permission Resolution Tests', () => {
  beforeEach(() => {
    rolesStore.clear();
    usersStore.clear();
    permissionsStore.clear();
    offlineSnapshot = null;
    clearAllPermissionCache();

    // Populate permissionsStore with standard permissions
    for (const p of PERMISSIONS) {
      permissionsStore.set(p.id, { ...p, created_at: new Date().toISOString() });
    }
  });

  // ==========================================
  // Test 1 — Canonical role seeding
  // ==========================================
  it('Test 1 — Canonical role seeding: creates deterministic IDs and never random UUIDs for system roles', async () => {
    await normalizeSystemRolesAndUsers();

    const roles = Array.from(rolesStore.values());
    expect(roles.length).toBe(3);

    const adminRole = roles.find(r => r.code === 'admin');
    const managerRole = roles.find(r => r.code === 'manager');
    const cashierRole = roles.find(r => r.code === 'cashier');

    expect(adminRole).toBeDefined();
    expect(adminRole?.id).toBe('role-admin');

    expect(managerRole).toBeDefined();
    expect(managerRole?.id).toBe('role-manager');

    expect(cashierRole).toBeDefined();
    expect(cashierRole?.id).toBe('role-cashier');

    // Confirm system role IDs are NOT random UUIDs
    for (const r of roles) {
      expect(r.id).toMatch(/^role-(admin|manager|cashier)$/);
      expect(r.id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });

  // ==========================================
  // Test 2 — Legacy cashier migration
  // ==========================================
  it('Test 2 — Legacy cashier migration: migrates legacy random UUID role and user.role_id to role-cashier', async () => {
    const legacyRoleId = 'a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab';
    rolesStore.set(legacyRoleId, {
      id: legacyRoleId,
      code: 'cashier',
      name: 'Cashier',
      description: 'Cashier with basic sales',
      permissions: DEFAULT_ROLE_PERMISSIONS.cashier,
      is_system: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    });

    const cashierUser: User = {
      id: 'mercy-user-uuid',
      username: 'Kui',
      email: 'mercywangui2105@gmail.com',
      full_name: 'Mercy Wangui',
      role_id: legacyRoleId,
      role_code: 'cashier',
      is_active: true,
      failed_login_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    };
    usersStore.set(cashierUser.id, cashierUser);

    await normalizeSystemRolesAndUsers();

    // Canonical role exists
    const canonicalRole = rolesStore.get('role-cashier');
    expect(canonicalRole).toBeDefined();
    expect(canonicalRole?.code).toBe('cashier');

    // Legacy role record is safely removed
    expect(rolesStore.has(legacyRoleId)).toBe(false);

    // User's role_id is migrated to canonical ID
    const updatedUser = usersStore.get('mercy-user-uuid');
    expect(updatedUser?.role_id).toBe('role-cashier');
    expect(updatedUser?.role_code).toBe('cashier');
    expect(updatedUser?.email).toBe('mercywangui2105@gmail.com');
  });

  // ==========================================
  // Test 3 — Legacy manager migration
  // ==========================================
  it('Test 3 — Legacy manager migration: migrates legacy random UUID manager role and user.role_id to role-manager', async () => {
    const legacyManagerId = 'b2c3d4e5-f6a7-4b8c-9d0e-1234567890cd';
    rolesStore.set(legacyManagerId, {
      id: legacyManagerId,
      code: 'manager',
      name: 'Manager',
      description: 'Store manager',
      permissions: DEFAULT_ROLE_PERMISSIONS.manager,
      is_system: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    });

    const managerUser: User = {
      id: 'manager-user-uuid',
      username: 'Otiso',
      email: 'ongagavic2018@gmail.com',
      full_name: 'Victor Otiso',
      role_id: legacyManagerId,
      role_code: 'manager',
      is_active: true,
      failed_login_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    };
    usersStore.set(managerUser.id, managerUser);

    await normalizeSystemRolesAndUsers();

    expect(rolesStore.has('role-manager')).toBe(true);
    expect(rolesStore.has(legacyManagerId)).toBe(false);

    const updatedUser = usersStore.get('manager-user-uuid');
    expect(updatedUser?.role_id).toBe('role-manager');
    expect(updatedUser?.role_code).toBe('manager');
  });

  // ==========================================
  // Test 4 — Legacy admin migration
  // ==========================================
  it('Test 4 — Legacy admin migration: migrates admin to role-admin preserving admin authorization', async () => {
    const legacyAdminId = 'c3d4e5f6-a7b8-4c9d-0e1f-2345678901ef';
    rolesStore.set(legacyAdminId, {
      id: legacyAdminId,
      code: 'admin',
      name: 'System Administrator',
      description: 'Full system access',
      permissions: DEFAULT_ROLE_PERMISSIONS.admin,
      is_system: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    });

    const adminUser: User = {
      id: 'admin-user-uuid',
      username: 'admin',
      email: 'admin@jimwasenterprises.co.ke',
      full_name: 'System Administrator',
      role_id: legacyAdminId,
      role_code: 'admin',
      is_active: true,
      failed_login_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    };
    usersStore.set(adminUser.id, adminUser);

    await normalizeSystemRolesAndUsers();

    expect(rolesStore.has('role-admin')).toBe(true);
    expect(rolesStore.has(legacyAdminId)).toBe(false);

    const updatedUser = usersStore.get('admin-user-uuid');
    expect(updatedUser?.role_id).toBe('role-admin');
    expect(updatedUser?.role_code).toBe('admin');
  });

  // ==========================================
  // Test 5 — Migration idempotency
  // ==========================================
  it('Test 5 — Migration idempotency: running normalization multiple times produces identical stable state', async () => {
    const legacyId = 'd4e5f6a7-b8c9-4d0e-1f2a-3456789012ab';
    rolesStore.set(legacyId, {
      id: legacyId,
      code: 'cashier',
      name: 'Cashier',
      description: 'Cashier',
      permissions: DEFAULT_ROLE_PERMISSIONS.cashier,
      is_system: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    });

    usersStore.set('u1', {
      id: 'u1',
      username: 'u1',
      email: 'u1@test.com',
      full_name: 'U1',
      role_id: legacyId,
      role_code: 'cashier',
      is_active: true,
      failed_login_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    });

    // Run 1st time
    await normalizeSystemRolesAndUsers();
    const state1Roles = new Map(rolesStore);
    const state1Users = new Map(usersStore);

    // Run 2nd time
    await normalizeSystemRolesAndUsers();

    expect(rolesStore.size).toBe(state1Roles.size);
    expect(usersStore.size).toBe(state1Users.size);
    expect(rolesStore.get('role-cashier')?.id).toBe('role-cashier');
    expect(usersStore.get('u1')?.role_id).toBe('role-cashier');

    // Run 3rd time
    await normalizeSystemRolesAndUsers();
    expect(rolesStore.size).toBe(3);
    expect(usersStore.get('u1')?.role_id).toBe('role-cashier');
  });

  // ==========================================
  // Test 6 — Cashier permissions
  // ==========================================
  it('Test 6 — Cashier permissions: canonical cashier resolves sales.create and sales.view', async () => {
    await normalizeSystemRolesAndUsers();

    usersStore.set('cashier-user', {
      id: 'cashier-user',
      username: 'Kui',
      email: 'mercywangui2105@gmail.com',
      full_name: 'Mercy Wangui',
      role_id: 'role-cashier',
      role_code: 'cashier',
      is_active: true,
      failed_login_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    });

    const perms = await getUserPermissions('cashier-user');
    expect(perms.has('sales.create')).toBe(true);
    expect(perms.has('sales.view')).toBe(true);
    expect(perms.has('customers.view')).toBe(true);

    // Cashier does not have admin permissions
    expect(perms.has('users.manage')).toBe(false);
    expect(perms.has('settings.edit')).toBe(false);
  });

  // ==========================================
  // Test 7 — Manager permissions
  // ==========================================
  it('Test 7 — Manager permissions: manager resolves through role-manager and retains managerial permissions', async () => {
    await normalizeSystemRolesAndUsers();

    usersStore.set('mgr-1', {
      id: 'mgr-1',
      username: 'Otiso',
      email: 'manager@test.com',
      full_name: 'Manager Otiso',
      role_id: 'role-manager',
      role_code: 'manager',
      is_active: true,
      failed_login_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    });

    const perms = await getUserPermissions('mgr-1');
    expect(perms.has('sales.create')).toBe(true);
    expect(perms.has('sales.view')).toBe(true);
    expect(perms.has('inventory.view')).toBe(true);
    expect(perms.has('inventory.adjust')).toBe(true);
    expect(perms.has('reports.view')).toBe(true);

    // Manager does not have admin security-manage permissions
    expect(perms.has('users.manage')).toBe(false);
  });

  // ==========================================
  // Test 8 — Role-code fallback
  // ==========================================
  it('Test 8 — Role-code fallback: resolves permissions via getRoleByCode if role_id does not match', async () => {
    // Role is saved under canonical ID role-cashier
    await normalizeSystemRolesAndUsers();

    // Simulate user having an unmatched role_id (e.g. from an old or foreign system)
    usersStore.set('fallback-user', {
      id: 'fallback-user',
      username: 'fallback_cashier',
      email: 'fb@test.com',
      full_name: 'Fallback Cashier',
      role_id: 'non-existent-foreign-role-id',
      role_code: 'cashier',
      is_active: true,
      failed_login_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    });

    const perms = await getUserPermissions('fallback-user');
    expect(perms.has('sales.create')).toBe(true);
    expect(perms.has('sales.view')).toBe(true);
  });

  // ==========================================
  // Test 9 — Unknown role fails closed
  // ==========================================
  it('Test 9 — Unknown role fails closed: unknown role returns empty Set and zero permissions', async () => {
    await normalizeSystemRolesAndUsers();

    usersStore.set('unknown-user', {
      id: 'unknown-user',
      username: 'intruder',
      email: 'intruder@test.com',
      full_name: 'Unknown Role User',
      role_id: 'role-unknown',
      role_code: 'unknown' as any,
      is_active: true,
      failed_login_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    });

    const perms = await getUserPermissions('unknown-user');
    expect(perms.size).toBe(0);

    const hasSales = await hasPermission('unknown-user', 'sales.create');
    expect(hasSales).toBe(false);
  });

  // ==========================================
  // Test 10 — /pos regression
  // ==========================================
  it('Test 10 — /pos regression: verifies Mercy Wangui passes /pos route checks without Access Denied', async () => {
    await normalizeSystemRolesAndUsers();

    // Mercy Wangui profile as returned from Supabase
    const mercyUser: User = {
      id: '83bc7966-df98-4648-b83a-f1bfb317f8aa',
      auth_user_id: '70706a26-afa2-4ed4-83d8-ed3e2f56fa45',
      username: 'Kui',
      email: 'mercywangui2105@gmail.com',
      full_name: 'Mercy Wangui',
      role_id: 'role-cashier',
      role_code: 'cashier',
      is_active: true,
      failed_login_attempts: 0,
      created_at: '2026-09-01T10:11:43.030Z',
      updated_at: '2026-09-01T10:11:43.030Z',
      sync_status: 'synced',
    };
    usersStore.set(mercyUser.id, mercyUser);

    // Evaluate route config
    const routeConfig = getRouteConfig('/pos');
    expect(routeConfig).toBeDefined();
    expect(routeConfig?.allowedRoles).toContain('cashier');
    expect(routeConfig?.permissions).toEqual(['sales.create', 'sales.view']);

    // 1. Role-level access check
    const roleAllowed = canAccessRoute(mercyUser.role_code, '/pos');
    expect(roleAllowed).toBe(true);

    // 2. Permission-level checks (the exact checks in ProtectedRoute)
    const perms = routeConfig!.permissions!;
    const hasPerms = await Promise.all(
      perms.map(p => hasPermission(mercyUser.id, p))
    );
    const hasAccess = hasPerms.every(Boolean);

    // MUST BE TRUE — Access Denied is resolved!
    expect(hasAccess).toBe(true);
  });

  // ==========================================
  // Test 11 — Privileged actions
  // ==========================================
  it('Test 11 — Privileged actions: canPerformWithoutApproval resolves role and does not error with Role not found', async () => {
    await normalizeSystemRolesAndUsers();

    const cashierUser: User = {
      id: 'cashier-1',
      username: 'Kui',
      email: 'mercy@test.com',
      full_name: 'Mercy Wangui',
      role_id: 'role-cashier',
      role_code: 'cashier',
      is_active: true,
      failed_login_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    };
    usersStore.set(cashierUser.id, cashierUser);

    // A cashier requires approval for voiding a sale (permission sales.void is not granted to cashier)
    const result = await canPerformWithoutApproval(cashierUser.id, 'SALE_VOID');
    expect(result.error).toBeUndefined(); // MUST NOT say 'Role not found'
    expect(result.canPerform).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  // ==========================================
  // Test 12 — Offline behavior
  // ==========================================
  it('Test 12 — Offline behavior: getUserPermissions honors valid offlineAuthSnapshot with cached permissions', async () => {
    const offlineUserId = 'offline-user-1';
    usersStore.set(offlineUserId, {
      id: offlineUserId,
      username: 'offline_cashier',
      email: 'offline@test.com',
      full_name: 'Offline Cashier',
      role_id: 'role-cashier',
      role_code: 'cashier',
      is_active: true,
      failed_login_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    });

    offlineSnapshot = {
      userId: offlineUserId,
      authUserId: 'auth-123',
      username: 'offline_cashier',
      fullName: 'Offline Cashier',
      roleCode: 'cashier',
      roleId: 'role-cashier',
      permissions: ['sales.create', 'sales.view', 'offline.special'],
      authorizedAt: new Date().toISOString(),
      lastOnlineAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };

    const perms = await getUserPermissions(offlineUserId);
    expect(perms.has('sales.create')).toBe(true);
    expect(perms.has('sales.view')).toBe(true);
    expect(perms.has('offline.special')).toBe(true);
  });
});
