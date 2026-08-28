/**
 * supabase/functions/lib/auth.ts
 * GAP-3: Shared authentication and authorization layer for payment Edge Functions.
 *
 * Authentication sequence (per spec §2):
 *   HTTP request
 *     → Authorization header validation
 *     → Bearer token extraction
 *     → Supabase Auth getUser(token)
 *     → public.users lookup using service-role client
 *     → auth_user_id = authenticated Auth UID
 *     → is_active = true
 *     → permission check
 *
 * Identity is NEVER derived from client-supplied fields:
 *   cashierId, cashierName, userId, roleCode, role, permission
 *
 * Environment (per spec §6):
 *   Derived from trusted server-side Deno.env.get('APP_ENV') or
 *   KCB_BUNI_BASE_URL URL analysis. Client payload 'environment' field is ignored.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FinancialEnvironment = "SANDBOX" | "PRODUCTION";

export interface PosUser {
  id: string;
  full_name: string;
  branch_id: string | null;
  role_id: string | null;
  role_code: string;
  is_active: boolean;
  auth_user_id: string | null;
}

export interface CallerContext {
  authUser: { id: string; email: string | undefined };
  posUser: PosUser;
  supabaseAdmin: SupabaseClient;
  permissions: Set<string>;
}

// ---------------------------------------------------------------------------
// CORS headers (shared across all payment functions)
// ---------------------------------------------------------------------------

export const PAYMENT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, X-Idempotency-Key, X-Correlation-ID",
} as const;

// ---------------------------------------------------------------------------
// json() helper
// ---------------------------------------------------------------------------

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...PAYMENT_CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Credential-safe error sanitizer (per spec §11)
// ---------------------------------------------------------------------------

const CREDENTIAL_PATTERN =
  /(passkey|secret|consumer.?key|consumer.?secret|bearer\s+\S+|service.?role|refresh.?token|access.?token|authorization\s*:\s*\S+)/gi;

export function sanitizeErrorMessage(msg: string): string {
  return msg.replace(CREDENTIAL_PATTERN, "[REDACTED]");
}

function getEnvVar(key: string): string {
  if (typeof Deno !== "undefined" && Deno.env && typeof Deno.env.get === "function") {
    return Deno.env.get(key) ?? "";
  }
  if (typeof process !== "undefined" && process.env) {
    return process.env[key] ?? "";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Environment resolution (per spec §6)
//
// Priority:
//   1. APP_ENV                          → 'production' → PRODUCTION
//   2. KCB_BUNI_BASE_URL                → URL analysis (sandbox/uat in URL → SANDBOX)
//   3. Default: SANDBOX (fail-safe)
//
// Client request body 'environment' field is NEVER consulted.
// ---------------------------------------------------------------------------

export function resolveServerEnvironment(): FinancialEnvironment {
  const appEnv = getEnvVar("APP_ENV").toLowerCase().trim();
  if (appEnv === "production" || appEnv === "prod") {
    return "PRODUCTION";
  }
  if (appEnv && appEnv !== "") {
    // Any non-empty non-production APP_ENV → SANDBOX
    return "SANDBOX";
  }

  // Fall back to URL analysis
  const baseUrl = getEnvVar("KCB_BUNI_BASE_URL").toLowerCase();
  if (baseUrl.includes("api.kcb.co.ke") && !baseUrl.includes("sandbox") && !baseUrl.includes("uat")) {
    return "PRODUCTION";
  }

  return "SANDBOX";
}

// ---------------------------------------------------------------------------
// Phone normalization (per spec §5)
//
// Accepted inputs:
//   0[7|1]XXXXXXXX  → 254XXXXXXXXX
//   254[7|1]XXXXXXXX → 254XXXXXXXXX (already correct)
//   +254[7|1]XXXXXXXX → 254XXXXXXXXX
//
// Rejected: everything else (returns null)
// ---------------------------------------------------------------------------

export function normalizePhone(value: string): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");

  // 0[7|1]XXXXXXXX → local Kenyan mobile
  if (/^0[71]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;

  // 254[7|1]XXXXXXXX → already E.164-like without +
  if (/^254[71]\d{8}$/.test(digits)) return digits;

  return null;
}

// ---------------------------------------------------------------------------
// Amount validation (per spec §5)
//
// Requirements:
//   - number > 0
//   - finite (not NaN or Infinity)
//   - at most 2 decimal places
//   - max 999999.99 (reasonable limit matching existing kcb-stk-push)
// ---------------------------------------------------------------------------

export function validateAmount(raw: unknown): number | null {
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return null;
  if (amount <= 0) return null;
  if (amount > 999_999.99) return null;
  // At most 2 decimal places: round-trip check
  if (Math.round(amount * 100) !== amount * 100) return null;
  return amount;
}

// ---------------------------------------------------------------------------
// Reference validation (per spec §5)
//
// Max 50 chars. Allowed: alphanumeric, dash, underscore, dot, slash.
// ---------------------------------------------------------------------------

export function validateReference(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length > 50) return null;
  if (!/^[\w\-./]+$/.test(raw)) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// STK payload validation (per spec §5)
//
// Returns validated { phone, amount, reference } or returns a 400 Response.
// The caller must check `instanceof Response` to short-circuit.
// ---------------------------------------------------------------------------

export interface ValidatedSTKPayload {
  phone: string;
  amount: number;
  reference: string;
}

export function validateSTKPayload(body: Record<string, unknown>): ValidatedSTKPayload | Response {
  const phone = normalizePhone(String(body.phone ?? ""));
  if (!phone) {
    return json(
      { error: "Invalid phone number. Must be a valid Kenyan mobile number (e.g. 0712345678 or 254712345678)" },
      400
    );
  }

  const amount = validateAmount(body.amount);
  if (amount === null) {
    return json(
      { error: "Amount must be a positive number with at most 2 decimal places and not exceed 999999.99" },
      400
    );
  }

  const rawRef =
    body.accountReference ??
    body.invoiceNumber ??
    body.transactionId ??
    `POS-${Date.now()}`;
  const reference = validateReference(String(rawRef));
  if (!reference) {
    return json(
      { error: "Reference must be 1–50 characters and contain only alphanumeric, dash, underscore, dot, or slash" },
      400
    );
  }

  return { phone, amount, reference };
}

// ---------------------------------------------------------------------------
// Permission resolution
//
// Reads public.roles using the service-role client to get the permissions[]
// array for the user's role_id or role_code. Returns a Set<string> of
// permission *names* (e.g. 'payments.initiate').
// ---------------------------------------------------------------------------

async function resolvePermissions(
  supabaseAdmin: SupabaseClient,
  posUser: PosUser
): Promise<Set<string>> {
  // Find role by role_id (preferred) or fall back to role_code
  const roleQuery = posUser.role_id
    ? supabaseAdmin.from("roles").select("permissions").eq("id", posUser.role_id).maybeSingle()
    : supabaseAdmin.from("roles").select("permissions").eq("code", posUser.role_code).maybeSingle();

  const { data: roleRow } = await roleQuery;
  if (!roleRow || !Array.isArray(roleRow.permissions)) return new Set();

  // permissions[] contains permission *IDs* (e.g. 'perm-payments-initiate').
  // Resolve them to permission *names* via the permissions table.
  const permIds: string[] = roleRow.permissions;
  if (permIds.length === 0) return new Set();

  const { data: permRows } = await supabaseAdmin
    .from("permissions")
    .select("id, name")
    .in("id", permIds);

  const names = new Set<string>();
  for (const row of permRows ?? []) {
    if (row.name) names.add(row.name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// authenticateAndAuthorize (per spec §2 – full sequence)
//
// Returns CallerContext on success.
// Returns a Response (401 or 403) on any auth/authz failure.
//
// 401 Unauthorized: missing/invalid/forged credentials
// 403 Forbidden:    valid credentials but inactive/unlinked/insufficient privilege
// ---------------------------------------------------------------------------

export async function authenticateAndAuthorize(
  req: Request,
  requiredPermission: string
): Promise<CallerContext | Response> {
  // — Step 1: Authorization header presence and format ————————————————————
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return json({ error: "Authorization required" }, 401);
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer" || !parts[1]) {
    return json({ error: "Invalid Authorization header format" }, 401);
  }
  const token = parts[1];
  if (!token || token.length < 10) {
    return json({ error: "Invalid token" }, 401);
  }

  const supabaseUrl = getEnvVar("SUPABASE_URL");
  const serviceKey = getEnvVar("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("[auth] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: "Service configuration error" }, 500);
  }
  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // — Step 3: Validate the JWT via Supabase Auth ————————————————————————
  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !authData?.user) {
    // Log safe correlation info only — never the token itself
    console.warn("[auth] getUser failed:", authError?.message ?? "no user returned");
    return json({ error: "Invalid or expired token" }, 401);
  }
  const authUser = { id: authData.user.id, email: authData.user.email };

  // — Step 4: Look up POS profile in public.users ——————————————————————
  const { data: posUserRow, error: posUserError } = await supabaseAdmin
    .from("users")
    .select("id, full_name, branch_id, role_id, role_code, is_active, auth_user_id")
    .eq("auth_user_id", authUser.id)
    .maybeSingle();

  if (posUserError) {
    console.error("[auth] users lookup error:", posUserError.message);
    return json({ error: "Unable to verify identity" }, 500);
  }

  if (!posUserRow) {
    // Valid Auth user but no linked POS profile
    return json({ error: "No POS profile linked to this account" }, 403);
  }

  // — Step 5: Active check ——————————————————————————————————————————————
  if (!posUserRow.is_active) {
    return json({ error: "Account is inactive" }, 403);
  }

  const posUser: PosUser = posUserRow as PosUser;

  // — Step 6: Permission resolution and check ——————————————————————————
  const permissions = await resolvePermissions(supabaseAdmin, posUser);

  if (!permissions.has(requiredPermission)) {
    return json(
      { error: `Insufficient permissions for this operation` },
      403
    );
  }

  return { authUser, posUser, supabaseAdmin, permissions };
}
