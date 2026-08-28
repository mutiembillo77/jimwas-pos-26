import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  authenticateAndAuthorize,
  json,
  PAYMENT_CORS_HEADERS,
  resolveServerEnvironment,
  sanitizeErrorMessage,
  validateSTKPayload,
} from "../lib/auth.ts";

// ============ Token cache ============
interface TokenCache {
  access_token: string;
  expires_at: number;
}
let tokenCache: TokenCache | null = null;
let ongoingTokenPromise: Promise<string> | null = null;

async function getAccessToken(params: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const { tokenUrl, clientId, clientSecret } = params;
  if (!tokenUrl || !clientId || !clientSecret)
    throw new Error("Missing KCB token config");

  if (tokenCache && Date.now() < tokenCache.expires_at - 5000) {
    return tokenCache.access_token;
  }

  if (ongoingTokenPromise) return ongoingTokenPromise;

  ongoingTokenPromise = (async () => {
    try {
      const body = new URLSearchParams();
      body.set("grant_type", "client_credentials");

      const resp = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        },
        body: body.toString(),
      });

      const text = await resp.text();
      if (!resp.ok) {
        let msg = `Auth failed (${resp.status})`;
        try {
          const parsed = JSON.parse(text);
          msg =
            parsed.error_description ||
            parsed.errorMessage ||
            parsed.error ||
            msg;
        } catch {}
        throw new Error(msg);
      }
      const data = JSON.parse(text);
      if (!data.access_token) throw new Error("No access token in response");
      const expiresIn = data.expires_in ? Number(data.expires_in) : 300;
      tokenCache = {
        access_token: data.access_token,
        expires_at: Date.now() + expiresIn * 1000,
      };
      return tokenCache.access_token;
    } finally {
      ongoingTokenPromise = null;
    }
  })();

  return ongoingTokenPromise;
}

async function stkPush(params: {
  baseUrl: string;
  token: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
  headers?: Record<string, string>;
}) {
  const { baseUrl, token, body, timeoutMs = 30000, headers = {} } = params;
  const url = `${baseUrl.replace(/\/$/, "")}/mm/api/request/1.0.0/stkpush`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const messageId = `JIMWAS-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        accept: "application/json",
        routeCode: "207",
        operation: "STKPush",
        messageId: messageId,
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    if (!resp.ok)
      throw new Error(`STK push failed: ${resp.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ============ Main handler ============
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: PAYMENT_CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // 1. Authenticate & Authorize
  const authResult = await authenticateAndAuthorize(req, "payments.initiate");
  if (authResult instanceof Response) {
    return authResult;
  }
  const { posUser, supabaseAdmin } = authResult;

  try {
    // 2. Parse & Validate Payload
    let rawBody: Record<string, unknown>;
    try {
      rawBody = await req.json();
    } catch {
      return json({ error: "Invalid JSON request body" }, 400);
    }

    const validated = validateSTKPayload(rawBody);
    if (validated instanceof Response) {
      return validated;
    }
    const { phone, amount, reference } = validated;

    // 3. Resolve Environment (server-side only)
    const environment = resolveServerEnvironment();

    // 4. Rate Limiting Check (per verified posUser.id)
    const now = Math.floor(Date.now() / 1000);
    const windowSeconds = 60;
    const maxRequests = 30;
    const rateLimitKey = `kcb-stk-user:${posUser.id}`;

    try {
      const { data: rateRecord } = await supabaseAdmin
        .from("api_rate_limits")
        .select("count, window_start")
        .eq("key", rateLimitKey)
        .maybeSingle();

      if (!rateRecord || rateRecord.window_start < now - windowSeconds) {
        await supabaseAdmin.from("api_rate_limits").upsert(
          { key: rateLimitKey, count: 1, window_start: now, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
      } else if (rateRecord.count >= maxRequests) {
        return json({ error: "Rate limit exceeded. Please wait a moment." }, 429);
      } else {
        await supabaseAdmin
          .from("api_rate_limits")
          .update({ count: rateRecord.count + 1, updated_at: new Date().toISOString() })
          .eq("key", rateLimitKey);
      }
    } catch (rlErr) {
      console.warn("[kcb-stk] rate limit check skipped:", rlErr);
    }

    // 5. Load KCB settings
    const { data: settings } = await supabaseAdmin
      .from("kcb_settings")
      .select("*")
      .eq("id", "kcb-settings")
      .maybeSingle();

    const kcbClientId =
      settings?.client_id ??
      Deno.env.get("KCB_BUNI_CLIENT_ID") ??
      Deno.env.get("VITE_KCB_CLIENT_ID");
    const kcbClientSecret =
      settings?.client_secret ??
      Deno.env.get("KCB_BUNI_CLIENT_SECRET") ??
      Deno.env.get("VITE_KCB_CLIENT_SECRET");
    const baseUrl =
      settings?.base_url ??
      Deno.env.get("KCB_BUNI_BASE_URL") ??
      Deno.env.get("VITE_KCB_BASE_URL");
    const tokenUrl =
      settings?.token_url ??
      Deno.env.get("KCB_BUNI_TOKEN_URL") ??
      Deno.env.get("VITE_KCB_TOKEN_URL") ??
      (baseUrl ? `${baseUrl}/token` : undefined);
    const callbackUrl =
      settings?.callback_url ?? Deno.env.get("KCB_BUNI_CALLBACK_URL");

    if (!kcbClientId || !kcbClientSecret || !baseUrl || !tokenUrl) {
      return json({ error: "KCB credentials or base URL are not configured" }, 400);
    }

    const token = await getAccessToken({
      tokenUrl,
      clientId: kcbClientId,
      clientSecret: kcbClientSecret,
    });

    const stkBody: Record<string, unknown> = {
      phoneNumber: phone,
      amount: String(amount),
      invoiceNumber: reference,
      sharedShortCode: rawBody.sharedShortCode !== undefined ? !!rawBody.sharedShortCode : true,
      orgShortCode: settings?.org_shortcode || "",
      orgPassKey: settings?.org_passkey || "",
      callbackUrl,
      transactionDescription: typeof rawBody.transactionDescription === "string" ? rawBody.transactionDescription.slice(0, 100) : "POS Payment",
    };

    const headers = {
      routeCode: settings?.route_code || "207",
      operation: "STKPush",
      messageId: `JIMWAS-${crypto.randomUUID()}`,
    };

    const pushResp = await stkPush({ baseUrl, token, body: stkBody, headers });

    // Extract IDs
    let merchantRequestId: string | null = null;
    let checkoutRequestId: string | null = null;
    try {
      const respObj = (pushResp?.response as Record<string, unknown>) || pushResp;
      merchantRequestId =
        (respObj.MerchantRequestID as string) ||
        (respObj.merchantRequestId as string) ||
        null;
      checkoutRequestId =
        (respObj.CheckoutRequestID as string) ||
        (respObj.checkoutRequestId as string) ||
        null;
    } catch {
      /* ignore parsing error */
    }

    // Persist to kcb_payments with server-verified identity
    try {
      await supabaseAdmin.from("kcb_payments").insert({
        checkout_request_id: checkoutRequestId,
        merchant_request_id: merchantRequestId,
        phone_number: phone,
        amount,
        environment,
        initiator_user_id: posUser.id,
        cashier_id: posUser.id,
        cashier_name: posUser.full_name,
        status: "pending",
        transaction_id: typeof rawBody.transactionId === "string" ? rawBody.transactionId : null,
        raw_request: { ...stkBody, orgPassKey: "[REDACTED]" },
        raw_response: pushResp,
        created_at: new Date().toISOString(),
      });
    } catch (dbErr) {
      console.debug("[kcb-stk] kcb_payments insert warning:", dbErr);
    }

    return json({
      success: true,
      merchantRequestId,
      checkoutRequestId,
      raw: pushResp,
    });
  } catch (error) {
    const safeMsg = sanitizeErrorMessage(
      error instanceof Error ? error.message : "Internal error"
    );
    console.error("[kcb-stk] error:", safeMsg);
    return json({ error: safeMsg }, 500);
  }
});

