import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { User, OfflineAuthSnapshot } from '../src/lib/security-types';
import type { ReceiptSettings, Transaction } from '../src/lib/types';
import { maskPhoneNumber, buildReceiptHtml, saveReceiptToHistory, getReceiptHistory } from '../src/lib/print';

// Mock IndexedDB storage for offline auth snapshot and users
let mockSnapshotStore: OfflineAuthSnapshot | null = null;
const mockUsersStore = new Map<string, User>();
let mockLocalStorageStore: Record<string, string> = {};

vi.mock('../src/lib/db', () => ({
  saveOfflineAuthSnapshot: vi.fn(async (snapshot: OfflineAuthSnapshot) => {
    mockSnapshotStore = { ...snapshot };
  }),
  getOfflineAuthSnapshot: vi.fn(async () => {
    return mockSnapshotStore ? { ...mockSnapshotStore } : null;
  }),
  clearOfflineAuthSnapshot: vi.fn(async () => {
    mockSnapshotStore = null;
  }),
  getUser: vi.fn(async (id: string) => {
    return mockUsersStore.get(id);
  }),
  getUserByUsername: vi.fn(async (username: string) => {
    const users = Array.from(mockUsersStore.values());
    for (const u of users) {
      if (u.username === username) return u;
    }
    return undefined;
  }),
  getUserByAuthUserId: vi.fn(async (authUserId: string) => {
    const users = Array.from(mockUsersStore.values());
    for (const u of users) {
      if (u.auth_user_id === authUserId) return u;
    }
    return undefined;
  }),
  getUserByEmail: vi.fn(async (email: string) => {
    const users = Array.from(mockUsersStore.values());
    for (const u of users) {
      if (u.email === email) return u;
    }
    return undefined;
  }),
  saveUser: vi.fn(async (user: User) => {
    mockUsersStore.set(user.id, { ...user });
  }),
  saveLoginHistory: vi.fn(async () => {}),
  generateId: vi.fn(() => 'test-id-123'),
  getRoleByCode: vi.fn(async () => ({ id: 'role-cashier', code: 'cashier', name: 'Cashier' })),
}));

// Mock permissions
vi.mock('../src/lib/permissions', () => ({
  getUserPermissions: vi.fn(async () => new Set(['sales.create', 'sales.view'])),
  clearAllPermissionCache: vi.fn(),
}));

// Mock security monitor
vi.mock('../src/lib/security-monitor', () => ({
  logSecurityEvent: vi.fn(async () => ({ id: 'sec-event-1' })),
}));

// Mock Supabase client
const mockGetSession = vi.fn();
const mockSignInWithPassword = vi.fn();
const mockSignOut = vi.fn();
const mockRpc = vi.fn();
let mockIsConfiguredValue = true;

vi.mock('../src/lib/supabaseClient', () => ({
  isSupabaseConfigured: () => mockIsConfiguredValue,
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
      signInWithPassword: (creds: { email: string; password: string }) => mockSignInWithPassword(creds),
      signOut: () => mockSignOut(),
    },
    rpc: (fn: string, params: Record<string, unknown>) => mockRpc(fn, params),
    from: () => ({
      select: () => ({
        or: () => ({
          single: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  },
}));

// Import after mocks
import {
  getAuthState,
  login,
  logout,
  getCurrentUser,
  recordOfflineAuthSnapshot,
  validateOfflineAuthSnapshot,
  isNetworkOrTransportError,
  OFFLINE_AUTH_MAX_AGE_MS,
} from '../src/lib/auth';

describe('Jimwas POS — Comprehensive Authentication Security Boundary Audit', () => {
  const activeUser: User = {
    id: 'usr-1',
    auth_user_id: 'auth-usr-1',
    username: 'cashier1',
    email: 'cashier1@jimwas.com',
    full_name: 'Jane Cashier',
    role_id: 'role-cashier',
    role_code: 'cashier',
    is_active: true,
    failed_login_attempts: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sync_status: 'synced',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSnapshotStore = null;
    mockUsersStore.clear();
    mockUsersStore.set(activeUser.id, { ...activeUser });
    mockLocalStorageStore = {};
    mockIsConfiguredValue = true;

    // Mock navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true, userAgent: 'Chrome on Windows' },
      configurable: true,
      writable: true,
    });

    // Mock localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => mockLocalStorageStore[k] ?? null,
        setItem: (k: string, v: string) => { mockLocalStorageStore[k] = String(v); },
        removeItem: (k: string) => { delete mockLocalStorageStore[k]; },
        clear: () => { mockLocalStorageStore = {}; },
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Valid online session
  it('1. Valid online session -> online-authenticated and refreshes 24h snapshot', async () => {
    mockGetSession.mockResolvedValueOnce({
      data: {
        session: {
          user: { id: 'auth-usr-1', email: 'cashier1@jimwas.com' },
        },
      },
      error: null,
    });

    const result = await getAuthState();

    expect(result.state).toBe('online-authenticated');
    expect(result.user?.id).toBe('usr-1');
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot?.userId).toBe('usr-1');
    expect(mockSnapshotStore).not.toBeNull();
  });

  // 2. Online session === null
  it('2. Online session === null -> auth-required and purges snapshot without fallback', async () => {
    const now = Date.now();
    mockSnapshotStore = {
      userId: 'usr-1',
      authUserId: 'auth-usr-1',
      username: 'cashier1',
      fullName: 'Jane Cashier',
      roleCode: 'cashier',
      roleId: 'role-cashier',
      permissions: ['sales.create'],
      authorizedAt: new Date(now).toISOString(),
      lastOnlineAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10 * 60 * 60 * 1000).toISOString(),
    };

    mockGetSession.mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });

    const result = await getAuthState();

    expect(result.state).toBe('auth-required');
    expect(result.user).toBeNull();
    expect(mockSnapshotStore).toBeNull();
  });

  // 3. Online auth error
  it('3. Online auth error -> auth-required and purges snapshot without fallback', async () => {
    const now = Date.now();
    mockSnapshotStore = {
      userId: 'usr-1',
      authUserId: 'auth-usr-1',
      username: 'cashier1',
      fullName: 'Jane Cashier',
      roleCode: 'cashier',
      roleId: 'role-cashier',
      permissions: ['sales.create'],
      authorizedAt: new Date(now).toISOString(),
      lastOnlineAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10 * 60 * 60 * 1000).toISOString(),
    };

    mockGetSession.mockResolvedValueOnce({
      data: { session: null },
      error: { message: 'Invalid token / session expired', status: 401 },
    });

    const result = await getAuthState();

    expect(result.state).toBe('auth-required');
    expect(result.user).toBeNull();
    expect(mockSnapshotStore).toBeNull();
  });

  // 4. Network failure
  it('4. Network failure allows fallback to unexpired offline snapshot', async () => {
    const now = Date.now();
    mockSnapshotStore = {
      userId: 'usr-1',
      authUserId: 'auth-usr-1',
      username: 'cashier1',
      fullName: 'Jane Cashier',
      roleCode: 'cashier',
      roleId: 'role-cashier',
      permissions: ['sales.create'],
      authorizedAt: new Date(now).toISOString(),
      lastOnlineAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10 * 60 * 60 * 1000).toISOString(),
    };

    mockGetSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const result = await getAuthState();

    expect(result.state).toBe('offline-authorized');
    expect(result.user?.id).toBe('usr-1');
  });

  // 5. Offline valid snapshot
  it('5. Offline state with valid snapshot -> offline-authorized', async () => {
    const now = Date.now();
    mockSnapshotStore = {
      userId: 'usr-1',
      authUserId: 'auth-usr-1',
      username: 'cashier1',
      fullName: 'Jane Cashier',
      roleCode: 'cashier',
      roleId: 'role-cashier',
      permissions: ['sales.create'],
      authorizedAt: new Date(now).toISOString(),
      lastOnlineAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
    };

    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false },
      configurable: true,
      writable: true,
    });

    const result = await getAuthState();

    expect(result.state).toBe('offline-authorized');
    expect(result.user?.id).toBe('usr-1');
  });

  // 6. Offline expired snapshot
  it('6. Offline state with expired snapshot (>24h) -> auth-required and purges snapshot', async () => {
    const pastTime = Date.now() - (26 * 60 * 60 * 1000);
    mockSnapshotStore = {
      userId: 'usr-1',
      authUserId: 'auth-usr-1',
      username: 'cashier1',
      fullName: 'Jane Cashier',
      roleCode: 'cashier',
      roleId: 'role-cashier',
      permissions: ['sales.create'],
      authorizedAt: new Date(pastTime).toISOString(),
      lastOnlineAt: new Date(pastTime).toISOString(),
      expiresAt: new Date(pastTime + OFFLINE_AUTH_MAX_AGE_MS).toISOString(),
    };

    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false },
      configurable: true,
      writable: true,
    });

    const result = await getAuthState();

    expect(result.state).toBe('auth-required');
    expect(result.user).toBeNull();
    expect(mockSnapshotStore).toBeNull();
  });

  // 7. Offline snapshot cannot extend itself
  it('7. Offline snapshot cannot extend itself during offline operations', async () => {
    const fixedExpiry = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    mockSnapshotStore = {
      userId: 'usr-1',
      authUserId: 'auth-usr-1',
      username: 'cashier1',
      fullName: 'Jane Cashier',
      roleCode: 'cashier',
      roleId: 'role-cashier',
      permissions: ['sales.create'],
      authorizedAt: new Date().toISOString(),
      lastOnlineAt: new Date().toISOString(),
      expiresAt: fixedExpiry,
    };

    const valResult = await validateOfflineAuthSnapshot();
    expect(valResult.valid).toBe(true);
    expect(mockSnapshotStore.expiresAt).toBe(fixedExpiry);
  });

  // 8. Explicit logout
  it('8. Explicit logout terminates Supabase session and destroys OfflineAuthSnapshot', async () => {
    mockSnapshotStore = {
      userId: 'usr-1',
      authUserId: 'auth-usr-1',
      username: 'cashier1',
      fullName: 'Jane Cashier',
      roleCode: 'cashier',
      roleId: 'role-cashier',
      permissions: ['sales.create'],
      authorizedAt: new Date().toISOString(),
      lastOnlineAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
    };

    await logout();

    expect(mockSignOut).toHaveBeenCalled();
    expect(mockSnapshotStore).toBeNull();
  });

  // 9. Deactivated POS user
  it('9. Deactivated POS profile fails closed and signs out from Supabase', async () => {
    const inactiveUser: User = {
      ...activeUser,
      is_active: false,
    };
    mockUsersStore.set(inactiveUser.id, inactiveUser);

    mockGetSession.mockResolvedValueOnce({
      data: {
        session: {
          user: { id: 'auth-usr-1', email: 'cashier1@jimwas.com' },
        },
      },
      error: null,
    });

    const result = await getAuthState();

    expect(result.state).toBe('auth-required');
    expect(mockSignOut).toHaveBeenCalled();
    expect(mockSnapshotStore).toBeNull();
  });

  // 10. Missing POS profile
  it('10. Missing linked POS profile returns auth-required and purges snapshot', async () => {
    mockUsersStore.clear(); // No POS profile in DB

    mockGetSession.mockResolvedValueOnce({
      data: {
        session: {
          user: { id: 'unlinked-auth-id', email: 'unlinked@jimwas.com' },
        },
      },
      error: null,
    });

    const result = await getAuthState();

    expect(result.state).toBe('auth-required');
    expect(result.error).toContain('No associated POS employee profile');
    expect(mockSnapshotStore).toBeNull();
  });

  // 11. Missing Supabase configuration in production
  it('11. Missing Supabase configuration fails closed immediately without offline fallback', async () => {
    mockIsConfiguredValue = false; // Supabase unconfigured

    // Even if an unexpired snapshot exists in local storage
    mockSnapshotStore = {
      userId: 'usr-1',
      authUserId: 'auth-usr-1',
      username: 'cashier1',
      fullName: 'Jane Cashier',
      roleCode: 'cashier',
      roleId: 'role-cashier',
      permissions: ['sales.create'],
      authorizedAt: new Date().toISOString(),
      lastOnlineAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
    };

    const result = await getAuthState();

    expect(result.state).toBe('auth-required');
    expect(result.error).toContain('Authentication service is not configured');
  });

  // 12. Invalid/corrupted snapshot
  it('12. Corrupted snapshot missing required fields is discarded and returns auth-required', async () => {
    // @ts-expect-error test corrupted object
    mockSnapshotStore = {
      userId: 'usr-1',
      // missing authUserId and roleCode
    };

    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false },
      configurable: true,
      writable: true,
    });

    const result = await getAuthState();

    expect(result.state).toBe('auth-required');
    expect(mockSnapshotStore).toBeNull();
  });

  // 13. Legacy localStorage authentication attempt
  it('13. Legacy localStorage tokens (pos_session / pos_current_user) never grant authentication', async () => {
    mockLocalStorageStore['pos_session'] = 'fake-admin-token-123';
    mockLocalStorageStore['pos_current_user'] = JSON.stringify(activeUser);

    mockGetSession.mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });

    const user = await getCurrentUser();

    expect(user).toBeNull(); // Must fail closed, never reading pos_session
  });

  // 14. Username authentication
  it('14. Username authentication resolves email securely and signs in via Supabase Auth', async () => {
    mockSignInWithPassword.mockResolvedValueOnce({
      data: {
        user: { id: 'auth-usr-1', email: 'cashier1@jimwas.com' },
      },
      error: null,
    });

    const loginRes = await login('cashier1', 'Pass1234!');

    expect(loginRes.success).toBe(true);
    expect(loginRes.user?.username).toBe('cashier1');
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: 'cashier1@jimwas.com',
      password: 'Pass1234!',
    });
    expect(mockSnapshotStore).not.toBeNull();
  });

  // 15. Email authentication
  it('15. Direct email authentication authenticates via Supabase Auth and records snapshot', async () => {
    mockSignInWithPassword.mockResolvedValueOnce({
      data: {
        user: { id: 'auth-usr-1', email: 'cashier1@jimwas.com' },
      },
      error: null,
    });

    const loginRes = await login('cashier1@jimwas.com', 'Pass1234!');

    expect(loginRes.success).toBe(true);
    expect(loginRes.user?.email).toBe('cashier1@jimwas.com');
    expect(mockSnapshotStore).not.toBeNull();
  });

  // 16. Receipt phone masking
  it('16. Receipt phone masking follows exact privacy rules across all phone formats', () => {
    expect(maskPhoneNumber('0712345678')).toBe('07XXXXXX78');
    expect(maskPhoneNumber('0112345678')).toBe('01XXXXXX78');
    expect(maskPhoneNumber('+254712345678')).toBe('+254 7XXXXXX78');
    expect(maskPhoneNumber('254712345678')).toBe('254 7XXXXXX78');
    expect(maskPhoneNumber('123')).toBe('XXXX');
    expect(maskPhoneNumber('')).toBeNull();
    expect(maskPhoneNumber(null)).toBeNull();
    expect(maskPhoneNumber(undefined)).toBeNull();
  });

  // 17. Receipt history privacy
  it('17. saveReceiptToHistory sanitizes customer phone before storing in localStorage', () => {
    const rawTx: Transaction = {
      id: 'tx-history-001',
      total_amount: 1500,
      amount_paid: 1500,
      change_amount: 0,
      payment_method: 'cash',
      status: 'completed',
      customer_name: 'John Doe',
      customer_phone: '0712345678', // Raw unmasked phone
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
      items: [],
    };

    saveReceiptToHistory(rawTx);

    const history = getReceiptHistory();
    expect(history.length).toBe(1);
    expect(history[0].customer_phone).toBe('07XXXXXX78');
    expect(history[0].customer_phone).not.toContain('123456');

    // Confirm raw localStorage payload does not expose raw unmasked phone
    const rawStored = mockLocalStorageStore['jimwas_receipt_history'];
    expect(rawStored).toBeDefined();
    expect(rawStored).toContain('07XXXXXX78');
    expect(rawStored).not.toContain('0712345678');
  });

  // 18. Receipt preview / print HTML privacy
  it('18. buildReceiptHtml masks customer phone and never embeds raw phone number in printed HTML', () => {
    const rawTx: Transaction = {
      id: 'tx-print-001',
      total_amount: 2500,
      amount_paid: 2500,
      change_amount: 0,
      payment_method: 'mpesa',
      status: 'completed',
      customer_name: 'Alice Wambui',
      customer_phone: '0722123456', // Raw phone
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
      items: [
        {
          id: 'item-1',
          transaction_id: 'tx-print-001',
          product_id: 'p-1',
          product_name: 'Engine Oil',
          quantity: 1,
          unit_price: 2500,
          subtotal: 2500,
          created_at: new Date().toISOString(),
          sync_status: 'synced',
        },
      ],
    };

    const receiptSettings: ReceiptSettings = {
      id: 'rcpt-settings-1',
      business_name: 'Jimwas Auto Spares',
      business_phone: '0700000000',
      business_email: 'info@jimwas.com',
      business_address: 'Nairobi, Kenya',
      tax_id: 'P051234567Z',
      header_message: 'Welcome',
      footer_message: 'Thank you',
      show_logo: false,
      show_barcode: false,
      show_qr_code: false,
      show_tax_breakdown: false,
      show_cashier_name: true,
      show_customer_name: true,
      show_customer_phone: true,
      paper_width: '80mm',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced',
    };

    const businessSettings = {
      id: 'biz-1',
      business_name: 'Jimwas Auto Spares',
      business_phone: '0700000000',
      currency: 'KES',
      currency_symbol: 'KES',
      show_tax_on_receipt: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sync_status: 'synced' as const,
    };

    const htmlOutput = buildReceiptHtml({
      business: businessSettings,
      receipt: receiptSettings,
      transaction: rawTx,
    });

    expect(htmlOutput).toContain('07XXXXXX56');
    expect(htmlOutput).not.toContain('0722123456');
  });
});
