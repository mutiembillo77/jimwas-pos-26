import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  authenticateAndAuthorize,
  json,
  PAYMENT_CORS_HEADERS,
  resolveServerEnvironment,
  sanitizeErrorMessage,
} from "../lib/auth.ts";

function pemToArrayBuffer(pem: string) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary =
    typeof atob === "function"
      ? atob(b64)
      : Buffer.from(b64, "base64").toString("binary");
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signWithPrivateKeyPkcs8(privatePem: string, data: string) {
  const pkcs8 = pemToArrayBuffer(privatePem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data)
  );
  const sigBytes = new Uint8Array(signature);
  let s = "";
  for (let i = 0; i < sigBytes.length; i++) s += String.fromCharCode(sigBytes[i]);
  return typeof btoa === "function"
    ? btoa(s)
    : Buffer.from(s, "binary").toString("base64");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: PAYMENT_CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // 1. Authenticate & Authorize
  const authResult = await authenticateAndAuthorize(req, "payments.simulate");
  if (authResult instanceof Response) {
    return authResult;
  }
  const { posUser, supabaseAdmin } = authResult;

  try {
    // 2. Strict Environment Check (server-side only)
    const serverEnv = resolveServerEnvironment();
    if (serverEnv !== "SANDBOX") {
      return json(
        { error: "Simulation is strictly forbidden in production environment" },
        403
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON request body" }, 400);
    }

    const now = new Date().toISOString();
    const simulateFor = body.simulateFor || "till";

    if (simulateFor === "validation") {
      const validationPayload = {
        requestId: body.requestId || `sim-${Date.now()}`,
        customerReference: body.customerReference || "SIM-INV-1",
        organizationReference:
          body.organizationReference ||
          (Deno.env.get("DEFAULT_ORG_REF") ?? "777777"),
      };
      try {
        await supabaseAdmin.from("kcb_validations").insert([
          {
            request: validationPayload,
            response: {
              transactionID: `sim-${Date.now()}`,
              statusCode: "0",
              statusMessage: "Success",
              CustomerName: "Sim User",
              billAmount: body.amount || "1.00",
              currency: "KES",
              billType: "FIXED",
              creditAccountIdentifier: "SIMACC001",
            },
            received_at: now,
          },
        ]);
      } catch (err) {
        console.debug("[kcb-simulate] kcb_validations insert warning:", err);
      }

      if (
        body.sign &&
        typeof body.privateKeyPem === "string" &&
        typeof body.callbackUrl === "string"
      ) {
        const raw = JSON.stringify(validationPayload);
        const sig = await signWithPrivateKeyPkcs8(body.privateKeyPem, raw);
        const resp = await fetch(body.callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Signature: sig },
          body: raw,
        });
        const text = await resp.text();
        return json({ success: true, forwarded: true, resp: text });
      }

      return json({ success: true, message: "Validation simulated" });
    }

    const simulationPayload = {
      transactionReference: body.transactionReference || `FTSIM${Date.now()}`,
      requestId: body.requestId || `req-sim-${Date.now()}`,
      channelCode: body.channelCode || "202",
      timestamp: body.timestamp || now,
      transactionAmount: body.amount || "100.00",
      currency: body.currency || "KES",
      customerReference: body.customerReference || "SIM-INV-1",
      customerName: body.customerName || "Sim User",
      customerMobileNumber:
        body.customerMobileNumber || body.phone || "254700000000",
      balance: "1000.00",
      narration: body.narration || "Simulated payment",
      creditAccountIdentifier: body.creditAccountIdentifier || "SIMACC001",
      organizationShortCode:
        body.organizationShortCode ||
        (Deno.env.get("DEFAULT_ORG_REF") ?? "777777"),
      tillNumber: body.tillNumber || "150150",
      simulated_at: now,
      initiator_user_id: posUser.id,
    };

    try {
      await supabaseAdmin
        .from("kcb_notifications")
        .insert([{ payload: simulationPayload, received_at: now }]);
    } catch (err) {
      console.debug("[kcb-simulate] kcb_notifications insert warning:", err);
    }

    if (body.checkoutRequestId) {
      try {
        await supabaseAdmin
          .from("kcb_payments")
          .update({
            status: "paid",
            receipt: `SIMR${Date.now()}`,
            callback_received: true,
            updated_at: now,
          })
          .eq("checkout_request_id", body.checkoutRequestId);
      } catch (err) {
        console.debug("[kcb-simulate] kcb_payments update warning:", err);
      }
    }

    if (
      body.sign &&
      typeof body.privateKeyPem === "string" &&
      typeof body.callbackUrl === "string"
    ) {
      const raw = JSON.stringify(simulationPayload);
      const sig = await signWithPrivateKeyPkcs8(body.privateKeyPem, raw);
      const resp = await fetch(body.callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Signature: sig },
        body: raw,
      });
      const text = await resp.text();
      return json({ success: true, forwarded: true, resp: text });
    }

    return json({ success: true, payload: simulationPayload });
  } catch (error) {
    const safeMsg = sanitizeErrorMessage(
      error instanceof Error ? error.message : "Internal error"
    );
    console.error("[kcb-simulate] error:", safeMsg);
    return json({ error: safeMsg }, 500);
  }
});

