# JIMWAS POS — Offline-First Point of Sale & Financial Operations Platform

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18.3-61DAFB.svg?logo=react)](https://reactjs.org/)
[![Vite](https://img.shields.io/badge/Vite-5.4-646CFF.svg?logo=vite)](https://vitejs.dev/)
[![Dexie](https://img.shields.io/badge/Dexie.js-v11-brightgreen.svg)](https://dexie.org/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL%20%7C%20Edge%20Functions-3ECF8E.svg?logo=supabase)](https://supabase.com/)
[![Prisma](https://img.shields.io/badge/Prisma-7.9.1-2D3748.svg?logo=prisma)](https://www.prisma.io/)
[![Vitest](https://img.shields.io/badge/Vitest-1.6-FCC72B.svg?logo=vitest)](https://vitest.dev/)
[![Deployment Status](https://img.shields.io/badge/Release%20Gate-GREEN%20%E2%80%94%20READY%20FOR%20PRODUCTION-success)](#current-release-verification)

---

## Executive Summary

**JIMWAS POS** is an enterprise-grade, offline-first point-of-sale and financial operations platform engineered for Kenyan retail, wholesale, and multi-branch operations. Built to thrive in environments with intermittent internet connectivity, JIMWAS POS guarantees seamless transaction processing by combining a high-performance **IndexedDB local datastore (Dexie.js)** with automatic **PostgreSQL synchronization (via Supabase PostgREST)**.

The system natively integrates with the **Kenyan digital financial ecosystem**, featuring automated **KCB Buni M-Pesa STK Push**, serverless asynchronous IPN webhook reconciliation, Cash on Delivery (C.O.D.) lifecycle workflows, inventory reservation, dropshipping fulfillment exemptions, and role-based access control (RBAC).

---

## Architecture Overview

The system employs a multi-tiered architecture that separates the client-side offline execution runtime from asynchronous backend gateway integrations.

```mermaid
graph TD
    subgraph Browser ["Client Runtime (React + Vite SPA)"]
        UI["POS Terminal & Admin UI<br/>(src/routes/pos.tsx)"]
        TX["Transaction Orchestration<br/>(src/lib/transaction-utils.ts)"]
        DEXIE[("Dexie IndexedDB v11<br/>(Local Storage & Queue)")]
        SYNC["Sync Engine<br/>(src/lib/sync.ts)"]
        PROV["Payment Providers<br/>(src/payments/providers/)"]
        
        UI --> TX
        TX --> DEXIE
        TX --> PROV
        DEXIE --> SYNC
    end

    subgraph SupabasePlatform ["Supabase Cloud Platform"]
        POSTGREST["PostgREST API<br/>(Auto Sync Endpoint)"]
        DB[("Supabase PostgreSQL<br/>(Authoritative Database)")]
        STK_FUNC["Edge Function: kcb-stk-push<br/>(Deno Runtime)"]
        IPN_FUNC["Edge Function: kcb-ipn-notification<br/>(Deno Runtime)"]
        
        SYNC -- "HTTPS (Bearer Anon Key)" --> POSTGREST
        POSTGREST --> DB
        PROV -- "invoke('kcb-stk-push')" --> STK_FUNC
        STK_FUNC -- "Service Role" --> DB
        IPN_FUNC -- "Service Role" --> DB
    end

    subgraph ExternalGateways ["External Payment Gateways"]
        KCB_API["KCB Buni M-Pesa Gateway<br/>(Safaricom Daraja / Buni)"]
        
        STK_FUNC -- "HTTPS Client Credentials" --> KCB_API
        KCB_API -- "Asynchronous Callback (IPN)" --> IPN_FUNC
    end
```

> [!IMPORTANT]
> **Runtime Separation:** `PrismaClient`, `PaymentRepository`, `PaymentService`, and `PaymentController` form an isolated server-side abstraction layer. The browser client communicates strictly via `@supabase/supabase-js` and Dexie IndexedDB. Prisma is **not** bundled into the production browser runtime.

---

## Technology Stack

| Layer | Technology | Version | Purpose / Scope |
|---|---|---|---|
| **Frontend Framework** | React | `^18.3.1` | Core declarative UI component architecture |
| **Language** | TypeScript | `^5.5.3` | End-to-end static type safety and contract enforcement |
| **Build & Bundling** | Vite | `^5.4.2` | Fast HMR dev server and optimized Rollup production builds |
| **Local Persistence** | Dexie.js / IndexedDB | `DB_VERSION = 11` | Zero-latency offline transactional storage and queue |
| **Backend & Sync** | Supabase JS | `^2.39.3` | PostgREST communication, Auth, and Edge Function invocation |
| **Database** | PostgreSQL | `15.x` | Authoritative persistence, RLS, partial unique idempotency |
| **Serverless Compute** | Supabase Edge Functions | Deno Runtime | Isolated backend payment dispatching and IPN callback parsing |
| **Schema & Types** | Prisma ORM | `7.9.1` | Database schema representation (`partialIndexes` preview) |
| **Testing Framework** | Vitest | `^1.6.1` | Automated unit, integration, and E2E lifecycle testing |
| **Styling & Icons** | Vanilla CSS + Lucide Icons | `^0.344.0` | High-density POS interface and visual feedback |
| **Static Hosting** | Vercel / GitHub Actions | CI/CD | Production distribution of static `/dist` bundle |

---

## Core Features & Business Workflows

### 1. Point of Sale (POS) Terminal
- **High-Density Product Grid:** Fast product lookup, barcode search, category filtering, and inventory status indicators.
- **Dynamic Cart Management:** Line-item discount calculations, tax adjustments, customer attachment, and loyalty point accrual.
- **Multi-Method Settlement:** Direct handling for Cash, KCB Buni (M-Pesa STK), and Cash on Delivery.

### 2. Offline-First Resilience
- **Zero-Latency Checkout:** Checkouts write immediately to local IndexedDB (`pos-offline-db` v11).
- **Asynchronous Sync Queue:** When internet connection drops, transactions are stored in `sync_queue` and automatically synchronized to PostgreSQL once connectivity is restored.
- **Conflict-Free Serialization:** Checkout queues prevent race conditions and concurrent stock snapshot miscalculations.

### 3. Inventory & Order Fulfillment
- **Immediate Stock Decrement:** Stock is reduced on payment confirmation (`qty_delta = -quantity`) with full `stock_movements` auditing.
- **C.O.D. Stock Reservation:** Immediate physical reservation of stock for outbound deliveries with payment deferred to courier handover.
- **Dropshipping Exemption:** Checkouts designated as `dropshipping` automatically bypass local inventory deductions, deferring physical stock decrement to supplier confirmation.

### 4. Digital Payment Gateway Integration (KCB Buni / M-Pesa)
- **Automatic Phone Formatting:** Automatically standardizes local inputs (`0712...`, `0112...`, `+254...`) into valid `254XXXXXXXXX` format.
- **STK Push Initiation:** Dispatches non-blocking STK prompts directly to customer mobile devices.
- **Asynchronous IPN Settlement:** Serverless Edge Function captures KCB callbacks, resolves payment status (`SUCCESS` / `FAILED`), extracts the official `MpesaReceiptNumber`, and updates database records.
- **Database Idempotency:** PostgreSQL partial unique index prevents duplicate payment records on webhook retries.

### 5. Multi-Branch RBAC & Auditability
- **Granular Role-Based Permissions:** Pre-configured roles (`super_admin`, `admin`, `manager`, `cashier`, `inventory_manager`).
- **Void Request Authorization:** Cashiers can submit transaction void requests requiring manager/admin approval.
- **Audit Logging:** System security logs track price changes, stock adjustments, and administrative approvals.

---

## Payment Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> CheckoutInitiated

    state "Payment Method Selection" as Selection
    CheckoutInitiated --> Selection

    state "CASH (Pay Now)" as CashImmediate {
        Selection --> CashPayNow: method = cash, timing = immediate
        CashPayNow --> DeductStockLocal: Validate Cash Received
        DeductStockLocal --> PersistDexie: amount_paid = total
        PersistDexie --> EnqueueSync: Queue for PostgREST
        EnqueueSync --> CompleteCashSale: Print Receipt
    }

    state "CASH (C.O.D.)" as CashCOD {
        Selection --> CashCodFlow: method = cash, timing = cod
        CashCodFlow --> ReserveStockLocal: Stock Reserved
        ReserveStockLocal --> PersistPendingCOD: amount_paid = 0, cod_status = PENDING
        PersistPendingCOD --> DeliveryDispatch: Outbound Courier
        DeliveryDispatch --> SettleCOD: Delivery Collection
        SettleCOD --> CompleteCODSale: cod_status = COLLECTED
    }

    state "KCB BUNI (Pay Now)" as KcbImmediate {
        Selection --> KcbPayNow: method = kcb_buni, timing = immediate
        KcbPayNow --> NormalizePhone: 254XXXXXXXXX
        NormalizePhone --> EdgeStkPush: invoke('kcb-stk-push')
        EdgeStkPush --> AwaitCallback: merchantRequestId Captured
        AwaitCallback --> IPNReceived: KCB Webhook
        IPNReceived --> ExtractReceipt: mpesa_receipt Saved
        ExtractReceipt --> CompleteKcbSale: Sale Completed
    }

    state "KCB BUNI (C.O.D.)" as KcbCOD {
        Selection --> KcbCodFlow: method = kcb_buni, timing = cod
        KcbCodFlow --> ReserveStockKcb: Stock Reserved (NO STK PUSH)
        ReserveStockKcb --> DeferToDelivery: Payment on Delivery
    }

    state "NCBA (Pending Gateway)" as NcbaFlow {
        Selection --> NcbaCheck: method = ncba
        NcbaCheck --> BlockedPending: PROVIDER_PENDING (Disabled)
    }
```

---

## Database Architecture & Data Contracts

The database uses PostgreSQL with Row Level Security (RLS) policies configured for authenticated users and service roles.

### `public.transactions` (Core Ledger)
Contains reconciled columns for omnichannel payment tracking:

| Column | Type | Nullable | Description |
|---|---|---|---|
| `id` | `text` | No | Primary key (UUID string) |
| `total_amount` | `numeric(12,2)` | No | Total gross cart value |
| `amount_paid` | `numeric(12,2)` | No | Actual amount collected at checkout |
| `change_amount` | `numeric(12,2)` | No | Change returned to customer |
| `payment_method` | `text` | No | `cash`, `kcb_buni`, `ncba` |
| `payment_timing` | `text` | Yes | `immediate` or `cod` |
| `is_cod` | `boolean` | Yes | `true` if transaction is Cash on Delivery |
| `cod_status` | `text` | Yes | `PENDING`, `IN_TRANSIT`, `DELIVERED`, `COLLECTED`, `FAILED` |
| `mpesa_receipt` | `text` | Yes | Official Safaricom/KCB receipt number (e.g. `QGH45XYZ89`) |
| `sale_type` | `text` | Yes | `standard`, `dropshipping`, `installment` |
| `sync_status` | `text` | Yes | Local sync tracker (`pending`, `synced`, `failed`) |

### `public.payment` (Payment Gateway Auditing)
Audit table tracking digital gateway requests and webhooks:

| Column | Type | Index / Constraint | Description |
|---|---|---|---|
| `id` | `uuid` | Primary Key | Auto-generated UUID (`gen_random_uuid()`) |
| `provider` | `text` | — | Provider key (`kcb_buni`, `ncba`, `cash`) |
| `provider_transaction_id`| `text` | — | External gateway transaction reference |
| `merchant_request_id` | `text` | **Partial Unique Index** | Unique correlation ID from STK Push |
| `checkout_request_id` | `text` | — | Gateway checkout reference |
| `phone_number` | `text` | — | Customer MSISDN |
| `amount` | `numeric(12,2)` | — | Transacted amount |
| `invoice_number` | `text` | **Index** | Associated POS receipt / invoice ID |
| `status` | `text` | Default `'PENDING'` | `PENDING`, `SUCCESS`, `FAILED`, `CANCELLED` |
| `transaction_type` | `text` | Default `'PAY_NOW'`| `PAY_NOW`, `COD` |
| `callback_payload` | `jsonb` | — | Full raw webhook JSON response |

### Authoritative Partial Unique Index
```sql
CREATE UNIQUE INDEX idx_payment_merchant_request_id
ON public.payment (merchant_request_id)
WHERE (merchant_request_id IS NOT NULL);
```
**Purpose:** Prevents duplicate transaction creation when external payment gateways send retry callbacks, while cleanly permitting multiple `NULL` entries for cash transactions.

---

## Prisma 7.9.1 Schema Mapping

Prisma is configured in `prisma/schema.prisma` using the `partialIndexes` preview feature to faithfully represent PostgreSQL's partial uniqueness:

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["partialIndexes"]
}

datasource db {
  provider = "postgresql"
}

model payment {
  id                    String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  provider              String
  providerTransactionId String?   @map("provider_transaction_id")
  merchantRequestId     String?   @unique(map: "idx_payment_merchant_request_id", where: raw("(merchant_request_id IS NOT NULL)")) @map("merchant_request_id")
  checkoutRequestId     String?   @map("checkout_request_id")
  phoneNumber           String?   @map("phone_number")
  amount                Decimal   @db.Decimal(12, 2)
  invoiceNumber         String    @map("invoice_number")
  status                String    @default("PENDING")
  transactionType       String?   @default("PAY_NOW") @map("transaction_type")
  callbackPayload       Json?     @map("callback_payload")
  created_at            DateTime? @default(now()) @db.Timestamptz(6)
  updated_at            DateTime? @default(now()) @db.Timestamptz(6)

  @@index([invoiceNumber], map: "idx_payment_invoice_number")
}
```

> [!NOTE]
> **Future Server Runtime:** If a Node.js Express/Fastify API server utilizing `PaymentRepository` is deployed in the future, `@prisma/adapter-pg` and `pg` should be configured as a standalone server-side initiative.

---

## Supabase Edge Functions

| Function Name | Path | Runtime | Purpose |
|---|---|---|---|
| `kcb-stk-push` | [supabase/functions/kcb-stk-push/index.ts](file:///c:/Users/Admin/jimwas-pos-26/supabase/functions/kcb-stk-push/index.ts) | Deno | Authenticates with KCB OAuth API and initiates M-Pesa STK prompts |
| `kcb-ipn-notification` | [supabase/functions/kcb-ipn-notification/index.ts](file:///c:/Users/Admin/jimwas-pos-26/supabase/functions/kcb-ipn-notification/index.ts) | Deno | Receives inbound payment notifications from KCB, parses M-Pesa receipt, updates `kcb_payments` |

---

## Security & Secrets Management

- **Client Separation:** Browser client bundles **only** public environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
- **Secret Isolation:** Payment gateway consumer keys, consumer secrets, passkeys, and Supabase service-role keys are strictly isolated to Supabase Edge Function environment variables.
- **Row Level Security (RLS):** All financial tables (`transactions`, `payment`, `kcb_payments`, `stock_movements`) enforce PostgreSQL RLS policies.
- **Zero Hardcoded Credentials:** No private keys or connection strings are tracked in the Git repository.

---

## Testing & Quality Assurance

The codebase is protected by comprehensive Vitest test suites verifying every layer of the payment and offline ecosystem:

```bash
npx vitest run tests/payment-lifecycle-e2e.test.ts tests/payment-ecosystem.test.ts tests/paymentRepository.test.ts tests/orchestrator/paymentOrchestrator.test.ts tests/kcbBuniService.spec.ts
```

### Verified Test Matrix (30/30 Tests Passing)

| Test Suite | File | Tests | Verified Scope |
|---|---|---|---|
| **E2E Payment Lifecycle** | `tests/payment-lifecycle-e2e.test.ts` | 9 | Cash Pay Now, Cash COD, KCB Pay Now, KCB COD, NCBA Pending, Dropshipping exemption, Idempotency, PostgREST Sync Payload |
| **Payment Ecosystem** | `tests/payment-ecosystem.test.ts` | 13 | Provider factory, Cash provider, KCB Buni provider, NCBA provider mock, phone number normalization |
| **Payment Repository** | `tests/paymentRepository.test.ts` | 4 | Prisma delegation, initiation creation, callback updates, invoice lookups |
| **Payment Orchestration**| `tests/orchestrator/paymentOrchestrator.test.ts`| 2 | Asynchronous queue processing, fallback handling, retry backoff |
| **KCB Service Logic** | `tests/kcbBuniService.spec.ts` | 2 | Payload parsing, STK response mapping |

---

## Environment Variables Specification

| Variable Name | Scope | Required | Description |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Frontend (Browser) | **Yes** | Supabase project URL (e.g. `https://xyz.supabase.co`) |
| `VITE_SUPABASE_ANON_KEY` | Frontend (Browser) | **Yes** | Public anonymous client API key |
| `DIRECT_URL` | Server / CLI | CLI only | Direct PostgreSQL connection string for Prisma CLI tools |
| `DATABASE_URL` | Server / CLI | CLI only | Pooled PostgreSQL connection string for database access |
| `SUPABASE_SERVICE_ROLE_KEY`| Edge Functions (Server) | **Yes** | Elevated key for Edge Function database mutations (**Never expose to frontend**) |
| `KCB_BUNI_CLIENT_ID` | Edge Functions (Server) | **Yes** | KCB Buni OAuth 2.0 application client ID |
| `KCB_BUNI_CLIENT_SECRET`| Edge Functions (Server) | **Yes** | KCB Buni OAuth 2.0 application client secret |
| `KCB_BUNI_SHORT_CODE` | Edge Functions (Server) | **Yes** | Merchant Paybill / Till Number |
| `KCB_BUNI_TOKEN_URL` | Edge Functions (Server) | **Yes** | KCB OAuth token generation endpoint |
| `KCB_BUNI_BASE_URL` | Edge Functions (Server) | **Yes** | KCB API Gateway base endpoint |

---

## Installation & Local Development

### Prerequisites
- **Node.js:** `v20.x` or higher
- **Package Manager:** `npm` (v10+)

### 1. Clone Repository & Install Dependencies
```bash
git clone https://github.com/mutiembillo77/jimwas-pos-26.git
cd jimwas-pos-26
npm install
```

### 2. Environment Configuration
Create a `.env` file in the root directory matching your Supabase project:
```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
DIRECT_URL=postgresql://postgres:password@db.your-project.supabase.co:5432/postgres
```

### 3. Generate Prisma Types
```bash
npx prisma generate
```

### 4. Start Development Server
```bash
npm run dev
```
Access the application at `http://localhost:5173`.

### 5. Execute Tests & Validate Build
```bash
# Run unit & lifecycle tests
npm test

# Verify type safety
npm run typecheck

# Run production build
npm run build
```

---

## Project Directory Structure

```text
jimwas-pos-26/
├── .github/                      # GitHub Actions CI/CD workflows
│   └── workflows/
│       ├── deploy-supabase.yml   # Automated Edge Functions deployment
│       └── release.yml           # Automated GitHub release & static build workflow
├── dist/                         # Compiled production bundle output
├── docs/                         # Technical documentation & operational specifications
├── prisma/                       # Database modeling & schema representation
│   └── schema.prisma             # Introspected schema with partialIndexes & @map bindings
├── public/                       # Static public assets, SVGs, and fallback icons
├── scripts/                      # Deployment, inspection, and verification scripts
│   ├── deploy.mjs                # Supabase Edge Functions deployment script
│   └── validate.mjs              # CI environment validator
├── src/                          # Application source code
│   ├── components/               # Reusable UI components (Modals, ProtectedRoute, Layout)
│   ├── context/                  # Global context providers (AuthContext, CartContext)
│   ├── lib/                      # Core business logic & platform utilities
│   │   ├── db.ts                 # Dexie.js (IndexedDB v11) schema & repository operations
│   │   ├── sync.ts               # PostgREST offline-to-online sync queue & payloads
│   │   ├── transaction-utils.ts  # completeSale() checkout orchestration & stock logic
│   │   └── types.ts              # Core domain models (Transaction, Product, Customer)
│   ├── payments/                 # Modular Payment Ecosystem
│   │   ├── controllers/          # Server controller stubs (PaymentController)
│   │   ├── dto/                  # Data Transfer Objects (PaymentRequest, CallbackPayload)
│   │   ├── orchestrator/         # Payment orchestration & retry strategies
│   │   ├── providers/            # Providers (KCBBuniProvider, CashProvider, NcbaProvider)
│   │   ├── repositories/         # PaymentRepository (Prisma database access layer)
│   │   └── services/             # PaymentService business logic
│   ├── routes/                   # Application pages (POS, Dashboard, Inventory, Settings)
│   │   ├── pos.tsx               # Main POS Terminal & checkout interface
│   │   ├── inventory.tsx         # Real-time inventory & stock movement management
│   │   └── transactions.tsx      # Transaction history & receipt viewing
│   └── types/                    # Payment method constants & enum declarations
├── supabase/                     # Supabase infrastructure configuration
│   └── functions/                # Deno-based Serverless Edge Functions
│       ├── kcb-stk-push/         # KCB Buni M-Pesa STK push dispatcher
│       └── kcb-ipn-notification/# KCB Buni webhook IPN notification receiver
├── tests/                        # Vitest automated test suites
│   ├── payment-lifecycle-e2e.test.ts  # Full lifecycle E2E verification
│   ├── payment-ecosystem.test.ts      # Multi-provider unit tests
│   └── paymentRepository.test.ts      # Database repository tests
├── package.json                  # Project dependencies and script definitions
├── prisma.config.ts              # Prisma 7 CLI configuration
├── vite.config.ts                # Vite build and environment definitions
└── tsconfig.app.json             # TypeScript compiler options
```

---

## Production Change Control Protocols

To maintain high availability and prevent database schema drift in production:

1. **Database Schema Modifications:**
   - Never run `prisma db push` or `prisma migrate reset` against production Supabase databases.
   - All migrations must be additive, review-audited, and executed via verified SQL scripts preserving row counts.
2. **IndexedDB Versioning:**
   - Retain `pos-offline-db` at `DB_VERSION = 11`. Do not bump `DB_VERSION` unless adding a new IndexedDB object store or primary key index.
3. **Payment Provider Isolation:**
   - All new payment gateways must implement `PaymentProvider` interface and register via `PaymentProviderFactory`.
   - Gateways pending commercial contracts must return `PROVIDER_PENDING` and evaluate `isMethodAvailable() === false`.
4. **Pre-Deployment Release Checklist:**
   - [x] Run full test suite (`npm test`) → Must be 100% pass.
   - [x] Run production build (`npm run build`) → Must compile with 0 errors.
   - [x] Confirm clean Git status (`git status --short`).

---

## Current Release Verification

```
══════════════════════════════════════════════════════════════════════
RELEASE STATUS: GREEN — PRODUCTION DEPLOYMENT COMPLETE
══════════════════════════════════════════════════════════════════════
```
- **Automated Tests:** 30/30 Vitest suites passing
- **Production Build:** Verified Vite bundle in `/dist` (5.28s compilation time)
- **Database Schema:** Fully reconciled with `public.transactions` & `public.payment`
- **PostgreSQL Idempotency Index:** Active (`idx_payment_merchant_request_id`)
- **Prisma Representation:** Validated & Generated (Prisma 7.9.1)
- **Git Working Tree:** Clean

---

## Contributing

1. Create a feature branch (`git checkout -b feature/amazing-feature`).
2. Implement your changes adhering to existing TypeScript design patterns.
3. Verify test suite (`npm test`).
4. Build the project locally (`npm run build`).
5. Open a Pull Request for architectural review.

---

## License

This project is proprietary and confidential. All rights reserved.
