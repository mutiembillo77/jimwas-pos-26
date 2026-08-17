// Auth Context - Provide authentication state to React components

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import type { User } from '../lib/security-types';
import { getCurrentUser, login as authLogin, logout as authLogout, initializeSecurity, requestPasswordReset, resendConfirmationEmail } from '../lib/auth';
import { clearOfflineAuthSnapshot } from '../lib/db';
import { clearAllPermissionCache } from '../lib/permissions';
import { initializeApp, shouldAutoRestore } from '../lib/init';
import { supabase } from '../lib/supabaseClient';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (identifier: string, password: string) => Promise<{ success: boolean; error?: string; isEmailUnconfirmed?: boolean; unconfirmedEmail?: string }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<{ success: boolean; error?: string }>;
  resendConfirmationEmail: (email: string) => Promise<{ success: boolean; error?: string }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function init() {
      try {
        // Initialization is best-effort and must never keep the preview blocked.
        await Promise.race([
          initializeApp(),
          new Promise<void>((resolve) => setTimeout(resolve, 2500)),
        ]);

        // Check if we should auto-restore from last backup
        await Promise.race([
          shouldAutoRestore(),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
        ]);

        // Initialize security data (roles, permissions) without blocking indefinitely.
        await Promise.race([
          initializeSecurity(),
          new Promise<void>((resolve) => setTimeout(resolve, 2500)),
        ]);

        // Get current Supabase Auth user and POS profile
        const currentUser = await Promise.race([
          getCurrentUser(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);

        if (isMounted) {
          setUser(currentUser);
        }
      } catch (error) {
        console.error('Auth init error:', error);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void init();

    // Subscribe to Supabase Auth state changes
    let authSubscription: { unsubscribe: () => void } | null = null;
    if (supabase) {
      const { data } = supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_OUT' || !session) {
          // Explicit signout or missing session invalidates local authorization snapshot
          await clearOfflineAuthSnapshot();
          if (isMounted) {
            setUser(null);
            clearAllPermissionCache();
          }
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
          const freshUser = await getCurrentUser();
          if (isMounted) {
            setUser(freshUser);
            clearAllPermissionCache();
          }
        }
      });
      authSubscription = data.subscription;
    }

    const loadingFallback = window.setTimeout(() => {
      if (isMounted && isLoading) {
        setIsLoading(false);
      }
    }, 5000);

    return () => {
      isMounted = false;
      window.clearTimeout(loadingFallback);
      authSubscription?.unsubscribe();
    };
  }, []);

  const login = async (identifier: string, password: string) => {
    const result = await authLogin(identifier, password);
    if (result.success && result.user) {
      setUser(result.user);
      clearAllPermissionCache();
    }
    return result;
  };

  const logout = async () => {
    await authLogout();
    setUser(null);
    clearAllPermissionCache();
  };

  const refreshUser = async () => {
    const currentUser = await getCurrentUser();
    setUser(currentUser);
    clearAllPermissionCache();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        logout,
        refreshUser,
        requestPasswordReset,
        resendConfirmationEmail,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Permission Guard component
interface PermissionGuardProps {
  permission: string | string[];
  requireAll?: boolean;
  children: ReactNode;
  fallback?: ReactNode;
}

export function PermissionGuard({ permission, requireAll = false, children, fallback = null }: PermissionGuardProps) {
  const { user } = useAuth();
  const [hasPermission, setHasPermission] = useState(false);

  useEffect(() => {
    async function checkPermission() {
      if (!user) {
        setHasPermission(false);
        return;
      }

      const { hasPermission: checkSingle, hasAnyPermission, hasAllPermissions } = await import('../lib/permissions');

      const permissions = Array.isArray(permission) ? permission : [permission];

      if (requireAll) {
        const result = await hasAllPermissions(user.id, permissions);
        setHasPermission(result);
      } else {
        const result = await hasAnyPermission(user.id, permissions);
        setHasPermission(result);
      }
    }

    checkPermission();
  }, [user, permission, requireAll]);

  if (!hasPermission) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}

// Role Guard component
interface RoleGuardProps {
  allowedRoles: Array<RoleCode>;
  children: ReactNode;
  fallback?: ReactNode;
}

export function RoleGuard({ allowedRoles, children, fallback = null }: RoleGuardProps) {
  const { user } = useAuth();

  if (!user || !allowedRoles.includes(user.role_code)) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
