import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.39.3";

type FinancialEnvironment = 'SANDBOX' | 'PRODUCTION';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, x-kcb-signature",
};

/**
 * Resolves the KCB/M-Pesa provider environment from trusted server-side config.
 * NEVER derives this from the callback payload itself — the payload is untrusted.
 * Defaults to SANDBOX if environment cannot be determined (fail-safe).
 *
 * M-Pesa Express inherits the environment of the KCB BUNI integration layer.
 */
function resolveProviderEnvironment(): FinancialEnvironment {
  const baseUrl = (Deno.env.get('KCB_BUNI_BASE_URL') || '').toLowerCase();
  if (baseUrl.includes('api.kcb.co.ke') && !baseUrl.includes('sandbox')) return 'PRODUCTION';
  return 'SANDBOX'; // sandbox, uat, unknown → SANDBOX (fail-safe)
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // Resolve provider environment from trusted server-side KCB configuration.
  // This is NEVER derived from the incoming callback payload.
  const providerEnvironment: FinancialEnvironment = resolveProviderEnvironment();

  try {
    const rawBody = await req.text();
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    let body;
    try { body = JSON.parse(rawBody); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

    // Handle KCB BUNI IPN format: { Body: { stkCallback: { ... } } }
    const stkCallback = body?.Body?.stkCallback || body?.stkCallback || body;
    if (!stkCallback) {
      console.warn("Callback missing stkCallback body:", body);
      return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: "Acknowledged" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const checkoutRequestId = stkCallback.CheckoutRequestID || stkCallback.checkoutRequestId || stkCallback.checkout_request_id;
    const merchantRequestId = stkCallback.MerchantRequestID || stkCallback.merchantRequestId || stkCallback.merchant_request_id;
    const resultCode = stkCallback.ResultCode ?? stkCallback.resultCode;
    const resultDesc = stkCallback.ResultDesc || stkCallback.resultDesc || '';

    let mpesaReceiptNumber: string | null = null;
    let transactionDate: string | null = null;
    const metadata = stkCallback.CallbackMetadata?.Item || stkCallback.callbackMetadata?.Item || [];
    for (const item of metadata) {
      switch (item.Name) {
        case 'MpesaReceiptNumber': mpesaReceiptNumber = String(item.Value || ''); break;
        case 'TransactionDate': transactionDate = String(item.Value || ''); break;
      }
    }

    let status: string;
    if (resultCode === 0 || resultCode === '0') status = 'success';
    else if (resultCode === 1032) status = 'cancelled';
    else if (resultCode === 1001) status = 'timeout';
    else if (resultCode === 1 || resultCode === '1') status = 'insufficient_balance';
    else if (resultCode === 2001) status = 'invalid_pin';
    else status = 'failed';

    // Update kcb_payments by checkout_request_id — fetch environment for validation
    const { data: kcbPayment, error: kcbFetchError } = await supabase
      .from('kcb_payments')
      .select('id, status, transaction_id, environment')
      .eq('checkout_request_id', checkoutRequestId)
      .maybeSingle();

    if (kcbFetchError) {
      console.error("Failed to fetch kcb_payments:", kcbFetchError);
    } else if (kcbPayment) {
      // ============================================================
      // FINANCIAL ENVIRONMENT ISOLATION GATE
      // Enforce: provider_environment == kcb_payment.environment
      // A SANDBOX callback MUST NOT settle a PRODUCTION payment, and vice versa.
      // ============================================================
      const paymentEnvironment: FinancialEnvironment = (kcbPayment.environment as FinancialEnvironment) || 'SANDBOX';
      if (providerEnvironment !== paymentEnvironment) {
        console.error(`[mpesa-callback] ENVIRONMENT MISMATCH REJECTED: provider=${providerEnvironment}, payment=${paymentEnvironment}, checkout=${checkoutRequestId}`);
        // Return ack to prevent KCB retry storm, but produce NO financial settlement.
        return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: "Acknowledged" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Terminal state guard — already settled
      if (kcbPayment.status === 'success') {
        return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: "Success" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      await supabase.from('kcb_payments').update({
        status,
        result_code: String(resultCode ?? ''),
        result_desc: resultDesc,
        mpesa_receipt_number: mpesaReceiptNumber,
        transaction_date: transactionDate,
        callback_received: true,
        callback_payload: body,
        updated_at: new Date().toISOString(),
      }).eq('id', kcbPayment.id).neq('status', 'success');

      console.log("kcb_payments updated:", kcbPayment.id, "status:", status);

      // If successful and linked to a transaction, update it
      if (status === 'success' && kcbPayment.transaction_id) {
        await supabase.from('transactions').update({
          status: 'completed',
          payment_reference: mpesaReceiptNumber,
          updated_at: new Date().toISOString(),
        }).eq('id', kcbPayment.transaction_id);
      }
    }

    // Backward compatibility: also try mpesa_transactions table
    const { data: mpesaTx } = await supabase
      .from('mpesa_transactions')
      .select('id, status, transaction_id, environment')
      .eq('checkout_request_id', checkoutRequestId)
      .maybeSingle();

    if (mpesaTx) {
      // Environment gate for mpesa_transactions
      const mpesaTxEnv: FinancialEnvironment = (mpesaTx.environment as FinancialEnvironment) || 'SANDBOX';
      if (providerEnvironment !== mpesaTxEnv) {
        console.error(`[mpesa-callback] ENVIRONMENT MISMATCH on mpesa_transactions: provider=${providerEnvironment}, tx=${mpesaTxEnv}`);
      } else if (status === 'success' && mpesaTx.transaction_id) {
        await supabase.from('mpesa_transactions').update({
          status,
          result_code: String(resultCode ?? ''),
          result_desc: resultDesc,
          mpesa_receipt_number: mpesaReceiptNumber,
          transaction_date: transactionDate,
          callback_received: true,
          callback_payload: body,
          updated_at: new Date().toISOString(),
        }).eq('id', mpesaTx.id);

        await supabase.from('transactions').update({
          status: 'completed',
          payment_reference: mpesaReceiptNumber,
          updated_at: new Date().toISOString(),
        }).eq('id', mpesaTx.transaction_id);
      }
    }

    return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: "Success" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error("Callback error:", error);
    return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: "Acknowledged" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
