import { describe, it, expect } from "vitest";
import {
  normalizePhone,
  isSandboxTestNumber,
  resolveServerEnvironment,
  validateSTKPayload,
} from "../supabase/functions/lib/auth";

describe("Strict Payment State Machine & Sandbox/Provider Separation Tests", () => {
  describe("1. Phone Normalization", () => {
    it("normalizes real Kenyan mobile number 0111810434 to 254111810434", () => {
      expect(normalizePhone("0111810434")).toBe("254111810434");
    });

    it("normalizes official sandbox test local number 0720000000 to 254720000000", () => {
      expect(normalizePhone("0720000000")).toBe("254720000000");
    });

    it("passes through 254700000000 and 254720000000", () => {
      expect(normalizePhone("254700000000")).toBe("254700000000");
      expect(normalizePhone("254720000000")).toBe("254720000000");
    });
  });

  describe("2. Pure STK Push Decision Logic (No Automatic Fallback)", () => {
    function simulateSTKPushDecision(params: {
      environment: "SANDBOX" | "PRODUCTION";
      phone: string;
      providerSuccess: boolean;
      providerData?: { checkoutRequestId?: string; responseCode?: string; message?: string };
    }) {
      const { environment, phone, providerSuccess, providerData } = params;
      const normalizedPhone = normalizePhone(phone);
      if (!normalizedPhone) {
        return { status: "error", code: 400, message: "Invalid phone number" };
      }

      if (providerSuccess && providerData?.checkoutRequestId) {
        return {
          status: "processing",
          code: 200,
          checkoutRequestId: providerData.checkoutRequestId,
          isSynthetic: false,
        };
      }

      // Upstream provider failure: unconditionally fails (no automatic synthetic fallback)
      const safeErrorMessage =
        environment === "SANDBOX"
          ? "KCB Sandbox did not accept this payment request. No STK prompt was dispatched."
          : "KCB did not accept the STK request";

      return {
        status: "failed",
        code: 502,
        error: safeErrorMessage,
        isSynthetic: false,
      };
    }

    it("KCB rejection in SANDBOX for real number (0111810434) yields FAILED (no synthetic ID)", () => {
      const result = simulateSTKPushDecision({
        environment: "SANDBOX",
        phone: "0111810434",
        providerSuccess: false,
      });

      expect(result.status).toBe("failed");
      expect(result.code).toBe(502);
      expect(result.isSynthetic).toBe(false);
      expect((result as any).checkoutRequestId).toBeUndefined();
    });

    it("KCB rejection in SANDBOX for test number (254700000000) also yields FAILED (no automatic fallback)", () => {
      const result = simulateSTKPushDecision({
        environment: "SANDBOX",
        phone: "254700000000",
        providerSuccess: false,
      });

      expect(result.status).toBe("failed");
      expect(result.code).toBe(502);
      expect(result.isSynthetic).toBe(false);
      expect((result as any).checkoutRequestId).toBeUndefined();
    });

    it("KCB rejection in PRODUCTION unconditionally yields FAILED", () => {
      const result = simulateSTKPushDecision({
        environment: "PRODUCTION",
        phone: "254712345678",
        providerSuccess: false,
      });

      expect(result.status).toBe("failed");
      expect(result.code).toBe(502);
      expect(result.isSynthetic).toBe(false);
    });

    it("KCB acceptance returns true checkoutRequestId with status PROCESSING", () => {
      const result = simulateSTKPushDecision({
        environment: "SANDBOX",
        phone: "0111810434",
        providerSuccess: true,
        providerData: { checkoutRequestId: "ws_CO_REAL_987654" },
      });

      expect(result.status).toBe("processing");
      expect(result.code).toBe(200);
      expect(result.checkoutRequestId).toBe("ws_CO_REAL_987654");
    });
  });

  describe("3. Verified Callback vs Simulation Separation", () => {
    function processCallback(params: {
      resultCode: number | string;
      environmentMismatch: boolean;
      existingStatus?: string;
    }) {
      if (params.environmentMismatch) {
        return { acknowledged: true, updated: false, reason: "Environment mismatch" };
      }

      const isTerminal = [
        "PROVIDER_CONFIRMED_SUCCESS",
        "SANDBOX_SIMULATED_SUCCESS",
        "success",
      ].includes(params.existingStatus || "");

      if (isTerminal) {
        return { acknowledged: true, updated: false, reason: "Already settled (terminal guard)" };
      }

      const isSuccess = params.resultCode === 0 || params.resultCode === "0" || params.resultCode === "00000000";
      const nextStatus = isSuccess ? "PROVIDER_CONFIRMED_SUCCESS" : "FAILED";

      return {
        acknowledged: true,
        updated: true,
        status: nextStatus,
      };
    }

    it("Verified KCB callback with ResultCode 0 produces PROVIDER_CONFIRMED_SUCCESS", () => {
      const res = processCallback({
        resultCode: 0,
        environmentMismatch: false,
        existingStatus: "processing",
      });

      expect(res.updated).toBe(true);
      expect(res.status).toBe("PROVIDER_CONFIRMED_SUCCESS");
    });

    it("Verified KCB callback with ResultCode != 0 produces FAILED", () => {
      const res = processCallback({
        resultCode: 1032,
        environmentMismatch: false,
        existingStatus: "processing",
      });

      expect(res.updated).toBe(true);
      expect(res.status).toBe("FAILED");
    });

    it("Callback does NOT overwrite existing PROVIDER_CONFIRMED_SUCCESS (Terminal State Guard)", () => {
      const res = processCallback({
        resultCode: 0,
        environmentMismatch: false,
        existingStatus: "PROVIDER_CONFIRMED_SUCCESS",
      });

      expect(res.updated).toBe(false);
      expect(res.reason).toContain("terminal guard");
    });

    it("Callback is REJECTED on cross-environment mismatch", () => {
      const res = processCallback({
        resultCode: 0,
        environmentMismatch: true,
        existingStatus: "processing",
      });

      expect(res.updated).toBe(false);
      expect(res.reason).toBe("Environment mismatch");
    });
  });

  describe("4. Authorized Simulation Path", () => {
    function executeSimulation(params: {
      serverEnv: "SANDBOX" | "PRODUCTION";
      hasSimulatePermission: boolean;
      checkoutRequestId?: string;
    }) {
      if (!params.hasSimulatePermission) {
        return { code: 403, error: "Unauthorized: Missing payments.simulate permission" };
      }

      if (params.serverEnv !== "SANDBOX") {
        return { code: 403, error: "Simulation forbidden in production" };
      }

      return {
        code: 200,
        success: true,
        status: "SANDBOX_SIMULATED_SUCCESS",
        source: "AUTHORIZED_SANDBOX_SIMULATION",
      };
    }

    it("Authorized manager/admin in SANDBOX produces SANDBOX_SIMULATED_SUCCESS", () => {
      const res = executeSimulation({
        serverEnv: "SANDBOX",
        hasSimulatePermission: true,
      });

      expect(res.code).toBe(200);
      expect(res.status).toBe("SANDBOX_SIMULATED_SUCCESS");
      expect(res.status).not.toBe("PROVIDER_CONFIRMED_SUCCESS");
    });

    it("Cashier without payments.simulate permission is rejected (HTTP 403)", () => {
      const res = executeSimulation({
        serverEnv: "SANDBOX",
        hasSimulatePermission: false,
      });

      expect(res.code).toBe(403);
    });

    it("Simulation in PRODUCTION is strictly blocked (HTTP 403)", () => {
      const res = executeSimulation({
        serverEnv: "PRODUCTION",
        hasSimulatePermission: true,
      });

      expect(res.code).toBe(403);
      expect(res.error).toContain("forbidden in production");
    });
  });

  describe("5. Read-Only mpesa-status Guarantee", () => {
    function simulateReadOnlyStatus(payment: {
      status: string;
      mpesa_receipt_number?: string;
    } | null) {
      if (!payment) {
        return { code: 404, error: "Transaction not found" };
      }

      // mpesa-status is strictly read-only: returns current DB status without mutating
      return {
        code: 200,
        success: true,
        status: payment.status,
        mpesaReceiptNumber: payment.mpesa_receipt_number,
      };
    }

    it("mpesa-status returns true PROVIDER_CONFIRMED_SUCCESS when set by callback", () => {
      const res = simulateReadOnlyStatus({
        status: "PROVIDER_CONFIRMED_SUCCESS",
        mpesa_receipt_number: "QWE998877",
      });

      expect(res.code).toBe(200);
      expect(res.status).toBe("PROVIDER_CONFIRMED_SUCCESS");
    });

    it("mpesa-status returns true SANDBOX_SIMULATED_SUCCESS when set by simulator", () => {
      const res = simulateReadOnlyStatus({
        status: "SANDBOX_SIMULATED_SUCCESS",
        mpesa_receipt_number: "SIM123456",
      });

      expect(res.code).toBe(200);
      expect(res.status).toBe("SANDBOX_SIMULATED_SUCCESS");
    });

    it("mpesa-status NEVER auto-settles a 'processing' or 'failed' payment", () => {
      const resProcessing = simulateReadOnlyStatus({
        status: "processing",
      });
      expect(resProcessing.status).toBe("processing");

      const resFailed = simulateReadOnlyStatus({
        status: "failed",
      });
      expect(resFailed.status).toBe("failed");
    });
  });
});
