import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  authenticateAndAuthorize,
  json,
  PAYMENT_CORS_HEADERS,
  resolveServerEnvironment,
  sanitizeErrorMessage,
  validateSTKPayload,
} from "../lib/auth.ts";

interface STKPushBody {
  phone?: string;
  amount?: number | string;
  accountReference?: string;
  invoiceNumber?: string;
  transactionId?: string;
  transactionDesc?: string;
  customerId?: string;
}

// In-memory token cache for function instance
let cachedKcbToken: { token: string; expiresAt: number } | null = null;

async function getKcbAccessToken(
  clientId: string,
  clientSecret: string,
  tokenUrl: string
): Promise<string> {
  if (cachedKcbToken && Date.now() < cachedKcbToken.expiresAt - 5000) {
    return cachedKcbToken.token;
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`KCB authentication failed (${response.status})`);
  }

  const data = await response.json();
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("KCB authentication returned no token");
  }

  const expiresIn = Number(data.expires_in) || 300;
  cachedKcbToken = {
    token: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return cachedKcbToken.token;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: PAYMENT_CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const correlationId =
    req.headers.get("x-correlation-id") || crypto.randomUUID();

  // 1. Authenticate & Authorize
  const authResult = await authenticateAndAuthorize(req, "payments.initiate");
  if (authResult instanceof Response) {
    return authResult;
  }
  const { posUser, supabaseAdmin } = authResult;

  try {
    let rawBody: Record<string, unknown>;
    try {
      rawBody = await req.json();
    } catch {
      return json({ error: "Invalid JSON request body", correlationId }, 400);
    }

    // 2. Validate Payload
    const validated = validateSTKPayload(rawBody);
    if (validated instanceof Response) {
      return validated;
    }
    const { phone, amount, reference } = validated;

    // 3. Resolve Environment (server-side only)
    const environment = resolveServerEnvironment();

    // 4. Rate Limiting Check (per user in api_rate_limits)
    const now = Math.floor(Date.now() / 1000);
    const windowSeconds = 60;
    const maxRequests = 20;
    const rateLimitKey = `stk-user:${posUser.id}`;

    try {
      const { data: rateRecord } = await supabaseAdmin
        .from("api_rate_limits")
        .select("count, window_start")
        .eq("key", rateLimitKey)
        .maybeSingle();

      if (!rateRecord || rateRecord.window_start < now - windowSeconds) {
        await supabaseAdmin
          .from("api_rate_limits")
          .upsert(
            { key: rateLimitKey, count: 1, window_start: now, updated_at: new Date().toISOString() },
            { onConflict: "key" }
          );
      } else if (rateRecord.count >= maxRequests) {
        return json(
          { error: "Too many payment requests. Please wait a moment.", correlationId },
          429
        );
      } else {
        await supabaseAdmin
          .from("api_rate_limits")
          .update({ count: rateRecord.count + 1, updated_at: new Date().toISOString() })
          .eq("key", rateLimitKey);
      }
    } catch (rlErr) {
      console.warn("[kcb-stk-push] rate limit check skipped:", rlErr);
    }

    // 5. Check KCB configuration
    const { data: settings } = await supabaseAdmin
      .from("kcb_settings")
      .select("*")
      .eq("id", "kcb-settings")
      .maybeSingle();

    if (!settings?.is_enabled) {
      return json({ error: "KCB is disabled or not configured", correlationId }, 400);
    }
    if (!settings.client_id || !settings.client_secret || !settings.org_shortcode || !settings.org_passkey) {
      return json({ error: "KCB configuration is incomplete", correlationId }, 400);
    }

    // 6. Idempotency Check
    const transactionId = typeof rawBody.transactionId === "string" ? rawBody.transactionId : null;
    const customerId = typeof rawBody.customerId === "string" ? rawBody.customerId : null;
    const idempotencyKey =
      req.headers.get("x-idempotency-key") ||
      `${transactionId || reference}:${phone}:${amount.toFixed(2)}`;

    const { data: existing } = await supabaseAdmin
      .from("kcb_payments")
      .select("id, status, checkout_request_id, merchant_request_id")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (existing && ["pending", "processing", "success"].includes(existing.status)) {
      return json({
        success: true,
        reused: true,
        checkoutRequestId: existing.checkout_request_id,
        merchantRequestId: existing.merchant_request_id,
        status: existing.status,
        correlationId,
      });
    }

    // 7. Prepare KCB Gateway Request
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const callbackUrl =
      settings.callback_url?.trim() ||
      `${supabaseUrl}/functions/v1/kcb-ipn-notification`;
    const baseUrl =
      Deno.env.get("KCB_BUNI_BASE_URL") ||
      (settings.environment === "production"
        ? "https://api.kcb.co.ke"
        : "https://api.sandbox.kcb.co.ke");
    const tokenUrl =
      Deno.env.get("KCB_BUNI_TOKEN_URL") || `${baseUrl}/oauth/token`;
    const stkUrl = `${baseUrl.replace(/\/$/, "")}/mm/api/request/1.0.0/stkpush`;
    const messageId = `JIMWAS-${crypto.randomUUID()}`;

    const kcbPayload = {
      phoneNumber: phone,
      amount: String(amount),
      invoiceNumber: reference,
      sharedShortCode: false,
      orgShortCode: settings.org_shortcode,
      orgPassKey: settings.org_passkey,
      callbackUrl,
      transactionDescription: typeof rawBody.transactionDesc === "string" ? rawBody.transactionDesc.slice(0, 100) : "POS Payment",
    };

    // Store in DB with server-verified user identity (never client identity)
    const { data: payment, error: insertError } = await supabaseAdmin
      .from("kcb_payments")
      .insert({
        idempotency_key: idempotencyKey,
        transaction_id: transactionId,
        customer_id: customerId,
        initiator_user_id: posUser.id,
        cashier_id: posUser.id,
        cashier_name: posUser.full_name,
        phone_number: phone,
        amount,
        environment,
        status: "pending",
        raw_request: { ...kcbPayload, orgPassKey: "[REDACTED]" },
        last_attempt_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (insertError || !payment) {
      console.error("[kcb-stk-push] DB insert error:", insertError?.message);
      return json({ error: "Unable to create payment attempt", correlationId }, 503);
    }

    // 8. Execute STK Push
    try {
      const token = await getKcbAccessToken(
        settings.client_id,
        settings.client_secret,
        tokenUrl
      );

      const response = await fetch(stkUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          accept: "application/json",
          routeCode: settings.route_code || "207",
          operation: "STKPush",
          messageId,
          "X-Correlation-ID": correlationId,
        },
        body: JSON.stringify(kcbPayload),
        signal: AbortSignal.timeout(30000),
      });

      const text = await response.text();
      let data: Record<string, unknown> = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text.slice(0, 500) };
      }

      const checkout =
        data.CheckoutRequestID ||
        data.checkoutRequestId ||
        data.checkout_request_id;
      const merchant =
        data.MerchantRequestID ||
        data.merchantRequestId ||
        data.merchant_request_id;
      const code = String(
        data.ResponseCode || data.responseCode || data.code || ""
      );

      if (
        !response.ok ||
        (code && !["0", "00000000"].includes(code)) ||
        typeof checkout !== "string"
      ) {
        await supabaseAdmin
          .from("kcb_payments")
          .update({
            status: "failed",
            result_code: code,
            result_desc: String(
              data.ResponseDescription || data.message || "KCB rejected the request"
            ).slice(0, 500),
            error_message: "Provider rejected STK request",
            raw_response: data,
            updated_at: new Date().toISOString(),
          })
          .eq("id", payment.id);

        return json(
          { error: "KCB did not accept the STK request", correlationId },
          response.ok ? 400 : 502
        );
      }

      await supabaseAdmin
        .from("kcb_payments")
        .update({
          checkout_request_id: checkout,
          merchant_request_id: typeof merchant === "string" ? merchant : null,
          status: "processing",
          raw_response: data,
          updated_at: new Date().toISOString(),
        })
        .eq("id", payment.id);

      return json({
        success: true,
        checkoutRequestId: checkout,
        merchantRequestId: merchant,
        responseCode: code || "00000000",
        status: "processing",
        correlationId,
      });
    } catch (pushError) {
      const safeDesc = sanitizeErrorMessage(
        pushError instanceof Error ? pushError.message : "KCB request failed"
      );
      await supabaseAdmin
        .from("kcb_payments")
        .update({
          status: "failed",
          error_message: "KCB request failed",
          result_desc: safeDesc,
          updated_at: new Date().toISOString(),
        })
        .eq("id", payment.id);

      return json({ error: "KCB request failed", correlationId }, 502);
    }
  } catch (err) {
    const safeMsg = sanitizeErrorMessage(
      err instanceof Error ? err.message : "Unexpected error"
    );
    console.error("[kcb-stk-push] Unexpected error:", safeMsg);
    return json({ error: "Invalid request", correlationId }, 400);
  }
});

