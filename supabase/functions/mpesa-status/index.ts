import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  authenticateAndAuthorize,
  json,
  PAYMENT_CORS_HEADERS,
  sanitizeErrorMessage,
} from "../lib/auth.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: PAYMENT_CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // 1. Authenticate & Authorize
  const authResult = await authenticateAndAuthorize(req, "payments.status");
  if (authResult instanceof Response) {
    return authResult;
  }
  const { posUser, supabaseAdmin, permissions } = authResult;

  try {
    let rawBody: Record<string, unknown>;
    try {
      rawBody = await req.json();
    } catch {
      return json({ error: "Invalid JSON request body" }, 400);
    }

    const checkoutRequestId =
      typeof rawBody.checkoutRequestId === "string"
        ? rawBody.checkoutRequestId.trim()
        : "";

    if (!checkoutRequestId) {
      return json({ error: "checkoutRequestId is required" }, 400);
    }

    const isElevated =
      posUser.role_code === "admin" ||
      posUser.role_code === "administrator" ||
      posUser.role_code === "manager" ||
      permissions.has("payments.manage");

    // 2. Try kcb_payments first
    const { data: kcbPayment, error: kcbError } = await supabaseAdmin
      .from("kcb_payments")
      .select("id, status, mpesa_receipt_number, result_desc, error_message, initiator_user_id, cashier_id, environment, checkout_request_id")
      .eq("checkout_request_id", checkoutRequestId)
      .maybeSingle();

    if (!kcbError && kcbPayment) {
      // Ownership check for cashiers
      if (!isElevated) {
        const ownerId = kcbPayment.initiator_user_id || kcbPayment.cashier_id;
        if (ownerId && ownerId !== posUser.id) {
          return json({ error: "Forbidden: Not authorized to view this transaction" }, 403);
        }
      }

      return json({
        success: true,
        status: kcbPayment.status,
        mpesaReceiptNumber: kcbPayment.mpesa_receipt_number,
        resultDesc: kcbPayment.result_desc || kcbPayment.error_message,
      });
    }

    // 3. Fall back to mpesa_transactions
    const { data: mpesaTx, error: txError } = await supabaseAdmin
      .from("mpesa_transactions")
      .select("status, mpesa_receipt_number, result_desc, callback_received, initiator_user_id")
      .eq("checkout_request_id", checkoutRequestId)
      .maybeSingle();

    if (txError || !mpesaTx) {
      return json({ error: "Transaction not found" }, 404);
    }

    // Ownership check for cashiers
    if (!isElevated) {
      const ownerId = mpesaTx.initiator_user_id;
      if (ownerId && ownerId !== posUser.id) {
        return json({ error: "Forbidden: Not authorized to view this transaction" }, 403);
      }
    }

    return json({
      success: true,
      status: mpesaTx.status || "pending",
      mpesaReceiptNumber: mpesaTx.mpesa_receipt_number,
      resultDesc: mpesaTx.result_desc || (mpesaTx.callback_received ? "Completed" : "Waiting for callback"),
    });
  } catch (error) {
    const safeMsg = sanitizeErrorMessage(
      error instanceof Error ? error.message : "Failed to check status"
    );
    console.error("[mpesa-status] error:", safeMsg);
    return json({ error: safeMsg }, 500);
  }
});

