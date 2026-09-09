// Permission Service for RBAC - Permission checks and authorization

import { getUser, getRole, getRoleByCode, getAllRoles, getAllPermissions } from './db';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, type Role, type RoleCode } from './security-types';

// Cache for user permissions (in-memory cache for performance)
const permissionCache = new Map<string, Set<string>>();

// Get all permissions for a user (role permissions + direct permissions)
export async function getUserPermissions(userId: string): Promise<Set<string>> {
  // Check cache first
  const cached = permissionCache.get(userId);
  if (cached) return cached;

  // Check if offline snapshot has permissions for this user
  const { getOfflineAuthSnapshot } = await import('./db');
  const snapshot = await getOfflineAuthSnapshot();
  if (snapshot && snapshot.userId === userId && Array.isArray(snapshot.permissions)) {
    const permissionNames = new Set<string>(snapshot.permissions);
    permissionCache.set(userId, permissionNames);
    return permissionNames;
  }

  const user = await getUser(userId);
  if (!user) return new Set();

  // 1. Primary lookup by user.role_id
  let role = user.role_id ? await getRole(user.role_id) : undefined;

  // 2. Defensive fallback by user.role_code
  if (!role && user.role_code) {
    role = await getRoleByCode(user.role_code);
  }

  // If role is found in database/IndexedDB, extract permissions
  if (role && Array.isArray(role.permissions)) {
    const allPermissions = await getAllPermissions();
    const permMap = new Map(allPermissions.map(p => [p.id, p.name]));

    const permissionNames = new Set<string>();
    for (const permId of role.permissions) {
      const permName = permMap.get(permId) || PERMISSIONS.find(p => p.id === permId)?.name;
      if (permName) permissionNames.add(permName);
    }

    permissionCache.set(userId, permissionNames);
    return permissionNames;
  }

  // 3. Final offline defense: recognized DEFAULT_ROLE_PERMISSIONS entry only for validated system role codes
  if (user.role_code && user.role_code in DEFAULT_ROLE_PERMISSIONS) {
    const defaultPermIds = DEFAULT_ROLE_PERMISSIONS[user.role_code as RoleCode];
    const allPermissions = await getAllPermissions();
    const permMap = new Map(allPermissions.map(p => [p.id, p.name]));

    const permissionNames = new Set<string>();
    for (const permId of defaultPermIds) {
      const permName = permMap.get(permId) || PERMISSIONS.find(p => p.id === permId)?.name;
      if (permName) permissionNames.add(permName);
    }

    permissionCache.set(userId, permissionNames);
    return permissionNames;
  }

  // 4. Fail closed for unknown or missing role
  return new Set();
}

// Check if user has a specific permission
export async function hasPermission(userId: string, permissionName: string): Promise<boolean> {
  const permissions = await getUserPermissions(userId);
  return permissions.has(permissionName);
}

// Check if user has any of the specified permissions
export async function hasAnyPermission(userId: string, permissionNames: string[]): Promise<boolean> {
  const permissions = await getUserPermissions(userId);
  return permissionNames.some(name => permissions.has(name));
}

// Check if user has all of the specified permissions
export async function hasAllPermissions(userId: string, permissionNames: string[]): Promise<boolean> {
  const permissions = await getUserPermissions(userId);
  return permissionNames.every(name => permissions.has(name));
}

// Check if user can perform action on entity (domain-based)
export async function canPerform(
  userId: string,
  domain: string,
  action: string
): Promise<boolean> {
  const permissionName = `${domain}.${action}`;
  return hasPermission(userId, permissionName);
}

// Get all roles
export async function getRoles(): Promise<Role[]> {
  return getAllRoles();
}

// Get role by code
export async function getRolePermissions(roleCode: RoleCode): Promise<Set<string>> {
  let role = await getRoleByCode(roleCode);
  if (!role) {
    const roles = await getAllRoles();
    role = roles.find(r => r.code === roleCode);
  }

  if (role && Array.isArray(role.permissions)) {
    const allPermissions = await getAllPermissions();
    const permMap = new Map(allPermissions.map(p => [p.id, p.name]));

    const permissionNames = new Set<string>();
    for (const permId of role.permissions) {
      const permName = permMap.get(permId) || PERMISSIONS.find(p => p.id === permId)?.name;
      if (permName) permissionNames.add(permName);
    }
    return permissionNames;
  }

  // Fallback to recognized DEFAULT_ROLE_PERMISSIONS
  if (roleCode && roleCode in DEFAULT_ROLE_PERMISSIONS) {
    const defaultPermIds = DEFAULT_ROLE_PERMISSIONS[roleCode];
    const allPermissions = await getAllPermissions();
    const permMap = new Map(allPermissions.map(p => [p.id, p.name]));

    const permissionNames = new Set<string>();
    for (const permId of defaultPermIds) {
      const permName = permMap.get(permId) || PERMISSIONS.find(p => p.id === permId)?.name;
      if (permName) permissionNames.add(permName);
    }
    return permissionNames;
  }

  return new Set();
}

// Check if role has permission
export async function roleHasPermission(roleCode: RoleCode, permissionName: string): Promise<boolean> {
  const permissions = await getRolePermissions(roleCode);
  return permissions.has(permissionName);
}

// Clear permission cache for a user (call when role changes)
export function clearPermissionCache(userId: string): void {
  permissionCache.delete(userId);
}

// Clear all permission cache
export function clearAllPermissionCache(): void {
  permissionCache.clear();
}

// Permission check helper for high-risk actions requiring approval
export async function canPerformWithoutApproval(
  userId: string,
  actionType: string
): Promise<{ canPerform: boolean; requiresApproval: boolean; error?: string }> {
  const user = await getUser(userId);
  if (!user) {
    return { canPerform: false, requiresApproval: false, error: 'User not found' };
  }

  // Get user's role: 1. primary role_id lookup, 2. role_code fallback
  let role = user.role_id ? await getRole(user.role_id) : undefined;
  if (!role && user.role_code) {
    role = await getRoleByCode(user.role_code);
  }
  if (!role && !(user.role_code && user.role_code in DEFAULT_ROLE_PERMISSIONS)) {
    return { canPerform: false, requiresApproval: false, error: 'Role not found' };
  }

  // Map high-risk actions to required permissions
  const actionPermissionMap: Record<string, string> = {
    'SALE_VOID': 'sales.void',
    'SALE_REFUND': 'sales.refund',
    'PRICE_CHANGE': 'price.change',
    'STOCK_ADJUSTMENT': 'inventory.adjust',
    'STOCK_TRANSFER': 'stock.transfer',
    'PURCHASE_CANCELLATION': 'purchasing.approve',
    'USER_DEACTIVATION': 'users.manage',
    'USER_ROLE_CHANGE': 'users.manage',
  };

  const requiredPermission = actionPermissionMap[actionType];
  if (!requiredPermission) {
    return { canPerform: false, requiresApproval: false, error: 'Unknown action type' };
  }

  // Check if user has the permission
  const hasPerm = await hasPermission(userId, requiredPermission);

  // Role-based skip for admin
  if (user.role_code === 'admin') {
    return { canPerform: true, requiresApproval: false };
  }

  // Managers can perform but require approval for certain actions
  if (user.role_code === 'manager') {
    const managerSelfActions = ['USER_DEACTIVATION', 'USER_ROLE_CHANGE'];
    if (managerSelfActions.includes(actionType)) {
      // Manager cannot perform these without admin approval
      return { canPerform: false, requiresApproval: true };
    }
    // Manager can perform void/refund with permission
    return { canPerform: hasPerm, requiresApproval: true };
  }

  // Cashiers need approval for all high-risk actions
  if (user.role_code === 'cashier') {
    return { canPerform: false, requiresApproval: true };
  }

  return { canPerform: hasPerm, requiresApproval: true };
}

// Get permission matrix for display
export async function getPermissionMatrix(): Promise<Map<string, Set<string>>> {
  const roles = await getAllRoles();
  const allPermissions = await getAllPermissions();
  const permMap = new Map(allPermissions.map(p => [p.id, p.name]));

  const matrix = new Map<string, Set<string>>();
  for (const role of roles) {
    const permNames = new Set<string>();
    for (const permId of role.permissions) {
      const permName = permMap.get(permId);
      if (permName) permNames.add(permName);
    }
    matrix.set(role.code, permNames);
  }

  return matrix;
}
