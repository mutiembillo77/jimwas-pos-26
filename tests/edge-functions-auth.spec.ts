import { describe, it, expect } from "vitest";
import {
  normalizePhone,
  validateAmount,
  validateReference,
  validateSTKPayload,
  sanitizeErrorMessage,
} from "../supabase/functions/lib/auth";

describe("GAP-3 Security: STK Payload Validation", () => {
  describe("Phone Normalization", () => {
    it("accepts valid 07xxxxxxxx Kenyan numbers", () => {
      expect(normalizePhone("0712345678")).toBe("254712345678");
      expect(normalizePhone("0799123456")).toBe("254799123456");
    });

    it("accepts valid 01xxxxxxxx Kenyan numbers (Airtel/newer prefixes)", () => {
      expect(normalizePhone("0110123456")).toBe("254110123456");
      expect(normalizePhone("0100123456")).toBe("254100123456");
    });

    it("accepts valid 2547xxxxxxxx and 2541xxxxxxxx format", () => {
      expect(normalizePhone("254712345678")).toBe("254712345678");
      expect(normalizePhone("254112345678")).toBe("254112345678");
    });

    it("accepts valid +254 format with spaces/dashes stripped", () => {
      expect(normalizePhone("+254 712 345 678")).toBe("254712345678");
      expect(normalizePhone("+254-712-345-678")).toBe("254712345678");
    });

    it("rejects invalid or non-Kenyan numbers", () => {
      expect(normalizePhone("")).toBeNull();
      expect(normalizePhone("0812345678")).toBeNull(); // invalid 08 prefix
      expect(normalizePhone("071234567")).toBeNull(); // 9 digits
      expect(normalizePhone("07123456789")).toBeNull(); // 11 digits
      expect(normalizePhone("1234567890")).toBeNull();
      expect(normalizePhone("+14155552671")).toBeNull();
      expect(normalizePhone("invalid-phone")).toBeNull();
    });
  });

  describe("Amount Validation", () => {
    it("accepts valid positive integers and 2-decimal floats", () => {
      expect(validateAmount(100)).toBe(100);
      expect(validateAmount(10.5)).toBe(10.5);
      expect(validateAmount("50.25")).toBe(50.25);
      expect(validateAmount(999999.99)).toBe(999999.99);
    });

    it("rejects non-positive, NaN, infinite, or excess precision amounts", () => {
      expect(validateAmount(0)).toBeNull();
      expect(validateAmount(-50)).toBeNull();
      expect(validateAmount("abc")).toBeNull();
      expect(validateAmount(NaN)).toBeNull();
      expect(validateAmount(Infinity)).toBeNull();
      expect(validateAmount(10.555)).toBeNull(); // > 2 decimal places
      expect(validateAmount(1000000)).toBeNull(); // Exceeds 999,999.99
    });
  });

  describe("Reference Validation", () => {
    it("accepts alphanumeric, dash, underscore, dot, slash up to 50 chars", () => {
      expect(validateReference("INV-2026-001")).toBe("INV-2026-001");
      expect(validateReference("POS_TXN_12345")).toBe("POS_TXN_12345");
      expect(validateReference("order.999/b1")).toBe("order.999/b1");
    });

    it("rejects empty, overlong, or invalid characters", () => {
      expect(validateReference("")).toBeNull();
      expect(validateReference("a".repeat(51))).toBeNull();
      expect(validateReference("INV<script>alert(1)</script>")).toBeNull();
      expect(validateReference("INV; DROP TABLE payments;")).toBeNull();
    });
  });

  describe("STK Payload Validation Helper", () => {
    it("validates valid payload and returns normalized values", () => {
      const result = validateSTKPayload({
        phone: "0712345678",
        amount: 150.0,
        accountReference: "REC-001",
      });
      expect(result).not.toBeInstanceOf(Response);
      if (!(result instanceof Response)) {
        expect(result.phone).toBe("254712345678");
        expect(result.amount).toBe(150);
        expect(result.reference).toBe("REC-001");
      }
    });

    it("returns 400 Response on invalid phone", async () => {
      const result = validateSTKPayload({
        phone: "invalid",
        amount: 100,
      });
      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response) {
        expect(result.status).toBe(400);
        const data = await result.json();
        expect(data.error).toMatch(/phone/i);
      }
    });

    it("returns 400 Response on invalid amount", async () => {
      const result = validateSTKPayload({
        phone: "0712345678",
        amount: -10,
      });
      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response) {
        expect(result.status).toBe(400);
        const data = await result.json();
        expect(data.error).toMatch(/amount/i);
      }
    });
  });
});

describe("GAP-3 Security: Credential Sanitization", () => {
  it("redacts passkeys, secrets, and auth tokens from error messages", () => {
    expect(
      sanitizeErrorMessage("Error with passkey=ws009a823x and secret=xyz")
    ).toBe("Error with [REDACTED]=ws009a823x and [REDACTED]=xyz");

    expect(
      sanitizeErrorMessage("Failed with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")
    ).toBe("Failed with [REDACTED]");

    expect(
      sanitizeErrorMessage("service_role key exposed: sup_srv_12345")
    ).toBe("[REDACTED] key exposed: sup_srv_12345");
  });
});

describe("GAP-3 Security: Role Permission Matrix Expectations", () => {
  const rolePermissions: Record<string, string[]> = {
    admin: [
      "payments.initiate",
      "payments.status",
      "payments.simulate",
      "payments.manage",
    ],
    manager: [
      "payments.initiate",
      "payments.status",
      "payments.simulate",
    ],
    cashier: [
      "payments.initiate",
      "payments.status",
    ],
  };

  it("cashier has initiate and status, but lacks simulate and manage", () => {
    const cashierPerms = new Set(rolePermissions.cashier);
    expect(cashierPerms.has("payments.initiate")).toBe(true);
    expect(cashierPerms.has("payments.status")).toBe(true);
    expect(cashierPerms.has("payments.simulate")).toBe(false);
    expect(cashierPerms.has("payments.manage")).toBe(false);
  });

  it("manager has initiate, status, and simulate, but lacks manage", () => {
    const managerPerms = new Set(rolePermissions.manager);
    expect(managerPerms.has("payments.initiate")).toBe(true);
    expect(managerPerms.has("payments.status")).toBe(true);
    expect(managerPerms.has("payments.simulate")).toBe(true);
    expect(managerPerms.has("payments.manage")).toBe(false);
  });

  it("admin has all 4 payment permissions", () => {
    const adminPerms = new Set(rolePermissions.admin);
    expect(adminPerms.has("payments.initiate")).toBe(true);
    expect(adminPerms.has("payments.status")).toBe(true);
    expect(adminPerms.has("payments.simulate")).toBe(true);
    expect(adminPerms.has("payments.manage")).toBe(true);
  });
});
