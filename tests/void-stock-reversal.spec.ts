import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Captured state ───────────────────────────────────────────────────────────
const savedMovements: Record<string, unknown>[] = [];
const savedProducts:  Record<string, unknown>[] = [];

let mockTransaction: Record<string, unknown> | null = null;
let mockProducts: Record<string, unknown>[] = [];

// ─── Mock: db ─────────────────────────────────────────────────────────────────
vi.mock("../src/lib/db", () => ({
  generateId: vi.fn(() => "mock-id-" + Math.random().toString(36).slice(2)),
  getTransaction: vi.fn(async () => mockTransaction),
  getAllProducts: vi.fn(async () => mockProducts),
  saveStockMovement: vi.fn(async (m: Record<string, unknown>) => { savedMovements.push({ ...m }); }),
  saveProduct: vi.fn(async (p: Record<string, unknown>) => { savedProducts.push({ ...p }); }),
  saveTransaction: vi.fn().mockResolvedValue(undefined),
  saveApprovalRequest: vi.fn().mockResolvedValue(undefined),
  saveApprovalHistory: vi.fn().mockResolvedValue(undefined),
  saveVoidRequest: vi.fn().mockResolvedValue(undefined),
  saveRefundRequest: vi.fn().mockResolvedValue(undefined),
  getApprovalRequest: vi.fn().mockResolvedValue(null),
  getApprovalRequestsByStatus: vi.fn().mockResolvedValue([]),
  getApprovalRequestsByRequester: vi.fn().mockResolvedValue([]),
  getVoidRequestsByStatus: vi.fn().mockResolvedValue([]),
  getRefundRequestsByStatus: vi.fn().mockResolvedValue([]),
  saveAuditLog: vi.fn().mockResolvedValue(undefined),
  getAllAuditLogs: vi.fn().mockResolvedValue([]),
  getAuditLogsByUser: vi.fn().mockResolvedValue([]),
  getAuditLogsByEntity: vi.fn().mockResolvedValue([]),
  getAuditLogsByEventType: vi.fn().mockResolvedValue([]),
  getUser: vi.fn().mockResolvedValue(null),
}));

// ─── Mock: sync ───────────────────────────────────────────────────────────────
// deterministicUUID and isValidUUID are inlined as pure functions (no external deps).
// Side-effectful functions are spied on.
vi.mock("../src/lib/sync", () => {
  function deterministicUUID(seed: string): string {
    let h1 = 0xdeadbeef, h2 = 0x41c64e6d, h3 = 0x12345678, h4 = 0x87654321;
    for (let i = 0; i < seed.length; i++) {
      const ch = seed.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
      h3 = Math.imul(h3 ^ ch, 3812015801);
      h4 = Math.imul(h4 ^ ch, 2718281829);
    }
    const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
    const raw = hex(h1) + hex(h2) + hex(h3) + hex(h4);
    return `${raw.substring(0,8)}-${raw.substring(8,12)}-4${raw.substring(13,16)}-a${raw.substring(17,20)}-${raw.substring(20,32)}`;
  }
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function isValidUUID(id: string): boolean { return UUID_RE.test(id); }
  return {
    deterministicUUID,
    isValidUUID,
    syncInsertStockMovement: vi.fn(),
    syncUpdateProduct: vi.fn(),
    notifyDataUpdated: vi.fn(),
    queueForSync: vi.fn(),
    syncInsertTransaction: vi.fn(),
    syncInsertAuditLog: vi.fn(),
    syncUpdateApprovalRequest: vi.fn(),
    syncInsertApprovalRequest: vi.fn(),
  };
});

vi.mock("../src/lib/supabaseClient", () => ({ supabase: null }));
vi.mock("../src/lib/auth", () => ({ getCurrentUser: vi.fn().mockResolvedValue(null) }));
vi.mock("../src/lib/permissions", () => ({
  canPerformWithoutApproval: vi.fn().mockResolvedValue(false),
  getUserPermissions: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock("../src/lib/audit", () => ({
  logSaleVoided: vi.fn().mockResolvedValue(undefined),
  logApprovalRequested: vi.fn().mockResolvedValue(undefined),
  logApprovalApproved: vi.fn().mockResolvedValue(undefined),
  logApprovalRejected: vi.fn().mockResolvedValue(undefined),
  logSaleRefunded: vi.fn().mockResolvedValue(undefined),
  logStockAdjusted: vi.fn().mockResolvedValue(undefined),
  logPriceChanged: vi.fn().mockResolvedValue(undefined),
}));

import { voidTransactionDirect } from "../src/lib/approvals";
import { deterministicUUID, isValidUUID, syncInsertStockMovement, syncUpdateProduct } from "../src/lib/sync";
import { saveStockMovement, saveProduct, saveTransaction } from "../src/lib/db";

const TX_ID  = "426da753-1111-4000-8000-000000000001";
const PROD_A = "8ef50f4a-2222-4000-8000-000000000002";
const PROD_B = "8ef50f4a-3333-4000-8000-000000000003";

function makeProduct(id: string, stock: number) {
  return { id, name: `Product-${id.slice(-4)}`, sku: `SKU-${id.slice(-4)}`, price: 100, cost: 60, stock, category: "Test", is_active: true, sync_status: "synced" as const };
}

function makeTransaction(items: { product_id: string; quantity: number }[], status = "completed") {
  return {
    id: TX_ID, status, total_amount: 500, payment_method: "cash",
    items: items.map((it, idx) => ({
      id: `${TX_ID}-item-${idx}`, transaction_id: TX_ID,
      product_id: it.product_id, product_name: `Prod-${it.product_id.slice(-4)}`,
      quantity: it.quantity, unit_price: 100, subtotal: 100 * it.quantity,
    })),
    created_at: new Date().toISOString(), sync_status: "synced" as const,
  };
}

beforeEach(() => {
  savedMovements.length = 0;
  savedProducts.length  = 0;
  mockTransaction = null;
  mockProducts    = [];
  vi.clearAllMocks();
  vi.mocked(saveStockMovement).mockImplementation(async (m: any) => { savedMovements.push({ ...m }); });
  vi.mocked(saveProduct).mockImplementation(async (p: any) => { savedProducts.push({ ...p }); });
});

// TEST 1
describe("Test 1 - Basic single-product replenishment", () => {
  it("restores stock and creates return movement", async () => {
    mockProducts    = [makeProduct(PROD_A, 95)];
    mockTransaction = makeTransaction([{ product_id: PROD_A, quantity: 5 }]);
    const result = await voidTransactionDirect(TX_ID, "Customer returned", "user-admin");
    expect(result.success).toBe(true);
    expect(savedMovements).toHaveLength(1);
    const mv = savedMovements[0] as any;
    expect(mv.qty_delta).toBe(5);
    expect(mv.reason).toBe("return");
    expect(mv.reference_type).toBe("sale");
    expect(mv.reference_id).toBe(TX_ID);
    expect(mv.product_id).toBe(PROD_A);
    expect(mv.balance_after).toBe(100);
    expect(savedProducts).toHaveLength(1);
    expect((savedProducts[0] as any).stock).toBe(100);
    expect(syncInsertStockMovement).toHaveBeenCalledTimes(1);
    expect(syncUpdateProduct).toHaveBeenCalledTimes(1);
  });
});

// TEST 2
describe("Test 2 - Multiple products", () => {
  it("restores each product with one movement each", async () => {
    mockProducts    = [makeProduct(PROD_A, 45), makeProduct(PROD_B, 17)];
    mockTransaction = makeTransaction([{ product_id: PROD_A, quantity: 5 }, { product_id: PROD_B, quantity: 3 }]);
    const result = await voidTransactionDirect(TX_ID, "Duplicate sale", "user-admin");
    expect(result.success).toBe(true);
    expect(savedMovements).toHaveLength(2);
    const mvA = savedMovements.find((m: any) => m.product_id === PROD_A) as any;
    const mvB = savedMovements.find((m: any) => m.product_id === PROD_B) as any;
    expect(mvA.qty_delta).toBe(5);
    expect(mvA.balance_after).toBe(50);
    expect(mvB.qty_delta).toBe(3);
    expect(mvB.balance_after).toBe(20);
    const upA = savedProducts.find((p: any) => p.id === PROD_A) as any;
    const upB = savedProducts.find((p: any) => p.id === PROD_B) as any;
    expect(upA.stock).toBe(50);
    expect(upB.stock).toBe(20);
    expect(syncInsertStockMovement).toHaveBeenCalledTimes(2);
    expect(syncUpdateProduct).toHaveBeenCalledTimes(2);
  });
});

// TEST 3
describe("Test 3 - Double void rejection", () => {
  it("rejects second void without additional movements", async () => {
    mockProducts    = [makeProduct(PROD_A, 95)];
    mockTransaction = makeTransaction([{ product_id: PROD_A, quantity: 5 }]);
    const first = await voidTransactionDirect(TX_ID, "Test void", "user-admin");
    expect(first.success).toBe(true);
    const countAfterFirst = savedMovements.length;
    mockTransaction = { ...makeTransaction([{ product_id: PROD_A, quantity: 5 }]), status: "voided" };
    const second = await voidTransactionDirect(TX_ID, "Duplicate void", "user-admin");
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already voided/i);
    expect(savedMovements.length).toBe(countAfterFirst);
  });
});

// TEST 4
describe("Test 4 - Deterministic UUID / retry idempotency", () => {
  it("movement ID equals deterministicUUID of the canonical seed", async () => {
    mockProducts    = [makeProduct(PROD_A, 95)];
    mockTransaction = makeTransaction([{ product_id: PROD_A, quantity: 5 }]);
    await voidTransactionDirect(TX_ID, "Test", "user-admin");
    const mv = savedMovements[0] as any;
    const expectedId = deterministicUUID(`${TX_ID}-void-${PROD_A}`);
    expect(isValidUUID(mv.id)).toBe(true);
    expect(mv.id).toBe(expectedId);
    expect(mv.id).not.toBe(`${TX_ID}-void-${PROD_A}`);
  });

  it("same UUID produced on retry", async () => {
    mockProducts    = [makeProduct(PROD_A, 95)];
    mockTransaction = makeTransaction([{ product_id: PROD_A, quantity: 5 }]);
    await voidTransactionDirect(TX_ID, "First", "user-admin");
    const firstId = (savedMovements[0] as any).id;
    savedMovements.length = 0;
    mockTransaction = makeTransaction([{ product_id: PROD_A, quantity: 5 }]);
    await voidTransactionDirect(TX_ID, "Retry", "user-admin");
    expect((savedMovements[0] as any).id).toBe(firstId);
  });
});

// TEST 5
describe("Test 5 - Missing transaction_items guard", () => {
  it("rejects void and does not mark transaction voided when items are empty", async () => {
    mockProducts    = [makeProduct(PROD_A, 95)];
    mockTransaction = makeTransaction([]);
    const result = await voidTransactionDirect(TX_ID, "Test", "user-admin");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no line items/i);
    expect(savedMovements).toHaveLength(0);
    expect(savedProducts).toHaveLength(0);
    expect(vi.mocked(saveTransaction)).not.toHaveBeenCalled();
  });
});

// TEST 6
describe("Test 6 - Reversal UUID properties", () => {
  it("generates different UUIDs for different transactions", () => {
    const tx1 = "426da753-1111-4000-8000-000000000001";
    const tx2 = "426da753-2222-4000-8000-000000000001";
    const id1 = deterministicUUID(`${tx1}-void-${PROD_A}`);
    const id2 = deterministicUUID(`${tx2}-void-${PROD_A}`);
    expect(id1).not.toBe(id2);
    expect(isValidUUID(id1)).toBe(true);
    expect(isValidUUID(id2)).toBe(true);
  });
  it("generates different UUIDs for different products", () => {
    const id1 = deterministicUUID(`${TX_ID}-void-${PROD_A}`);
    const id2 = deterministicUUID(`${TX_ID}-void-${PROD_B}`);
    expect(id1).not.toBe(id2);
  });
  it("is deterministic across multiple invocations", () => {
    const seed = `${TX_ID}-void-${PROD_A}`;
    expect(deterministicUUID(seed)).toBe(deterministicUUID(seed));
  });
});

// TEST 7
describe("Test 7 - Sync call verification", () => {
  it("calls syncInsertStockMovement and syncUpdateProduct once per item", async () => {
    mockProducts    = [makeProduct(PROD_A, 45), makeProduct(PROD_B, 17)];
    mockTransaction = makeTransaction([{ product_id: PROD_A, quantity: 5 }, { product_id: PROD_B, quantity: 3 }]);
    await voidTransactionDirect(TX_ID, "Test sync", "user-admin");
    expect(syncInsertStockMovement).toHaveBeenCalledTimes(2);
    expect(syncUpdateProduct).toHaveBeenCalledTimes(2);
    const smCalls = vi.mocked(syncInsertStockMovement).mock.calls;
    const smA = smCalls.find((c) => (c[0] as any).product_id === PROD_A)?.[0] as any;
    const smB = smCalls.find((c) => (c[0] as any).product_id === PROD_B)?.[0] as any;
    expect(smA.qty_delta).toBe(5);  expect(smA.reason).toBe("return");  expect(isValidUUID(smA.id)).toBe(true);
    expect(smB.qty_delta).toBe(3);  expect(smB.reason).toBe("return");  expect(isValidUUID(smB.id)).toBe(true);
    const spCalls = vi.mocked(syncUpdateProduct).mock.calls;
    const spA = spCalls.find((c) => (c[0] as any).id === PROD_A)?.[0] as any;
    const spB = spCalls.find((c) => (c[0] as any).id === PROD_B)?.[0] as any;
    expect(spA.stock).toBe(50);
    expect(spB.stock).toBe(20);
  });
});
