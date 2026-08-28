import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  authenticateAndAuthorize,
  json,
  PAYMENT_CORS_HEADERS,
  resolveServerEnvironment,
  sanitizeErrorMessage,
} from "../lib/auth.ts";

function generateReceiptNumber(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  let receipt = "";
  for (let i = 0; i < 10; i++) {
    receipt += chars[Math.floor(Math.random() * chars.length)];
  }
  return receipt;
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

    let rawBody: Record<string, unknown>;
    try {
      rawBody = await req.json();
    } catch {
      return json({ error: "Invalid JSON request body" }, 400);
    }

    const { checkoutRequestId, phone, amount } = rawBody;

    const receiptNumber = generateReceiptNumber();
    const now = new Date().toISOString();
    const txnDate = new Date();
    const formattedDate = [
      txnDate.getFullYear(),
      String(txnDate.getMonth() + 1).padStart(2, "0"),
      String(txnDate.getDate()).padStart(2, "0"),
      String(txnDate.getHours()).padStart(2, "0"),
      String(txnDate.getMinutes()).padStart(2, "0"),
      String(txnDate.getSeconds()).padStart(2, "0"),
    ].join("");

    const fakeCallback = {
      Body: {
        stkCallback: {
          MerchantRequestID: "sim-" + Date.now(),
          CheckoutRequestID: checkoutRequestId,
          ResultCode: 0,
          ResultDesc: "The service request is processed successfully.",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: Math.round(Number(amount)) || 1 },
              { Name: "MpesaReceiptNumber", Value: receiptNumber },
              { Name: "TransactionDate", Value: formattedDate },
              { Name: "PhoneNumber", Value: String(phone || "254708374149") },
            ],
          },
        },
      },
    };

    let updatedTx = null;

    if (
      typeof checkoutRequestId === "string" &&
      checkoutRequestId.length > 0 &&
      !checkoutRequestId.startsWith("sim-")
    ) {
      // Update existing record
      const { data, error } = await supabaseAdmin
        .from("mpesa_transactions")
        .update({
          status: "success",
          result_code: "0",
          result_desc: "The service request is processed successfully.",
          mpesa_receipt_number: receiptNumber,
          transaction_date: formattedDate,
          callback_received: true,
          callback_payload: fakeCallback,
          updated_at: now,
        })
        .eq("checkout_request_id", checkoutRequestId)
        .select()
        .single();

      if (error) {
        console.error("[mpesa-simulate] update error:", error.message);
        return json({ error: "Failed to simulate transaction update" }, 500);
      }
      updatedTx = data;
    } else {
      // Synthetic transaction in sandbox
      const syntheticId = `sim-${Date.now()}`;
      const { data, error } = await supabaseAdmin
        .from("mpesa_transactions")
        .insert({
          checkout_request_id: syntheticId,
          merchant_request_id: "sim-" + Date.now(),
          phone_number: String(phone || "254708374149"),
          amount: Math.round(Number(amount)) || 1,
          status: "success",
          result_code: "0",
          result_desc: "The service request is processed successfully.",
          mpesa_receipt_number: receiptNumber,
          transaction_date: formattedDate,
          callback_received: true,
          callback_payload: fakeCallback,
          initiator_user_id: posUser.id,
          environment: "SANDBOX",
        })
        .select()
        .single();

      if (error) {
        console.error("[mpesa-simulate] insert error:", error.message);
        return json({ error: "Failed to create simulated transaction" }, 500);
      }
      updatedTx = data;
    }

    if (updatedTx?.transaction_id) {
      await supabaseAdmin
        .from("transactions")
        .update({
          status: "completed",
          payment_reference: receiptNumber,
          updated_at: now,
        })
        .eq("id", updatedTx.transaction_id);
    }

    return json({
      success: true,
      message: "Payment simulated successfully",
      receiptNumber,
      checkoutRequestId: checkoutRequestId || updatedTx?.checkout_request_id,
    });
  } catch (error) {
    const safeMsg = sanitizeErrorMessage(
      error instanceof Error ? error.message : "Simulation failed"
    );
    console.error("[mpesa-simulate] error:", safeMsg);
    return json({ error: safeMsg }, 500);
  }
});

