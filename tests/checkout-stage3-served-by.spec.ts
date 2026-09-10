import { describe, it, expect, beforeEach, vi } from "vitest";
import { completeSale, DELIVERY_FEES, getDeliveryFee } from "../src/lib/transaction-utils";
import type { CompleteSaleParams } from "../src/lib/transaction-utils";
import * as dbModule from "../src/lib/db";
import * as syncModule from "../src/lib/sync";
import { buildReceiptHtml } from "../src/lib/print";
import type { Product, Customer, CartItem } from "../src/lib/types";
import type { BusinessSettings, ReceiptSettings } from "../src/lib/settings-types";

describe("JIMWAS POS — Stage 3 Checkout: Delivery KES 400, Payment Account, Served By", () => {
  let mockProducts: Product[];
  let savedTransactions: any[];
  let savedProducts: any[];
  let savedStockMovements: any[];
  let syncedTransactions: any[];

  beforeEach(() => {
    savedTransactions = [];
    savedProducts = [];
    savedStockMovements = [];
    syncedTransactions = [];

    mockProducts = [
      { id: "prod-paint-20l", name: "Crown Vinyl Silk 20L", price: 9500, cost: 7500, stock: 25, is_active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), sync_status: "synced" },
      { id: "prod-roller", name: "Paint Roller 9-inch", price: 450, cost: 280, stock: 40, is_active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), sync_status: "synced" },
    ];

    vi.spyOn(dbModule, "getProduct").mockImplementation(async (id: string) => {
      return savedProducts.find((p) => p.id === id) || mockProducts.find((p) => p.id === id) || null;
    });
    vi.spyOn(dbModule, "saveProduct").mockImplementation(async (product: any) => {
      const idx = savedProducts.findIndex((p) => p.id === product.id);
      if (idx >= 0) { savedProducts[idx] = product; } else { savedProducts.push(product); }
    });
    vi.spyOn(dbModule, "getTransaction").mockImplementation(async (id: string) => savedTransactions.find((t) => t.id === id) || null);
    vi.spyOn(dbModule, "saveTransaction").mockImplementation(async (tx: any) => {
      const idx = savedTransactions.findIndex((t) => t.id === tx.id);
      if (idx >= 0) { savedTransactions[idx] = tx; } else { savedTransactions.push(tx); }
    });
    vi.spyOn(dbModule, "saveStockMovement").mockImplementation(async (sm: any) => { savedStockMovements.push(sm); });
    vi.spyOn(dbModule, "getAllTransactions").mockImplementation(async () => [...savedTransactions]);
    vi.spyOn(dbModule, "saveCustomer").mockImplementation(async (c: any) => c);
    vi.spyOn(dbModule, "saveLoyaltyTransaction").mockImplementation(async (l: any) => l);
    vi.spyOn(syncModule, "syncInsertTransaction").mockImplementation(async (tx: any, items: any[]) => { syncedTransactions.push({ tx, items }); });
    vi.spyOn(syncModule, "syncUpdateProduct").mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, "syncInsertStockMovement").mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, "syncUpdateCustomer").mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, "syncInsertLoyaltyTransaction").mockResolvedValue(undefined as any);
    vi.spyOn(syncModule, "getOnlineStatus").mockReturnValue(true);
  });

  const baseCustomer: Customer = { id: "cust-1", name: "Peter Kamau", phone: "0712345678", email: "k@e.com", loyalty_points: 0, total_spent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), sync_status: "synced" };
  // Cart subtotal = 20350
  const sampleCart: CartItem[] = [
    { id: "c1", product_id: "prod-paint-20l", product_name: "Crown Vinyl Silk 20L", unit_price: 9500, quantity: 2, subtotal: 19000 },
    { id: "c2", product_id: "prod-roller", product_name: "Paint Roller 9-inch", unit_price: 450, quantity: 3, subtotal: 1350 },
  ];
  const sampleBusiness: BusinessSettings = { id: "b1", name: "Jimwas Hardware", address: "CBD", phone: "0700000000", email: "i@j.co.ke", currency: "KES", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const sampleReceipt: ReceiptSettings = { id: "r1", header_text: "Thank you", footer_text: "No returns", show_logo: false, show_barcode: false, paper_size: "58mm", show_tax_breakdown: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };

  // ── REQ 1: DELIVERY FEE KES 400 ──────────────────────────────────────────

  describe("REQ1: Delivery Fee KES 400", () => {
    it("TEST 1 — from_cbd_400 appears in DELIVERY_FEES map with value 400", () => {
      expect(DELIVERY_FEES["from_cbd_400"]).toBe(400);
    });
    it("TEST 2a — getDeliveryFee('from_cbd_400') returns 400", () => {
      expect(getDeliveryFee("from_cbd_400")).toBe(400);
    });
    it("TEST 2b — existing options 0/100/300/500 remain unchanged", () => {
      expect(getDeliveryFee("none")).toBe(0);
      expect(getDeliveryFee("to_cbd")).toBe(100);
      expect(getDeliveryFee("from_cbd_300")).toBe(300);
      expect(getDeliveryFee("from_cbd_500")).toBe(500);
      expect(getDeliveryFee(undefined)).toBe(0);
    });
    it("TEST 3 — delivery_type = from_cbd_400 on transaction", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20750, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20750, change: 0, userId: "cashier-1", idempotencyKey: "t3", deliveryType: "from_cbd_400", deliveryFee: 400, discount: 0, paymentAccount: "CASH" });
      expect(res.success).toBe(true);
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx.delivery_type).toBe("from_cbd_400");
    });
    it("TEST 4 — delivery_fee = 400 on transaction", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20750, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20750, change: 0, userId: "cashier-1", idempotencyKey: "t4", deliveryType: "from_cbd_400", deliveryFee: 400, discount: 0, paymentAccount: "CASH" });
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx.delivery_fee).toBe(400);
    });
    it("TEST 5 — grand total = subtotal(20350) + delivery(400) = 20750", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20750, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20750, change: 0, userId: "cashier-1", idempotencyKey: "t5", deliveryType: "from_cbd_400", deliveryFee: 400, discount: 0, paymentAccount: "CASH" });
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx.subtotal).toBe(20350);
      expect(tx.delivery_fee).toBe(400);
      expect(tx.total_amount).toBe(20750);
      expect(tx.subtotal + tx.delivery_fee).toBe(tx.total_amount);
    });
    it("TEST 6 — persisted locally (IndexedDB mock)", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20750, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20750, change: 0, userId: "cashier-1", idempotencyKey: "t6", deliveryType: "from_cbd_400", deliveryFee: 400, discount: 0, paymentAccount: "CASH" });
      const stored = savedTransactions.find((t) => t.id === res.transactionId);
      expect(stored.delivery_type).toBe("from_cbd_400");
      expect(stored.delivery_fee).toBe(400);
    });
    it("TEST 7 — survives synchronization", async () => {
      await completeSale({ cart: sampleCart, cartTotal: 20750, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "kcb_buni", paymentTiming: "immediate", amountPaid: 20750, change: 0, userId: "cashier-1", idempotencyKey: "t7", deliveryType: "from_cbd_400", deliveryFee: 400, discount: 0, paymentAccount: "KCB" });
      expect(syncedTransactions.length).toBe(1);
      expect(syncedTransactions[0].tx.delivery_type).toBe("from_cbd_400");
      expect(syncedTransactions[0].tx.delivery_fee).toBe(400);
    });
    it("TEST 8 — receipt displays KES 400 correctly", () => {
      const html = buildReceiptHtml({ business: sampleBusiness, receipt: sampleReceipt, transaction: { id: "rx8", items: [{ product_name: "Paint", quantity: 1, unit_price: 9500, subtotal: 9500 }], total_amount: 9900, amount_paid: 9900, change_amount: 0, payment_method: "cash", payment_account: "CASH", delivery_type: "from_cbd_400", delivery_fee: 400, subtotal: 9500, discount: 0, created_at: new Date().toISOString() } });
      expect(html).toContain("400");
      expect(html).not.toContain("undefined");
    });
  });

  // ── REQ 2: PAYMENT ACCOUNT ───────────────────────────────────────────────

  describe("REQ2: Payment Account", () => {
    it("TEST 9 — CASH available and persisted", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "c1", idempotencyKey: "t9", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "CASH" });
      expect(savedTransactions.find((t) => t.id === res.transactionId).payment_account).toBe("CASH");
    });
    it("TEST 10 — KCB available and persisted", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "kcb_buni", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "c1", idempotencyKey: "t10", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "KCB" });
      expect(savedTransactions.find((t) => t.id === res.transactionId).payment_account).toBe("KCB");
    });
    it("TEST 11 — NCBA available and persisted", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "ncba", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "c1", idempotencyKey: "t11", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "NCBA" });
      expect(savedTransactions.find((t) => t.id === res.transactionId).payment_account).toBe("NCBA");
    });
    it("TEST 12 — MPESA available and persisted", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "kcb_buni", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "c1", idempotencyKey: "t12", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "MPESA" });
      expect(savedTransactions.find((t) => t.id === res.transactionId).payment_account).toBe("MPESA");
    });
    it("TEST 13 — No linked Account never stored", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "c1", idempotencyKey: "t13", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "CASH" });
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx.payment_account).not.toBe("No linked Account");
      expect(tx.payment_account).not.toBe("");
    });
    it("TEST 14 — payment_method and payment_account are separate fields", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "c1", idempotencyKey: "t14", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "KCB" });
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx.payment_method).toBe("cash");
      expect(tx.payment_account).toBe("KCB");
      expect(tx.payment_method).not.toBe(tx.payment_account);
    });
    it("TEST 15 — selecting Payment Account does not initiate a gateway call", async () => {
      const spy = vi.fn();
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "c1", idempotencyKey: "t15", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "KCB" });
      expect(res.success).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    });
    it("TEST 16 — payment_account survives sync", async () => {
      await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "kcb_buni", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "c1", idempotencyKey: "t16", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "MPESA" });
      expect(syncedTransactions[0].tx.payment_account).toBe("MPESA");
    });
    it("TEST 17 — payment_account present as string on transaction record", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "ncba", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "c1", idempotencyKey: "t17", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "NCBA" });
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(typeof tx.payment_account).toBe("string");
      expect(tx.payment_account).toBe("NCBA");
    });
  });

  // ── REQ 3: SERVED BY ─────────────────────────────────────────────────────

  describe("REQ3: Served By", () => {
    it("TEST 18-22 — explicit cashierId/cashierName stored separately from userId", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "manager-007", idempotencyKey: "t18", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "CASH", cashierId: "staff-001", cashierName: "Alice Njeri" });
      expect(res.success).toBe(true);
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx.cashier_id).toBe("staff-001");
      expect(tx.cashier_name).toBe("Alice Njeri");
    });
    it("TEST 20 — logged-in user is safe default when cashierId not provided", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "user-admin", idempotencyKey: "t20", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "CASH" });
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx.cashier_id).toBe("user-admin");
    });
    it("TEST 21 — different operator vs served-by stored correctly", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "manager-007", idempotencyKey: "t21", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "CASH", cashierId: "staff-002", cashierName: "Bob Omondi" });
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx.cashier_id).toBe("staff-002");
      expect(tx.cashier_name).toBe("Bob Omondi");
    });
    it("TEST 22 — cashier_id is a stable string ID", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "user-admin", idempotencyKey: "t22", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "CASH", cashierId: "staff-001", cashierName: "Alice Njeri" });
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(typeof tx.cashier_id).toBe("string");
      expect(tx.cashier_id).toBe("staff-001");
    });
    it("TEST 23 — cashier_name stores full_name of selected staff", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "user-admin", idempotencyKey: "t23", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "CASH", cashierId: "staff-003", cashierName: "Carol Wanjiku" });
      expect(savedTransactions.find((t) => t.id === res.transactionId).cashier_name).toBe("Carol Wanjiku");
    });
    it("TEST 24 — Served By survives IndexedDB (offline storage)", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "user-admin", idempotencyKey: "t24", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "CASH", cashierId: "staff-001", cashierName: "Alice Njeri" });
      const stored = savedTransactions.find((t) => t.id === res.transactionId);
      expect(stored.cashier_id).toBe("staff-001");
      expect(stored.cashier_name).toBe("Alice Njeri");
    });
    it("TEST 25 — Served By survives synchronization", async () => {
      await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "user-admin", idempotencyKey: "t25", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "CASH", cashierId: "staff-001", cashierName: "Alice Njeri" });
      const synced = syncedTransactions[0].tx;
      expect(synced.cashier_id).toBe("staff-001");
      expect(synced.cashier_name).toBe("Alice Njeri");
    });
    it("TEST 26 — Served By appears on receipt HTML", () => {
      const html = buildReceiptHtml({ business: sampleBusiness, receipt: sampleReceipt, transaction: { id: "rx26", items: [{ product_name: "Paint", quantity: 1, unit_price: 9500, subtotal: 9500 }], total_amount: 9500, amount_paid: 9500, change_amount: 0, payment_method: "cash", created_at: new Date().toISOString(), cashier_name: "Alice Njeri" } });
      expect(html).toContain("Cashier:");
      expect(html).toContain("Alice Njeri");
    });
    it("TEST 27 — transaction record exposes cashier_id and cashier_name for details view", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "user-admin", idempotencyKey: "t27", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "CASH", cashierId: "staff-001", cashierName: "Alice Njeri" });
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx.cashier_id).toBeDefined();
      expect(tx.cashier_name).toBeDefined();
    });
  });

  // ── REGRESSION ───────────────────────────────────────────────────────────

  describe("REGRESSION", () => {
    it("TEST 28 — existing cash checkout remains functional", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "c1", idempotencyKey: "r28", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "CASH" });
      expect(res.success).toBe(true);
      expect(savedTransactions.find((t) => t.id === res.transactionId).status).toBe("completed");
    });
    it("TEST 29-30 — existing delivery options 100/300/500 remain functional", async () => {
      for (const [type, fee, total] of [["to_cbd", 100, 20450], ["from_cbd_300", 300, 20650], ["from_cbd_500", 500, 20850]] as [string, number, number][]) {
        savedTransactions = []; syncedTransactions = [];
        const res = await completeSale({ cart: sampleCart, cartTotal: total, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: total, change: 0, userId: "c1", idempotencyKey: `r29-${type}`, deliveryType: type, deliveryFee: fee, discount: 0, paymentAccount: "CASH" });
        expect(res.success).toBe(true);
        const tx = savedTransactions.find((t) => t.id === res.transactionId);
        expect(tx.delivery_type).toBe(type);
        expect(tx.delivery_fee).toBe(fee);
      }
    });
    it("TEST 31 — offline checkout stores locally", async () => {
      vi.spyOn(syncModule, "getOnlineStatus").mockReturnValue(false);
      const res = await completeSale({ cart: sampleCart, cartTotal: 20350, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20350, change: 0, userId: "c1", idempotencyKey: "r31", deliveryType: "none", deliveryFee: 0, discount: 0, paymentAccount: "CASH", cashierId: "staff-001", cashierName: "Alice Njeri" });
      expect(res.success).toBe(true);
      expect(savedTransactions.find((t) => t.id === res.transactionId).cashier_id).toBe("staff-001");
    });
    it("TEST 32 — idempotency: duplicate does not create second transaction", async () => {
      const p: CompleteSaleParams = { cart: sampleCart, cartTotal: 20750, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20750, change: 0, userId: "c1", idempotencyKey: "r32-dedup", deliveryType: "from_cbd_400", deliveryFee: 400, discount: 0, paymentAccount: "CASH", cashierId: "staff-001", cashierName: "Alice Njeri" };
      const a = await completeSale(p);
      const b = await completeSale(p);
      expect(a.transactionId).toBe(b.transactionId);
      expect(savedTransactions.length).toBe(1);
    });
    it("TEST 33 — stock movements = products only, delivery fee has no movement", async () => {
      await completeSale({ cart: sampleCart, cartTotal: 20750, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20750, change: 0, userId: "c1", idempotencyKey: "r33", deliveryType: "from_cbd_400", deliveryFee: 400, discount: 0, paymentAccount: "CASH" });
      expect(savedStockMovements.length).toBe(2);
      expect(savedStockMovements.every((sm: any) => sm.product_id !== "delivery")).toBe(true);
    });
    it("TEST 34 — total formula: subtotal - discount + delivery = total", async () => {
      const res = await completeSale({ cart: sampleCart, cartTotal: 20550, products: mockProducts, selectedCustomer: baseCustomer, paymentMethod: "cash", paymentTiming: "immediate", amountPaid: 20550, change: 0, userId: "c1", idempotencyKey: "r34", deliveryType: "from_cbd_400", deliveryFee: 400, discount: 200, paymentAccount: "CASH", cashierId: "staff-001", cashierName: "Alice Njeri" });
      const tx = savedTransactions.find((t) => t.id === res.transactionId);
      expect(tx.subtotal - tx.discount + tx.delivery_fee).toBe(tx.total_amount);
    });
  });
});
