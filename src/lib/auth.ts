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

export interface SetupResult {
  success: boolean;
  error?: string;
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

  // If already an email, return lowercased
  if (trimmed.includes('@')) {
    return trimmed.toLowerCase();
  }

  // Attempt RPC resolution on Supabase
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc('get_auth_email_for_username', {
        p_username: trimmed,
      });
      if (!error && typeof data === 'string' && data.length > 0) {
        return data.toLowerCase();
      }
    } catch {
      // Fall through to local fallback
    }
  }

  // Fallback to locally cached user record by exact username
  try {
    const localUser = await getUserByUsername(trimmed);
    if (localUser?.email) {
      return localUser.email.toLowerCase();
    }
  } catch {
    // Ignore local lookup errors
  }

  return null;
}

/**
 * Controlled, auditable legacy migration path for binding an unlinked POS profile.
 * Only binds if the POS profile has auth_user_id === null or empty (cannot steal or rebind an already-linked identity).
 */
async function linkUnboundLegacyProfile(authUserId: string, authUserEmail: string): Promise<User | undefined> {
  try {
    const normalizedEmail = authUserEmail.toLowerCase().trim();
    let candidate = await getUserByEmail(normalizedEmail);

    if (!candidate && supabase) {
      const { data } = await supabase
        .from('users')
        .select('*')
        .eq('email', normalizedEmail)
        .maybeSingle();
      if (data) candidate = data as User;
    }

    // Strict safety check: do not rebind if already associated with a different auth identity
    if (candidate && (!candidate.auth_user_id || candidate.auth_user_id === authUserId)) {
      candidate.auth_user_id = authUserId;
      candidate.updated_at = new Date().toISOString();
      await saveUser(candidate);

      if (supabase) {
        try {
          await supabase.from('users').update({ auth_user_id: authUserId }).eq('id', candidate.id);
        } catch {
          // Non-critical if offline
        }
      }

      await logAuthSecurityEvent('ONLINE_REAUTHORIZATION_SUCCESS', candidate.id, `POS profile linked to Auth identity ${authUserId}`, 'low');
      return candidate;
    }
  } catch (err) {
    console.warn('[v0] Controlled legacy profile linking failed:', err);
  }
  return undefined;
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

    // 1. Authoritative resolution: retrieve POS user profile strictly linked to this auth identity
    let posUser = await getUserByAuthUserId(authUserId);

    // 2. If not found locally, fetch from Supabase public.users strictly by auth_user_id
    if (!posUser) {
      try {
        const { data: remoteUser } = await supabase
          .from('users')
          .select('*')
          .eq('auth_user_id', authUserId)
          .maybeSingle();

        if (remoteUser) {
          posUser = remoteUser as User;
          await saveUser(posUser);
        }
      } catch {
        // Table query error or not found
      }
    }

    // 3. Controlled legacy fallback: only link if profile has NO existing auth_user_id bound
    if (!posUser) {
      posUser = await linkUnboundLegacyProfile(authUserId, authUserEmail);
    }

    // 4. Check if a POS profile exists
    if (!posUser) {
      await logLoginAttempt(authUserId, authUserEmail, false, 'No associated POS employee profile');
      return {
        success: false,
        error: 'Authenticated successfully, but no POS employee profile is associated with this account. Please contact an administrator.',
      };
    }

    // 5. Check if active
    if (!posUser.is_active) {
      await supabase.auth.signOut();
      await clearOfflineAuthSnapshot();
      await logLoginAttempt(posUser.id, authUserEmail, false, 'Account deactivated');
      return { success: false, error: 'Your POS profile is deactivated. Please contact an administrator.' };
    }

    // 6. Update last login
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
    if (isNetworkOrTransportError(error)) {
      return { success: false, error: 'Network unavailable. Online connection required for primary authentication.' };
    }
    const message = error instanceof Error ? error.message : 'An unexpected error occurred';
    return { success: false, error: message };
  }
}

/**
 * Determine the exact system authentication state:
 *
 * ONLINE BOUNDARY:
 * 1. Supabase responds with valid session:
 *    -> Validate active POS profile by auth_user_id
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

      // Case 3: Supabase responds with valid session -> Validate POS profile strictly by auth_user_id
      const authUser = sessionData.session.user;
      let posUser = await getUserByAuthUserId(authUser.id);

      if (!posUser) {
        try {
          const { data: remoteUser } = await supabase
            .from('users')
            .select('*')
            .eq('auth_user_id', authUser.id)
            .maybeSingle();
          if (remoteUser) {
            posUser = remoteUser as User;
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
 * Administrator password reset request for a user.
 * Sends a secure password reset email to the user's registered address via Supabase Auth.
 * Note: Direct programmatic password assignment requires Supabase Admin API via a trusted
 * backend/Edge Function and is never executed from browser client code.
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

/**
 * Check if there are any remotely registered users (used during first-run setup)
 */
export async function hasRemoteUsers(): Promise<boolean> {
  if (!supabase) return false;
  const { count, error } = await supabase
    .from('users')
    .select('id', { count: 'exact', head: true });
  if (error) {
    console.error('[v0] Supabase user count failed:', error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

/**
 * Setup the first administrator account (only allowed when no remote users exist)
 */
export async function setupFirstAdministrator(
  username: string,
  email: string,
  password: string,
  fullName: string,
): Promise<SetupResult> {
  if (!supabase) return { success: false, error: 'Authentication service is unavailable' };
  if (!username.trim() || !email.trim() || !fullName.trim()) {
    return { success: false, error: 'All fields are required' };
  }
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    return { success: false, error: 'Password must be at least 8 characters and include uppercase, lowercase, and a number' };
  }
  if (await hasRemoteUsers()) {
    return { success: false, error: 'An administrator already exists. Sign in or ask an administrator to create your account.' };
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedUsername = username.trim();
  const normalizedName = fullName.trim();
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      data: {
        username: normalizedUsername,
        full_name: normalizedName,
        role_code: 'admin',
      },
    },
  });
  if (authError || !authData.user) {
    const message = authError?.message.toLowerCase() ?? '';
    if (message.includes('already registered') || message.includes('already been registered')) {
      return { success: false, error: 'This email already has an account. Sign in with the email and password you created.' };
    }
    if (message.includes('rate limit') || message.includes('too many')) {
      return { success: false, error: 'Supabase has temporarily rate-limited confirmation emails. Wait before trying again, then use the newest email link.' };
    }
    return { success: false, error: authError?.message || 'Unable to create the administrator account' };
  }

  if (authData.session) {
    await supabase.auth.signOut();
  }

  return { success: true };
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

/**
 * Create new POS user profile (admin only).
 * Provisions the local employee record. Note: Supabase Auth credentials must be created
 * either through user registration, the first-admin setup flow, or a trusted backend/Edge Function.
 */
export async function createUser(
  username: string,
  email: string,
  _password: string,
  fullName: string,
  roleCode: RoleCode,
  createdBy: string,
  branchId?: string
): Promise<{ success: boolean; error?: string; user?: User }> {
  const normalizedUsername = (username || '').trim();
  const normalizedEmail = (email || '').trim().toLowerCase();
  const normalizedName = (fullName || '').trim();

  if (!normalizedUsername) {
    return { success: false, error: 'Username is required' };
  }

  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return { success: false, error: 'Valid email is required' };
  }

  if (!normalizedName) {
    return { success: false, error: 'Full name is required' };
  }

  // 1. If online and Supabase is configured, invoke the trusted admin-create-user Edge Function
  if (isSupabaseConfigured() && supabase) {
    try {
      const { data, error } = await supabase.functions.invoke('admin-create-user', {
        body: {
          username: normalizedUsername,
          email: normalizedEmail,
          password: _password,
          fullName: normalizedName,
          roleCode,
          branchId,
        },
      });

      if (!error && data?.success && data?.user) {
        const createdUser = data.user as User;
        await saveUser(createdUser);
        return { success: true, user: createdUser };
      }

      if (data?.error || error?.message) {
        return { success: false, error: data?.error || error?.message || 'Failed to provision employee account.' };
      }
    } catch (edgeErr) {
      if (!isNetworkOrTransportError(edgeErr)) {
        return { success: false, error: edgeErr instanceof Error ? edgeErr.message : 'User provisioning error' };
      }
      console.warn('[v0] Edge Function unreachable, falling back to local user profile staging:', edgeErr);
    }
  }

  // 2. Offline / local fallback profile creation
  try {
    const existingUser = await getUserByUsername(normalizedUsername);
    if (existingUser) {
      return { success: false, error: 'Username already exists in POS profiles' };
    }

    const existingEmail = await getUserByEmail(normalizedEmail);
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
      username: normalizedUsername,
      email: normalizedEmail,
      full_name: normalizedName,
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
  _actorId?: string,
  _reason?: string
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
  _actorId?: string,
  _reason?: string
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

// Re-export session utilities for compatibility
export function getCurrentSession() {
  const sessionStr = typeof localStorage !== 'undefined' ? localStorage.getItem('pos_session') : null;
  if (!sessionStr) return null;
  try {
    return JSON.parse(sessionStr);
  } catch {
    return null;
  }
}

// Consume OAuth redirect error from URL hash (used by Auth callback page)
export function consumeAuthRedirectError(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const errorCode = params.get('error_code');
  const description = params.get('error_description');
  if (!errorCode && !description) return null;
  window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
  if (errorCode === 'otp_expired') {
    return 'This confirmation link has expired or was already used. Request a new confirmation email and open the newest link.';
  }
  if (errorCode === 'access_denied') {
    return 'Email confirmation was not completed. Request a new confirmation email and try again.';
  }
  return 'The email confirmation link could not be completed. Request a new confirmation email and try again.';
}
