import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  authenticateAndAuthorize,
  json,
  PAYMENT_CORS_HEADERS,
  resolveServerEnvironment,
  sanitizeErrorMessage,
  validateSTKPayload,
} from "../lib/auth.ts";

let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getKcbAccessToken(
  clientId: string,
  clientSecret: string,
  tokenUrl: string
): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at - 5000) {
    return cachedToken.access_token;
  }

  const creds = btoa(`${clientId}:${clientSecret}`);
  const resp = await fetch(`${tokenUrl}?grant_type=client_credentials`, {
    method: "GET",
    headers: { Authorization: `Basic ${creds}` },
    signal: AbortSignal.timeout(15000),
  });

  const text = await resp.text();
  if (!resp.ok) {
    let msg = `Auth failed (${resp.status})`;
    try {
      const parsed = JSON.parse(text);
      msg = parsed.error_description || parsed.errorMessage || parsed.error || msg;
    } catch {}
    throw new Error(msg);
  }
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error("No access token in KCB response");
  const expiresIn = data.expires_in ? Number(data.expires_in) : 300;
  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + expiresIn * 1000,
  };
  return cachedToken.access_token;
}

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

    // 4. Rate Limiting Check (per verified user)
    const now = Math.floor(Date.now() / 1000);
    const windowSeconds = 60;
    const maxRequests = 20;
    const rateLimitKey = `mpesa-stk-user:${posUser.id}`;

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
      console.warn("[mpesa-stk] rate limit check skipped:", rlErr);
    }

    // 5. Load KCB settings
    const { data: settings } = await supabaseAdmin
      .from("kcb_settings")
      .select("*")
      .eq("id", "kcb-settings")
      .maybeSingle();

    const clientId =
      settings?.client_id ??
      Deno.env.get("KCB_BUNI_CLIENT_ID") ??
      Deno.env.get("VITE_KCB_CLIENT_ID");
    const clientSecret =
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
      (baseUrl ? `${baseUrl}/oauth/authorize` : undefined);
    const callbackUrl =
      settings?.callback_url ?? Deno.env.get("KCB_BUNI_CALLBACK_URL");

    if (!clientId || !clientSecret || !baseUrl || !tokenUrl) {
      return json({ error: "KCB credentials or base URL are not configured" }, 400);
    }

    // Build STK push payload
    const stkBody = {
      phoneNumber: phone,
      amount: Math.round(amount),
      invoiceNumber: reference,
      description: typeof rawBody.transactionDesc === "string" ? rawBody.transactionDesc.slice(0, 100) : "POS Payment",
      callbackUrl,
    };

    const accessToken = await getKcbAccessToken(clientId, clientSecret, tokenUrl);

    const stkResp = await fetch(`${baseUrl}/stk/push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(stkBody),
      signal: AbortSignal.timeout(30000),
    });

    const stkDataText = await stkResp.text();
    let stkData: Record<string, unknown> = {};
    try {
      stkData = JSON.parse(stkDataText);
    } catch {
      stkData = { raw: stkDataText };
    }

    if (!stkResp.ok) {
      console.error("[mpesa-stk] push failed:", stkResp.status);
      return json({ error: "STK Push failed" }, 400);
    }

    const merchantRequestId =
      (stkData.MerchantRequestID as string) ||
      (stkData.merchantRequestId as string) ||
      (stkData.merchant_request_id as string) ||
      null;
    const checkoutRequestId =
      (stkData.CheckoutRequestID as string) ||
      (stkData.checkoutRequestId as string) ||
      (stkData.checkout_request_id as string) ||
      null;

    // Persist to kcb_payments table
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
        customer_id: typeof rawBody.customerId === "string" ? rawBody.customerId : null,
        raw_request: stkBody,
        raw_response: stkData,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.debug("[mpesa-stk] insert error:", err);
    }

    return json({
      success: true,
      merchantRequestId,
      checkoutRequestId,
      raw: stkData,
    });
  } catch (error) {
    const safeMsg = sanitizeErrorMessage(
      error instanceof Error ? error.message : "Internal error"
    );
    console.error("[mpesa-stk] handler error:", safeMsg);
    return json({ error: safeMsg }, 500);
  }
});

