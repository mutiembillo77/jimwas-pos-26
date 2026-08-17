import { generateId, saveUser, getUserByUsername, getUserByEmail, getUserByAuthUserId, getUser, saveLoginHistory, saveOfflineAuthSnapshot, getOfflineAuthSnapshot, clearOfflineAuthSnapshot } from './db';
import type { User, RoleCode, AuthState, OfflineAuthSnapshot, SecurityEventType } from './security-types';
import { getRoleByCode } from './db';
import { supabase, isSupabaseConfigured } from './supabaseClient';

// Configurable offline authorization duration: 24 hours from last successful online authorization
export const OFFLINE_AUTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface LoginResult {
  success: boolean;
  error?: string;
  user?: User;
  snapshot?: OfflineAuthSnapshot;
  isEmailUnconfirmed?: boolean;
  unconfirmedEmail?: string;
}

function getDeviceInfo(): string {
  if (typeof navigator === 'undefined') return 'Unknown';
  const ua = navigator.userAgent;
  const browser = ua.includes('Chrome') ? 'Chrome' :
                  ua.includes('Firefox') ? 'Firefox' :
                  ua.includes('Safari') ? 'Safari' :
                  ua.includes('Edge') ? 'Edge' : 'Unknown';
  const os = ua.includes('Windows') ? 'Windows' :
             ua.includes('Mac') ? 'macOS' :
             ua.includes('Linux') ? 'Linux' :
             ua.includes('Android') ? 'Android' :
             ua.includes('iPhone') ? 'iOS' : 'Unknown';
  return `${browser} on ${os}`;
}

/**
 * Helper to log security events safely without blocking or throwing.
 */
async function logAuthSecurityEvent(
  eventType: SecurityEventType,
  userId?: string,
  description?: string,
  severity: 'low' | 'medium' | 'high' | 'critical' = 'low'
): Promise<void> {
  try {
    const { logSecurityEvent } = await import('./security-monitor');
    await logSecurityEvent(eventType, severity, description || eventType, userId);
  } catch {
    // Non-blocking security monitoring
  }
}

/**
 * Strict classifier for genuine network/transport failures.
 * Ensures arbitrary runtime/programming exceptions fail closed rather than falling through to offline authorization.
 */
export function isNetworkOrTransportError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return true;
  }

  if (!err) return false;

  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    if (err.name === 'AbortError' || err.name === 'NetworkError' || err.name === 'TimeoutError') {
      return true;
    }
  }

  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const name = (err instanceof Error ? err.name : '').toLowerCase();

  // Known transport / network failure signatures
  const networkPatterns = [
    'failed to fetch',
    'fetch failed',
    'networkerror',
    'network request failed',
    'net::err_',
    'econnrefused',
    'enotfound',
    'etimedout',
    'ehostunreach',
    'econnreset',
    'eai_again',
    'timed out',
    'timeout',
    'load failed',
    'offline',
    'connection refused',
    'connection timed out',
    'connection reset',
    'socket hung up',
  ];

  return networkPatterns.some((pattern) => message.includes(pattern) || name.includes(pattern));
}

/**
 * Capture an offline authorization snapshot for a successfully authenticated user.
 * Note: Never contains passwords, password hashes, or Supabase access tokens.
 * Lifetime is strictly 24 hours from the time of this online authorization.
 */
export async function recordOfflineAuthSnapshot(user: User): Promise<OfflineAuthSnapshot | null> {
  try {
    const { getUserPermissions } = await import('./permissions');
    const permsSet = await getUserPermissions(user.id);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + OFFLINE_AUTH_MAX_AGE_MS).toISOString();

    const snapshot: OfflineAuthSnapshot = {
      userId: user.id,
      authUserId: user.auth_user_id || '',
      username: user.username,
      fullName: user.full_name,
      roleCode: user.role_code,
      roleId: user.role_id,
      branchId: user.branch_id,
      branchName: user.branch_name,
      permissions: Array.from(permsSet),
      authorizedAt: now.toISOString(),
      lastOnlineAt: now.toISOString(),
      expiresAt,
    };

    await saveOfflineAuthSnapshot(snapshot);
    await logAuthSecurityEvent('OFFLINE_AUTH_GRANTED', user.id, `Offline authorization granted until ${expiresAt}`, 'low');
    return snapshot;
  } catch (error) {
    console.warn('[v0] Failed to record offline auth snapshot:', error);
    return null;
  }
}

/**
 * Validate the stored offline authorization snapshot.
 * Verifies that the snapshot exists, has not expired (max 24 hours), and belongs to an active POS user.
 */
export async function validateOfflineAuthSnapshot(): Promise<{
  valid: boolean;
  snapshot?: OfflineAuthSnapshot;
  user?: User;
  reason?: string;
}> {
  const snapshot = await getOfflineAuthSnapshot();
  if (!snapshot) {
    return { valid: false, reason: 'No offline authorization snapshot found' };
  }

  if (!snapshot.userId || !snapshot.authUserId || !snapshot.roleCode) {
    await clearOfflineAuthSnapshot();
    await logAuthSecurityEvent('OFFLINE_AUTH_REJECTED', undefined, 'Corrupted offline authorization snapshot discarded', 'medium');
    return { valid: false, reason: 'Offline authorization snapshot is corrupted' };
  }

  const now = Date.now();
  const expiry = new Date(snapshot.expiresAt).getTime();

  if (isNaN(expiry) || now >= expiry) {
    await logAuthSecurityEvent('OFFLINE_AUTH_EXPIRED', snapshot.userId, `Offline authorization window expired at ${snapshot.expiresAt}`, 'medium');
    await clearOfflineAuthSnapshot();
    return { valid: false, reason: 'Offline authorization period has expired (24-hour limit reached). Online connection required.' };
  }

  const user = await getUser(snapshot.userId);
  if (!user || !user.is_active) {
    await clearOfflineAuthSnapshot();
    await logAuthSecurityEvent('ACCOUNT_REVOKED', snapshot.userId, 'POS profile is inactive or missing during offline validation', 'high');
    return { valid: false, reason: 'Associated POS employee profile is inactive or removed' };
  }

  return { valid: true, snapshot, user };
}

/**
 * Resolve identifier (email or username) to the corresponding email address.
 * Uses a secure RPC get_auth_email_for_username if connected to Supabase,
 * or local cached records without exposing emails broadly.
 */
async function resolveEmail(identifier: string): Promise<string | null> {
  const trimmed = identifier.trim();
  if (!trimmed) return null;

  // If already an email, return as-is
  if (trimmed.includes('@')) {
    return trimmed;
  }

  // Attempt RPC resolution on Supabase
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc('get_auth_email_for_username', {
        p_username: trimmed,
      });
      if (!error && typeof data === 'string' && data.length > 0) {
        return data;
      }
    } catch {
      // Fall through to local fallback
    }
  }

  // Fallback to locally cached user record by username
  try {
    const localUser = await getUserByUsername(trimmed);
    if (localUser?.email) {
      return localUser.email;
    }
  } catch {
    // Ignore local lookup errors
  }

  return null;
}

/**
 * Authenticate using Supabase Auth.
 * Passwords are never verified against local hashes.
 */
export async function login(identifier: string, password: string): Promise<LoginResult> {
  if (!isSupabaseConfigured() || !supabase) {
    return {
      success: false,
      error: 'Authentication service is not configured. Please check environment variables (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY).',
    };
  }

  const email = await resolveEmail(identifier);
  if (!email) {
    await logLoginAttempt('', identifier, false, 'Invalid identifier or user not found');
    return { success: false, error: 'Invalid email/username or password.' };
  }

  try {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      const msg = authError.message.toLowerCase();
      if (msg.includes('email not confirmed') || (authError.status === 400 && msg.includes('confirm'))) {
        await logLoginAttempt('', email, false, 'Email not confirmed');
        return {
          success: false,
          error: 'Email address has not been confirmed. Please check your inbox for the confirmation link.',
          isEmailUnconfirmed: true,
          unconfirmedEmail: email,
        };
      }

      if (msg.includes('invalid login credentials') || msg.includes('invalid credentials') || msg.includes('user not found')) {
        await logLoginAttempt('', email, false, 'Invalid credentials');
        return { success: false, error: 'Invalid email or password.' };
      }

      await logLoginAttempt('', email, false, authError.message);
      return { success: false, error: authError.message || 'Login failed. Please try again.' };
    }

    if (!authData.user) {
      return { success: false, error: 'Authentication returned no active user.' };
    }

    const authUserId = authData.user.id;
    const authUserEmail = authData.user.email || email;

    // Retrieve POS user profile linked to this Supabase Auth identity
    let posUser = await getUserByAuthUserId(authUserId);

    // If not found by auth_user_id, try finding by email and link it
    if (!posUser) {
      posUser = await getUserByEmail(authUserEmail);
      if (posUser) {
        posUser.auth_user_id = authUserId;
        posUser.updated_at = new Date().toISOString();
        await saveUser(posUser);

        // Also update Supabase public.users table if accessible
        try {
          await supabase.from('users').update({ auth_user_id: authUserId }).eq('id', posUser.id);
        } catch {
          // Non-critical if offline
        }
      }
    }

    // If still not found locally, attempt to fetch from Supabase public.users
    if (!posUser) {
      try {
        const { data: remoteUser } = await supabase
          .from('users')
          .select('*')
          .or(`auth_user_id.eq.${authUserId},email.eq.${authUserEmail}`)
          .single();

        if (remoteUser) {
          posUser = remoteUser as User;
          posUser.auth_user_id = authUserId;
          await saveUser(posUser);
        }
      } catch {
        // Table query error or not found
      }
    }

    // Check if a POS profile exists
    if (!posUser) {
      await logLoginAttempt(authUserId, authUserEmail, false, 'No associated POS employee profile');
      return {
        success: false,
        error: 'Authenticated successfully, but no POS employee profile is associated with this account. Please contact an administrator.',
      };
    }

    // Check if active
    if (!posUser.is_active) {
      await supabase.auth.signOut();
      await clearOfflineAuthSnapshot();
      await logLoginAttempt(posUser.id, authUserEmail, false, 'Account deactivated');
      return { success: false, error: 'Your POS profile is deactivated. Please contact an administrator.' };
    }

    // Update last login
    const now = new Date().toISOString();
    posUser.last_login_at = now;
    posUser.failed_login_attempts = 0;
    posUser.updated_at = now;
    await saveUser(posUser);

    // Log successful login and record snapshot for subsequent offline operations
    await logLoginAttempt(posUser.id, posUser.username, true);
    await logAuthSecurityEvent('ONLINE_LOGIN', posUser.id, `User ${posUser.username} logged in online`, 'low');
    const snapshot = await recordOfflineAuthSnapshot(posUser);

    return { success: true, user: posUser, snapshot: snapshot || undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unexpected error occurred';
    if (message.includes('fetch') || message.includes('network') || message.includes('Failed to fetch')) {
      return { success: false, error: 'Network unavailable. Online connection required for primary authentication.' };
    }
    return { success: false, error: message };
  }
}

/**
 * Determine the exact system authentication state:
 *
 * ONLINE BOUNDARY:
 * 1. Supabase responds with valid session:
 *    -> Validate active POS profile
 *    -> 'online-authenticated'
 *    -> Refresh 24-hour OfflineAuthSnapshot
 *
 * 2. Supabase responds successfully but session is null:
 *    -> Clear OfflineAuthSnapshot
 *    -> 'auth-required'
 *    -> DO NOT allow offline fallback
 *
 * 3. Supabase explicitly returns authentication/session error:
 *    -> Clear OfflineAuthSnapshot
 *    -> 'auth-required'
 *    -> DO NOT allow offline fallback
 *
 * 4. Unexpected application exception:
 *    -> Fail closed: 'auth-required'
 *    -> DO NOT allow offline fallback
 *
 * NETWORK/OFFLINE BOUNDARY:
 * 5. Supabase cannot be reached due to a genuine network/transport failure:
 *    -> Validate OfflineAuthSnapshot
 *    -> If unexpired (max 24h) and POS profile active: 'offline-authorized'
 *    -> Otherwise: 'auth-required'
 */
export async function getAuthState(): Promise<{
  state: AuthState;
  user: User | null;
  snapshot?: OfflineAuthSnapshot | null;
  error?: string;
}> {
  // 0. CONFIGURATION INTEGRITY: Supabase Auth is the primary authority.
  // Missing or uninitialized configuration MUST FAIL CLOSED immediately.
  // An unconfigured backend MUST NEVER fall through to OfflineAuthSnapshot.
  if (!isSupabaseConfigured() || !supabase) {
    return {
      state: 'auth-required',
      user: null,
      error: 'Authentication service is not configured. Online connection required for setup.',
    };
  }

  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;

  // 1. ONLINE: Check Supabase Auth as the primary authority when online and client configured
  if (isOnline) {
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

      // Case 1: Supabase explicitly returns an authentication / session error
      if (sessionError) {
        await clearOfflineAuthSnapshot();
        await logAuthSecurityEvent('ACCOUNT_REVOKED', undefined, `Online session validation error: ${sessionError.message}`, 'high');
        return {
          state: 'auth-required',
          user: null,
          error: sessionError.message || 'Authentication session error. Please log in again.',
        };
      }

      // Case 2: Supabase is reachable and responds successfully, but session is null (expired / logged out)
      if (!sessionData || !sessionData.session || !sessionData.session.user) {
        await clearOfflineAuthSnapshot();
        return {
          state: 'auth-required',
          user: null,
          error: 'Authentication required. No active online session.',
        };
      }

      // Case 3: Supabase responds with valid session -> Validate POS profile
      const authUser = sessionData.session.user;
      let posUser = await getUserByAuthUserId(authUser.id);

      if (!posUser && authUser.email) {
        posUser = await getUserByEmail(authUser.email);
        if (posUser) {
          posUser.auth_user_id = authUser.id;
          await saveUser(posUser);
        }
      }

      if (!posUser) {
        try {
          const { data: remoteUser } = await supabase
            .from('users')
            .select('*')
            .or(`auth_user_id.eq.${authUser.id},email.eq.${authUser.email}`)
            .single();
          if (remoteUser) {
            posUser = remoteUser as User;
            posUser.auth_user_id = authUser.id;
            await saveUser(posUser);
          }
        } catch {
          // Table query error or profile not found
        }
      }

      if (!posUser) {
        await clearOfflineAuthSnapshot();
        return {
          state: 'auth-required',
          user: null,
          error: 'No associated POS employee profile found for this account.',
        };
      }

      if (!posUser.is_active) {
        // Server confirms account deactivated
        await supabase.auth.signOut();
        await clearOfflineAuthSnapshot();
        await logAuthSecurityEvent('ACCOUNT_REVOKED', posUser.id, 'User account was deactivated on server', 'high');
        return {
          state: 'auth-required',
          user: null,
          error: 'Your POS profile is deactivated. Please contact an administrator.',
        };
      }

      // Valid online authentication -> Refresh 24-hour OfflineAuthSnapshot
      const snapshot = await recordOfflineAuthSnapshot(posUser);
      return {
        state: 'online-authenticated',
        user: posUser,
        snapshot,
      };
    } catch (err) {
      // Differentiate genuine network/transport failures from application/programming exceptions
      if (isNetworkOrTransportError(err)) {
        console.warn('[Security Boundary] Supabase unreachable due to network/transport failure. Evaluating offline snapshot:', err);
        // Fall through to offline snapshot validation below
      } else {
        // Non-network/unexpected error -> Fail closed
        console.error('[Security Boundary] Non-network error during authentication verification. Failing closed:', err);
        return {
          state: 'auth-required',
          user: null,
          error: err instanceof Error ? err.message : 'Authentication verification error.',
        };
      }
    }
  }

  // 2. NETWORK/OFFLINE: Supabase unreachable due to genuine network failure or offline state
  const offlineCheck = await validateOfflineAuthSnapshot();
  if (offlineCheck.valid && offlineCheck.user && offlineCheck.snapshot) {
    return {
      state: 'offline-authorized',
      user: offlineCheck.user,
      snapshot: offlineCheck.snapshot,
    };
  }

  // Snapshot missing, corrupted, or expired (24-hour limit reached)
  return {
    state: 'auth-required',
    user: null,
    error: offlineCheck.reason || 'Authentication required. Please connect to the internet to log in.',
  };
}

/**
 * Retrieve current user by validating active authentication / offline snapshot.
 * Never allows unauthenticated localStorage bypasses.
 */
export async function getCurrentUser(): Promise<User | null> {
  const { user } = await getAuthState();
  return user;
}

/**
 * Explicit logout of Supabase Auth and termination of local offline authorization.
 * Destroys all offline authorization snapshots and cached permissions.
 */
export async function logout(): Promise<void> {
  const currentSnapshot = await getOfflineAuthSnapshot();
  if (currentSnapshot?.userId) {
    await logAuthSecurityEvent('ONLINE_LOGOUT', currentSnapshot.userId, `User ${currentSnapshot.username} logged out`, 'low');
  }

  try {
    if (supabase) {
      await supabase.auth.signOut();
    }
  } catch (error) {
    console.warn('[v0] Supabase signOut warning:', error);
  }

  // Clear offline authorization snapshot and legacy tokens
  await clearOfflineAuthSnapshot();
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('pos_session');
    localStorage.removeItem('pos_current_user');
  }
}

/**
 * Request password reset email via Supabase Auth
 */
export async function requestPasswordReset(email: string): Promise<{ success: boolean; error?: string }> {
  if (!isSupabaseConfigured() || !supabase) {
    return { success: false, error: 'Authentication service is not configured.' };
  }

  try {
    const redirectTo = typeof window !== 'undefined' ? window.location.origin : undefined;
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to request password reset' };
  }
}

/**
 * Resend signup confirmation email via Supabase Auth
 */
export async function resendConfirmationEmail(email: string): Promise<{ success: boolean; error?: string }> {
  if (!isSupabaseConfigured() || !supabase) {
    return { success: false, error: 'Authentication service is not configured.' };
  }

  try {
    const emailRedirectTo = typeof window !== 'undefined' ? window.location.origin : undefined;
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim(),
      options: { emailRedirectTo },
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to resend confirmation' };
  }
}

/**
 * Change password for the currently authenticated Supabase user
 */
export async function changePassword(
  userIdOrNewPassword: string,
  _oldPassword?: string,
  newPasswordParam?: string
): Promise<{ success: boolean; error?: string }> {
  if (!isSupabaseConfigured() || !supabase) {
    return { success: false, error: 'Authentication service is not configured.' };
  }

  const targetPassword = newPasswordParam || userIdOrNewPassword;

  if (targetPassword.length < 8 || !/[A-Z]/.test(targetPassword) || !/[a-z]/.test(targetPassword) || !/\d/.test(targetPassword)) {
    return { success: false, error: 'New password must be at least 8 characters and include uppercase, lowercase, and a number' };
  }

  try {
    const { error } = await supabase.auth.updateUser({ password: targetPassword });
    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to update password' };
  }
}

/**
 * Administrator reset password request for a user
 */
export async function resetUserPassword(
  targetUserId: string,
  _newPassword?: string,
  _actorId?: string
): Promise<{ success: boolean; error?: string }> {
  const target = await getUser(targetUserId);
  if (!target || !target.email) {
    return { success: false, error: 'User profile or email not found' };
  }

  return requestPasswordReset(target.email);
}

// Log login attempt helper
async function logLoginAttempt(userId: string, username: string, success: boolean, reason?: string): Promise<void> {
  try {
    const loginRecord = {
      id: generateId(),
      user_id: userId,
      user_name: username,
      device_info: getDeviceInfo(),
      login_at: new Date().toISOString(),
      login_status: (success ? 'success' : 'failed') as 'success' | 'failed',
      failure_reason: success ? undefined : reason,
      sync_status: 'pending' as const,
    };

    await saveLoginHistory(loginRecord);
  } catch {
    // Non-blocking
  }
}

// Initialize default roles and system seed
export async function initializeSecurity(): Promise<void> {
  const { initializeSecurityData } = await import('./security-seed');
  await initializeSecurityData();
}

// Create new POS user profile (admin only)
export async function createUser(
  username: string,
  email: string,
  password: string,
  fullName: string,
  roleCode: RoleCode,
  createdBy: string,
  branchId?: string
): Promise<{ success: boolean; error?: string; user?: User }> {
  try {
    const existingUser = await getUserByUsername(username);
    if (existingUser) {
      return { success: false, error: 'Username already exists in POS profiles' };
    }

    const existingEmail = await getUserByEmail(email);
    if (existingEmail) {
      return { success: false, error: 'Email already exists in POS profiles' };
    }

    const role = await getRoleByCode(roleCode);
    if (!role) {
      return { success: false, error: 'Invalid role' };
    }

    const now = new Date().toISOString();
    const user: User = {
      id: generateId(),
      username,
      email,
      full_name: fullName,
      role_id: role.id,
      role_code: roleCode,
      branch_id: branchId,
      is_active: true,
      failed_login_attempts: 0,
      created_by: createdBy,
      created_at: now,
      updated_at: now,
      sync_status: 'pending',
    };

    await saveUser(user);
    return { success: true, user };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to create user profile' };
  }
}

// Update user status
export async function updateUserStatus(
  userId: string,
  isActive: boolean,
  actorId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  const user = await getUser(userId);
  if (!user) return { success: false, error: 'User not found' };

  const now = new Date().toISOString();
  const updatedUser: User = {
    ...user,
    is_active: isActive,
    updated_at: now,
    sync_status: 'pending',
  };

  await saveUser(updatedUser);
  return { success: true };
}

// Update user role
export async function updateUserRole(
  userId: string,
  newRoleCode: RoleCode,
  actorId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  const user = await getUser(userId);
  if (!user) return { success: false, error: 'User not found' };

  const role = await getRoleByCode(newRoleCode);
  if (!role) return { success: false, error: 'Invalid role' };

  const now = new Date().toISOString();
  const updatedUser: User = {
    ...user,
    role_id: role.id,
    role_code: newRoleCode,
    updated_at: now,
    sync_status: 'pending',
  };

  await saveUser(updatedUser);
  return { success: true };
}
