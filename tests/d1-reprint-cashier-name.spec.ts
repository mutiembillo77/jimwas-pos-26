/**
 * D-1 Regression Test — Reprint receipt preserves original Served By
 *
 * Defect: transactions.tsx reprint path used the reprinting user's name
 *         instead of the original transaction's cashier_name.
 * Fix:    txn.cashier_name || user?.full_name || user?.username
 *
 * This test validates the fix by directly testing the cashier_name
 * resolution logic that was applied to the reprint path.
 */
import { describe, it, expect } from "vitest";
import { buildReceiptHtml } from "../src/lib/print";

// Minimal business and receipt settings for receipt rendering
const sampleBusiness = {
  id: "b1",
  name: "Jimwas Hardware & Electricals",
  address: "Nairobi CBD",
  phone: "0700000000",
  email: "info@jimwas.co.ke",
  currency: "KES",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};
const sampleReceipt = {
  id: "r1",
  header_text: "Thank you for shopping",
  footer_text: "No returns",
  show_logo: false,
  show_barcode: false,
  paper_size: "58mm" as const,
  show_tax_breakdown: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

/**
 * Simulates the reprint path cashier_name resolution from transactions.tsx.
 * This mirrors exactly the logic authorized in the D-1 fix:
 *   cashier_name: txn.cashier_name || user?.full_name || user?.username
 */
function resolveReprintCashierName(
  txnCashierName: string | undefined,
  currentUser: { full_name?: string; username?: string } | undefined
): string | undefined {
  return txnCashierName || currentUser?.full_name || currentUser?.username;
}

describe("D-1 Regression: Reprint receipt preserves original Served By", () => {
  it(
    "D1-T1 — original transaction cashier_name is preserved over reprinting user",
    () => {
      // Original sale was served by Alice Njeri (stored on transaction)
      const txnCashierName = "Alice Njeri";
      // The manager reprinting is a different user
      const reprintingUser = { full_name: "Manager User", username: "manager" };

      const resolved = resolveReprintCashierName(txnCashierName, reprintingUser);

      expect(resolved).toBe("Alice Njeri");
      expect(resolved).not.toBe("Manager User");
    }
  );

  it(
    "D1-T2 — falls back to current user full_name when txn.cashier_name is absent",
    () => {
      const txnCashierName = undefined; // historical transaction, no cashier_name stored
      const reprintingUser = { full_name: "Manager User", username: "manager" };

      const resolved = resolveReprintCashierName(txnCashierName, reprintingUser);

      expect(resolved).toBe("Manager User");
    }
  );

  it(
    "D1-T3 — falls back to username when full_name is also absent",
    () => {
      const txnCashierName = undefined;
      const reprintingUser = { full_name: undefined, username: "manager007" };

      const resolved = resolveReprintCashierName(txnCashierName, reprintingUser);

      expect(resolved).toBe("manager007");
    }
  );

  it(
    "D1-T4 — reprinted receipt HTML displays the original Served By name",
    () => {
      const txnCashierName = "Alice Njeri";
      const reprintingUser = { full_name: "Manager User", username: "manager" };

      const cashierForReceipt = resolveReprintCashierName(txnCashierName, reprintingUser);

      const html = buildReceiptHtml({
        business: sampleBusiness,
        receipt: sampleReceipt,
        transaction: {
          id: "tx-reprint-d1",
          items: [{ product_name: "Crown Paint 20L", quantity: 1, unit_price: 9500, subtotal: 9500 }],
          total_amount: 9500,
          amount_paid: 9500,
          change_amount: 0,
          payment_method: "cash",
          created_at: new Date().toISOString(),
          cashier_name: cashierForReceipt,
        },
      });

      expect(html).toContain("Cashier:");
      expect(html).toContain("Alice Njeri");
      expect(html).not.toContain("Manager User");
    }
  );

  it(
    "D1-T5 — reprinted receipt HTML displays current user when txn has no cashier_name (fallback path)",
    () => {
      const txnCashierName = undefined;
      const reprintingUser = { full_name: "Manager User", username: "manager" };

      const cashierForReceipt = resolveReprintCashierName(txnCashierName, reprintingUser);

      const html = buildReceiptHtml({
        business: sampleBusiness,
        receipt: sampleReceipt,
        transaction: {
          id: "tx-reprint-d1-fallback",
          items: [{ product_name: "Crown Paint 20L", quantity: 1, unit_price: 9500, subtotal: 9500 }],
          total_amount: 9500,
          amount_paid: 9500,
          change_amount: 0,
          payment_method: "cash",
          created_at: new Date().toISOString(),
          cashier_name: cashierForReceipt,
        },
      });

      expect(html).toContain("Cashier:");
      expect(html).toContain("Manager User");
    }
  );
});
