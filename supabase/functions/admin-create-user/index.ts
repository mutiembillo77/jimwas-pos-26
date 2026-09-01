import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { checkRateLimit } from "../lib/rate_limit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const ADMIN_RATE_LIMIT = { maxRequests: 10, windowSeconds: 60, keyPrefix: 'admin_create_user' };

interface CreateUserPayload {
  username: string;
  email: string;
  password: string;
  fullName: string;
  roleCode: 'cashier' | 'manager' | 'admin';
  branchId?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: 'Server configuration error: missing Supabase environment variables' }, 500);
  }

  // 1. Authenticate the caller using their Authorization bearer token
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return json({ error: 'Authentication required. Missing Bearer token.' }, 401);
  }

  const token = authHeader.replace('Bearer ', '').trim();
  const callerClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user: callerAuthUser }, error: callerAuthError } = await callerClient.auth.getUser(token);
  if (callerAuthError || !callerAuthUser) {
    return json({ error: 'Invalid or expired session token. Please log in again.' }, 401);
  }

  // 2. Admin client for privileged backend queries & user creation
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // 3. Verify caller is an active administrator in public.users
  const { data: callerProfile, error: profileError } = await adminClient
    .from('users')
    .select('id, username, full_name, role_code, is_active')
    .eq('auth_user_id', callerAuthUser.id)
    .maybeSingle();

  if (profileError || !callerProfile || !callerProfile.is_active) {
    return json({ error: 'Caller account is inactive or profile not found.' }, 403);
  }

  if (callerProfile.role_code !== 'admin') {
    return json({ error: 'Forbidden: only administrators can provision new users.' }, 403);
  }

  // 3b. Rate limit: max 10 user-creation requests per 60 s per admin user ID
  const rateLimitResult = await checkRateLimit(adminClient, callerProfile.id, ADMIN_RATE_LIMIT);
  if (!rateLimitResult.allowed) {
    // Non-blocking audit log so abuse attempts are visible in the admin UI
    adminClient.from('audit_logs').insert({
      id: crypto.randomUUID(),
      event_type: 'USER_CREATION_RATE_LIMITED',
      user_id: callerProfile.id,
      user_name: callerProfile.full_name || callerProfile.username,
      user_role: callerProfile.role_code,
      entity_type: 'USER',
      entity_id: null,
      new_value: null,
      reason: `Rate limit exceeded: ${ADMIN_RATE_LIMIT.maxRequests} requests per ${ADMIN_RATE_LIMIT.windowSeconds}s`,
      created_at: new Date().toISOString(),
      sync_status: 'synced',
    }).then(({ error }) => {
      if (error) console.warn('[admin-create-user] Non-blocking rate-limit audit log failed:', error.message);
    });

    return new Response(
      JSON.stringify({
        error: 'Too many user creation requests. Please wait before trying again.',
        retryAfter: rateLimitResult.retryAfter ?? ADMIN_RATE_LIMIT.windowSeconds,
      }),
      {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Retry-After': String(rateLimitResult.retryAfter ?? ADMIN_RATE_LIMIT.windowSeconds),
          'X-RateLimit-Limit': String(ADMIN_RATE_LIMIT.maxRequests),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateLimitResult.resetAt),
        },
      }
    );
  }

  // 4. Validate request payload
  let payload: CreateUserPayload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const username = String(payload.username || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  const fullName = String(payload.fullName || '').trim();
  const roleCode = payload.roleCode;
  const branchId = payload.branchId ? String(payload.branchId).trim() : null;

  if (!username || username.length < 3 || username.length > 50) {
    return json({ error: 'Username must be between 3 and 50 characters.' }, 400);
  }

  if (!email || !email.includes('@') || !email.includes('.')) {
    return json({ error: 'Valid email address is required.' }, 400);
  }

  if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    return json({ error: 'Password must be at least 8 characters and include uppercase, lowercase, and a number.' }, 400);
  }

  if (!fullName) {
    return json({ error: 'Full name is required.' }, 400);
  }

  if (!['cashier', 'manager', 'admin'].includes(roleCode)) {
    return json({ error: 'Invalid role specified.' }, 400);
  }

  // 5. Check if username or email already exists in public.users
  const { data: existingUser } = await adminClient
    .from('users')
    .select('id, username, email')
    .or(`username.ilike.${username},email.ilike.${email}`)
    .maybeSingle();

  if (existingUser) {
    if (existingUser.username.toLowerCase() === username.toLowerCase()) {
      return json({ error: 'A POS user with this username already exists.' }, 409);
    }
    if (existingUser.email.toLowerCase() === email.toLowerCase()) {
      return json({ error: 'A POS user with this email address already exists.' }, 409);
    }
  }

  // 6. Look up role_id from public.roles
  const { data: roleData } = await adminClient
    .from('roles')
    .select('id')
    .eq('code', roleCode)
    .maybeSingle();

  const roleId = roleData?.id || (roleCode === 'admin' ? 'role-admin' : roleCode === 'manager' ? 'role-manager' : 'role-cashier');

  // 7. Create user in Supabase Auth via Admin API
  const { data: createdAuthData, error: createAuthError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      username,
      full_name: fullName,
      role_code: roleCode,
    },
  });

  if (createAuthError || !createdAuthData.user) {
    const errorMsg = createAuthError?.message || 'Failed to create user in authentication system.';
    return json({ error: errorMsg }, 400);
  }

  const authUserId = createdAuthData.user.id;
  const newUserId = crypto.randomUUID();
  const now = new Date().toISOString();

  // 8. Insert POS profile into public.users linked to auth_user_id
  const { data: createdProfile, error: profileInsertError } = await adminClient
    .from('users')
    .insert({
      id: newUserId,
      auth_user_id: authUserId,
      username,
      email,
      full_name: fullName,
      role_id: roleId,
      role_code: roleCode,
      branch_id: branchId,
      is_active: true,
      failed_login_attempts: 0,
      created_by: callerProfile.id,
      created_at: now,
      updated_at: now,
      sync_status: 'synced',
    })
    .select('*')
    .single();

  if (profileInsertError) {
    console.error('Failed to create POS profile in public.users:', profileInsertError);
    // Cleanup created auth user to avoid dangling identities
    await adminClient.auth.admin.deleteUser(authUserId);
    return json({ error: `Failed to create POS profile: ${profileInsertError.message}` }, 500);
  }

  // 9. Write audit log entry
  try {
    await adminClient.from('audit_logs').insert({
      id: crypto.randomUUID(),
      event_type: 'USER_CREATED',
      user_id: callerProfile.id,
      user_name: callerProfile.full_name || callerProfile.username,
      user_role: callerProfile.role_code,
      entity_type: 'USER',
      entity_id: newUserId,
      new_value: {
        username,
        email,
        role_code: roleCode,
        auth_user_id: authUserId,
      },
      reason: 'Administrator user provisioning',
      created_at: now,
      sync_status: 'synced',
    });
  } catch (auditErr) {
    console.warn('Non-blocking audit log failure on user creation:', auditErr);
  }

  return json({
    success: true,
    message: `User ${username} provisioned successfully with role ${roleCode}.`,
    user: createdProfile,
  }, 201);
});
