import { describe, it, expect } from 'vitest';
import {
  calculateAuthoritativeDashboardKPIs,
  calculateAuthoritativeAnalytics,
  isValidSalesTransaction,
} from '../src/lib/reporting';
import type { Transaction, Customer, Product, CustomerSource } from '../src/lib/types';

describe('JIMWAS POS — Stage 4 Analytics, Fast-Moving Products & Customer Intelligence Suite', () => {
  const mockProducts: Product[] = [
    {
      id: 'prod-paint',
      name: 'Crown Matt Emulsion 20L',
      category: 'Paints & Finishes',
      price: 8500,
      cost: 6500,
      stock: 30,
      is_active: true,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
      sync_status: 'synced',
    },
    {
      id: 'prod-cement',
      name: 'Bamburi Blue Triangle Cement 50kg',
      category: 'Building Materials',
      price: 900,
      cost: 750,
      stock: 200,
      is_active: true,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
      sync_status: 'synced',
    },
    {
      id: 'prod-pipe',
      name: 'PPR Pipe 25mm 4M',
      category: 'Plumbing',
      price: 650,
      cost: 450,
      stock: 80,
      is_active: true,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
      sync_status: 'synced',
    },
    {
      id: 'prod-misc-nails',
      name: 'Concrete Nails 2-inch (kg)',
      // Note: No category specified to test 'Uncategorized' fallback
      price: 250,
      cost: 180,
      stock: 50,
      is_active: true,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
      sync_status: 'synced',
    },
  ];

  const mockCustomers: Customer[] = [
    {
      id: 'cust-walkin',
      name: 'Walk-in John',
      phone: '0711000001',
      customer_source: 'WALK_IN',
      loyalty_points: 0,
      total_spent: 0,
      created_at: '2026-09-01T10:00:00.000Z',
      updated_at: '2026-09-01T10:00:00.000Z',
      sync_status: 'synced',
    },
    {
      id: 'cust-whatsapp',
      name: 'WhatsApp Sarah',
      phone: '0722000002',
      customer_source: 'WHATSAPP',
      loyalty_points: 0,
      total_spent: 0,
      created_at: '2026-09-02T10:00:00.000Z',
      updated_at: '2026-09-02T10:00:00.000Z',
      sync_status: 'synced',
    },
    {
      id: 'cust-facebook',
      name: 'Facebook David',
      phone: '0733000003',
      customer_source: 'FACEBOOK',
      loyalty_points: 0,
      total_spent: 0,
      created_at: '2026-09-03T10:00:00.000Z',
      updated_at: '2026-09-03T10:00:00.000Z',
      sync_status: 'synced',
    },
    {
      id: 'cust-instagram',
      name: 'Instagram Grace',
      phone: '0744000004',
      customer_source: 'INSTAGRAM',
      loyalty_points: 0,
      total_spent: 0,
      created_at: '2026-09-04T10:00:00.000Z',
      updated_at: '2026-09-04T10:00:00.000Z',
      sync_status: 'synced',
    },
    {
      id: 'cust-referral',
      name: 'Referral Michael',
      phone: '0755000005',
      customer_source: 'REFERRAL',
      loyalty_points: 0,
      total_spent: 0,
      created_at: '2026-08-15T10:00:00.000Z', // Created before Sept period (Returning customer)
      updated_at: '2026-08-15T10:00:00.000Z',
      sync_status: 'synced',
    },
    {
      id: 'cust-other',
      name: 'Other Source Peter',
      phone: '0766000006',
      customer_source: 'OTHER',
      loyalty_points: 0,
      total_spent: 0,
      created_at: '2026-09-05T08:00:00.000Z',
      updated_at: '2026-09-05T08:00:00.000Z',
      sync_status: 'synced',
    },
    {
      id: 'cust-unknown',
      name: 'Historical Untagged Mary',
      phone: '0777000007',
      // No customer_source defined -> must default to UNKNOWN
      loyalty_points: 0,
      total_spent: 0,
      created_at: '2026-08-10T10:00:00.000Z',
      updated_at: '2026-08-10T10:00:00.000Z',
      sync_status: 'synced',
    },
  ];

  const analysisDateRange = {
    start: new Date('2026-09-01T00:00:00.000Z'),
    end: new Date('2026-09-05T23:59:59.999Z'),
  };

  // Sample transactions covering all requirements
  const sampleTransactions: Transaction[] = [
    // 1. Walk-in sale: 10 bags cement (KES 9,000) + KES 300 delivery fee
    {
      id: 'tx-001',
      customer_id: 'cust-walkin',
      customer_name: 'Walk-in John',
      customer_phone: '0711000001',
      total_amount: 9300,
      subtotal: 9000,
      discount: 0,
      delivery_fee: 300,
      delivery_type: 'from_cbd_300',
      payment_method: 'cash',
      payment_account: 'CASH',
      status: 'completed',
      created_at: '2026-09-01T11:00:00.000Z',
      sync_status: 'synced',
      items: [
        {
          id: 'item-1',
          product_id: 'prod-cement',
          product_name: 'Bamburi Blue Triangle Cement 50kg',
          quantity: 10,
          unit_price: 900,
          subtotal: 9000,
        },
      ],
    },
    // 2. WhatsApp sale: 2 buckets paint (KES 17,000) + KES 500 delivery fee
    {
      id: 'tx-002',
      customer_id: 'cust-whatsapp',
      customer_name: 'WhatsApp Sarah',
      customer_phone: '0722000002',
      total_amount: 17500,
      subtotal: 17000,
      discount: 0,
      delivery_fee: 500,
      delivery_type: 'from_cbd_500',
      payment_method: 'kcb_buni',
      payment_account: 'MPESA',
      status: 'completed',
      created_at: '2026-09-02T14:30:00.000Z',
      sync_status: 'synced',
      items: [
        {
          id: 'item-2',
          product_id: 'prod-paint',
          product_name: 'Crown Matt Emulsion 20L',
          quantity: 2,
          unit_price: 8500,
          subtotal: 17000,
        },
      ],
    },
    // 3. Facebook sale: 10 pipes (KES 6,500), no delivery
    {
      id: 'tx-003',
      customer_id: 'cust-facebook',
      customer_name: 'Facebook David',
      customer_phone: '0733000003',
      total_amount: 6500,
      subtotal: 6500,
      discount: 0,
      delivery_fee: 0,
      delivery_type: 'none',
      payment_method: 'kcb',
      payment_account: 'KCB',
      status: 'completed',
      created_at: '2026-09-03T09:15:00.000Z',
      sync_status: 'synced',
      items: [
        {
          id: 'item-3',
          product_id: 'prod-pipe',
          product_name: 'PPR Pipe 25mm 4M',
          quantity: 10,
          unit_price: 650,
          subtotal: 6500,
        },
      ],
    },
    // 4. Instagram sale: 4 bags nails (Uncategorized, KES 1,000) + KES 100 delivery fee
    {
      id: 'tx-004',
      customer_id: 'cust-instagram',
      customer_name: 'Instagram Grace',
      customer_phone: '0744000004',
      total_amount: 1100,
      subtotal: 1000,
      discount: 0,
      delivery_fee: 100,
      delivery_type: 'to_cbd',
      payment_method: 'ncba',
      payment_account: 'NCBA',
      status: 'completed',
      created_at: '2026-09-04T12:00:00.000Z',
      sync_status: 'synced',
      items: [
        {
          id: 'item-4',
          product_id: 'prod-misc-nails',
          product_name: 'Concrete Nails 2-inch (kg)',
          quantity: 4,
          unit_price: 250,
          subtotal: 1000,
        },
      ],
    },
    // 5. Referral customer first sale: 1 paint (KES 8,500)
    {
      id: 'tx-005',
      customer_id: 'cust-referral',
      customer_name: 'Referral Michael',
      customer_phone: '0755000005',
      total_amount: 8500,
      subtotal: 8500,
      discount: 0,
      delivery_fee: 0,
      delivery_type: 'none',
      payment_method: 'cash',
      payment_account: 'CASH',
      status: 'completed',
      created_at: '2026-09-04T15:00:00.000Z',
      sync_status: 'synced',
      items: [
        {
          id: 'item-5',
          product_id: 'prod-paint',
          product_name: 'Crown Matt Emulsion 20L',
          quantity: 1,
          unit_price: 8500,
          subtotal: 8500,
        },
      ],
    },
    // 6. Referral customer REPEAT sale: 5 cement bags (KES 4,500) - makes cust-referral a repeat buyer
    {
      id: 'tx-006',
      customer_id: 'cust-referral',
      customer_name: 'Referral Michael',
      customer_phone: '0755000005',
      total_amount: 4500,
      subtotal: 4500,
      discount: 0,
      delivery_fee: 0,
      delivery_type: 'none',
      payment_method: 'kcb_buni',
      payment_account: 'MPESA',
      status: 'completed',
      created_at: '2026-09-05T09:00:00.000Z',
      sync_status: 'synced',
      items: [
        {
          id: 'item-6',
          product_id: 'prod-cement',
          product_name: 'Bamburi Blue Triangle Cement 50kg',
          quantity: 5,
          unit_price: 900,
          subtotal: 4500,
        },
      ],
    },
    // 7. Other source sale: 2 cement (KES 1,800), discount 200 -> total KES 1,600
    {
      id: 'tx-007',
      customer_id: 'cust-other',
      customer_name: 'Other Source Peter',
      customer_phone: '0766000006',
      total_amount: 1600,
      subtotal: 1800,
      discount: 200,
      delivery_fee: 0,
      delivery_type: 'none',
      payment_method: 'cash',
      payment_account: 'CASH',
      status: 'completed',
      created_at: '2026-09-05T10:30:00.000Z',
      sync_status: 'synced',
      items: [
        {
          id: 'item-7',
          product_id: 'prod-cement',
          product_name: 'Bamburi Blue Triangle Cement 50kg',
          quantity: 2,
          unit_price: 900,
          subtotal: 1800,
        },
      ],
    },
    // 8. Historical untagged / unknown source sale: 1 pipe (KES 650)
    {
      id: 'tx-008',
      customer_id: 'cust-unknown',
      customer_name: 'Historical Untagged Mary',
      customer_phone: '0777000007',
      total_amount: 650,
      subtotal: 650,
      discount: 0,
      delivery_fee: 0,
      delivery_type: 'none',
      payment_method: 'cash',
      payment_account: 'CASH',
      status: 'completed',
      created_at: '2026-09-05T11:00:00.000Z',
      sync_status: 'synced',
      items: [
        {
          id: 'item-8',
          product_id: 'prod-pipe',
          product_name: 'PPR Pipe 25mm 4M',
          quantity: 1,
          unit_price: 650,
          subtotal: 650,
        },
      ],
    },
    // 9. Anonymous sale (no customer id): 1 pipe (KES 650)
    {
      id: 'tx-009',
      total_amount: 650,
      subtotal: 650,
      discount: 0,
      delivery_fee: 0,
      delivery_type: 'none',
      payment_method: 'cash',
      payment_account: 'CASH',
      status: 'completed',
      created_at: '2026-09-05T11:30:00.000Z',
      sync_status: 'synced',
      items: [
        {
          id: 'item-9',
          product_id: 'prod-pipe',
          product_name: 'PPR Pipe 25mm 4M',
          quantity: 1,
          unit_price: 650,
          subtotal: 650,
        },
      ],
    },
    // 10. Voided transaction: MUST be excluded
    {
      id: 'tx-voided',
      total_amount: 5000,
      subtotal: 5000,
      delivery_fee: 0,
      payment_method: 'cash',
      status: 'voided',
      created_at: '2026-09-05T12:00:00.000Z',
      sync_status: 'synced',
      items: [
        {
          id: 'item-v',
          product_id: 'prod-cement',
          product_name: 'Bamburi Blue Triangle Cement 50kg',
          quantity: 5,
          unit_price: 1000,
          subtotal: 5000,
        },
      ],
    },
    // 11. Cancelled transaction: MUST be excluded
    {
      id: 'tx-cancelled',
      total_amount: 8500,
      subtotal: 8500,
      delivery_fee: 0,
      payment_method: 'cash',
      status: 'cancelled',
      created_at: '2026-09-05T13:00:00.000Z',
      sync_status: 'synced',
      items: [
        {
          id: 'item-c',
          product_id: 'prod-paint',
          product_name: 'Crown Matt Emulsion 20L',
          quantity: 1,
          unit_price: 8500,
          subtotal: 8500,
        },
      ],
    },
    // 12. Failed transaction: MUST be excluded
    {
      id: 'tx-failed',
      total_amount: 17000,
      subtotal: 17000,
      delivery_fee: 0,
      payment_method: 'kcb_buni',
      status: 'failed',
      created_at: '2026-09-05T14:00:00.000Z',
      sync_status: 'synced',
      items: [
        {
          id: 'item-f',
          product_id: 'prod-paint',
          product_name: 'Crown Matt Emulsion 20L',
          quantity: 2,
          unit_price: 8500,
          subtotal: 17000,
        },
      ],
    },
  ];

  describe('1. Financial KPI Reconciliation', () => {
    it('1. Net Sales matches authoritative reporting exactly', () => {
      const dashboard = calculateAuthoritativeDashboardKPIs(sampleTransactions);
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);

      expect(analytics.kpis.total_sales).toBe(dashboard.totalSales);
      expect(analytics.kpis.total_sales).toBe(9300 + 17500 + 6500 + 1100 + 8500 + 4500 + 1600 + 650 + 650); // 50,300
    });

    it('2. Transaction count matches Dashboard exactly', () => {
      const dashboard = calculateAuthoritativeDashboardKPIs(sampleTransactions);
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);

      expect(analytics.kpis.completed_transactions).toBe(dashboard.totalTransactions);
      expect(analytics.kpis.completed_transactions).toBe(9); // 9 valid, 3 excluded (voided, cancelled, failed)
    });

    it('3. Discounts match Dashboard exactly', () => {
      const dashboard = calculateAuthoritativeDashboardKPIs(sampleTransactions);
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);

      expect(analytics.kpis.total_discounts).toBe(dashboard.totalDiscounts);
      expect(analytics.kpis.total_discounts).toBe(200);
    });

    it('4. Delivery fees match Dashboard exactly', () => {
      const dashboard = calculateAuthoritativeDashboardKPIs(sampleTransactions);
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);

      expect(analytics.kpis.total_delivery_fees).toBe(dashboard.totalDeliveryFees);
      expect(analytics.kpis.total_delivery_fees).toBe(300 + 500 + 100); // 900
    });

    it('5. Average transaction value is correct', () => {
      const dashboard = calculateAuthoritativeDashboardKPIs(sampleTransactions);
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);

      expect(analytics.kpis.average_transaction_value).toBe(dashboard.averageTransactionValue);
      expect(analytics.kpis.average_transaction_value).toBeCloseTo(50300 / 9, 2);
    });
  });

  describe('2. Product Analytics & Fast-Moving Items', () => {
    it('6. Aggregates product units sold accurately', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      const cement = analytics.fast_moving_products.find(p => p.product_id === 'prod-cement');
      const paint = analytics.fast_moving_products.find(p => p.product_id === 'prod-paint');
      const pipe = analytics.fast_moving_products.find(p => p.product_id === 'prod-pipe');
      const nails = analytics.fast_moving_products.find(p => p.product_id === 'prod-misc-nails');

      expect(cement?.units_sold).toBe(10 + 5 + 2); // 17 units
      expect(paint?.units_sold).toBe(2 + 1); // 3 units
      expect(pipe?.units_sold).toBe(10 + 1 + 1); // 12 units
      expect(nails?.units_sold).toBe(4); // 4 units
    });

    it('7. Aggregates product revenue accurately', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      const cement = analytics.fast_moving_products.find(p => p.product_id === 'prod-cement');
      const paint = analytics.fast_moving_products.find(p => p.product_id === 'prod-paint');

      expect(cement?.revenue).toBe(9000 + 4500 + 1800); // 15,300
      expect(paint?.revenue).toBe(17000 + 8500); // 25,500
    });

    it('8. Ranks products correctly by units sold', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      const cement = analytics.fast_moving_products.find(p => p.product_id === 'prod-cement');
      const pipe = analytics.fast_moving_products.find(p => p.product_id === 'prod-pipe');
      const nails = analytics.fast_moving_products.find(p => p.product_id === 'prod-misc-nails');
      const paint = analytics.fast_moving_products.find(p => p.product_id === 'prod-paint');

      // Units: Cement (17) > Pipe (12) > Nails (4) > Paint (3)
      expect(cement?.rank_by_units).toBe(1);
      expect(pipe?.rank_by_units).toBe(2);
      expect(nails?.rank_by_units).toBe(3);
      expect(paint?.rank_by_units).toBe(4);
    });

    it('9. Ranks products correctly by revenue', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      const paint = analytics.fast_moving_products.find(p => p.product_id === 'prod-paint');
      const cement = analytics.fast_moving_products.find(p => p.product_id === 'prod-cement');
      const pipe = analytics.fast_moving_products.find(p => p.product_id === 'prod-pipe');
      const nails = analytics.fast_moving_products.find(p => p.product_id === 'prod-misc-nails');

      // Revenue: Paint (25,500) > Cement (15,300) > Pipe (7,800) > Nails (1,000)
      expect(paint?.rank_by_revenue).toBe(1);
      expect(cement?.rank_by_revenue).toBe(2);
      expect(pipe?.rank_by_revenue).toBe(3);
      expect(nails?.rank_by_revenue).toBe(4);
    });

    it('10. Groups categories and calculates sales shares accurately', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      const paintCat = analytics.category_performance.find(c => c.category === 'Paints & Finishes');
      const buildingCat = analytics.category_performance.find(c => c.category === 'Building Materials');

      expect(paintCat?.revenue).toBe(25500);
      expect(buildingCat?.revenue).toBe(15300);
      expect(paintCat?.sales_share).toBeGreaterThan(buildingCat?.sales_share || 0);
    });

    it('11. Retains uncategorized products in explicit "Uncategorized" bucket', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      const uncat = analytics.category_performance.find(c => c.category === 'Uncategorized');
      expect(uncat).toBeDefined();
      expect(uncat?.units_sold).toBe(4);
      expect(uncat?.revenue).toBe(1000);
    });

    it('12. Strictly excludes delivery fees and delivery items from product analytics', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      // Delivery must NEVER appear in fast_moving_products
      const deliveryProduct = analytics.fast_moving_products.find(p => 
        p.product_id.toLowerCase().includes('delivery') || 
        p.product_name.toLowerCase().includes('delivery')
      );
      expect(deliveryProduct).toBeUndefined();

      // Total merchandise revenue sum must equal subtotal (not sales including delivery)
      const totalProductRevenue = analytics.fast_moving_products.reduce((acc, p) => acc + p.revenue, 0);
      expect(totalProductRevenue).toBe(analytics.kpis.merchandise_subtotal);
      expect(totalProductRevenue).toBe(49600); // 50,300 total sales - 900 delivery + 200 discount
    });

    it('13. Handles zero-sales days accurately in period velocity calculation', () => {
      // Period is Sep 1 to Sep 5 = 5 days
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      expect(analytics.period.total_days).toBe(5);

      const paint = analytics.fast_moving_products.find(p => p.product_id === 'prod-paint');
      // Paint sold on Sep 2 (2 units) and Sep 4 (1 unit) = 3 units total over 5 period days
      // Zero-sales days (Sep 1, Sep 3, Sep 5) must be included in period velocity!
      expect(paint?.velocity_period_days).toBeCloseTo(3 / 5, 2); // 0.60 units/day
    });

    it('14. Calculates both product velocity definitions explicitly', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      const paint = analytics.fast_moving_products.find(p => p.product_id === 'prod-paint');
      // Period days velocity: 3 units / 5 days = 0.6
      expect(paint?.velocity_period_days).toBe(0.6);

      // Active selling days velocity: Paint was sold on 2 active days (Sep 2 and Sep 4)
      // Active days velocity: 3 units / 2 active days = 1.5
      expect(paint?.velocity_active_days).toBe(1.5);
    });
  });

  describe('3. Customer Intelligence', () => {
    it('15. Counts unique transacting customers in period', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      // Active customers: cust-walkin, cust-whatsapp, cust-facebook, cust-instagram, cust-referral, cust-other, cust-unknown (7 customers)
      // Anonymous transaction (tx-009) is not counted as a named unique customer
      expect(analytics.customer_intelligence.unique_customers).toBe(7);
    });

    it('16. Calculates new customers acquired in period', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      // Created between Sep 1 and Sep 5:
      // cust-walkin (Sep 1), cust-whatsapp (Sep 2), cust-facebook (Sep 3), cust-instagram (Sep 4), cust-other (Sep 5)
      // Total = 5 new customers
      expect(analytics.customer_intelligence.new_customers).toBe(5);
    });

    it('17. Calculates returning customers', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      // cust-referral was created in August (Aug 15), cust-unknown in August (Aug 10)
      expect(analytics.customer_intelligence.returning_customers).toBe(2);
    });

    it('18. Calculates repeat customer count and rate (>= 2 qualifying sales)', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      // Only cust-referral had >= 2 transactions (tx-005 and tx-006)
      expect(analytics.customer_intelligence.repeat_customers).toBe(1);
      // Repeat purchase rate: 1 / 7 = 14.3%
      expect(analytics.customer_intelligence.repeat_purchase_rate).toBeCloseTo((1 / 7) * 100, 1);
    });

    it('19. Calculates average customer spend', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      // Total Sales: 50,300 / 7 unique buyers
      expect(analytics.customer_intelligence.average_customer_spend).toBe(Math.round(50300 / 7));
    });

    it('20. Ranks top customers by period revenue contribution', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      
      const top1 = analytics.customer_intelligence.top_customers[0];
      // WhatsApp Sarah spent 17,500; Referral Michael spent 8,500 + 4,500 = 13,000; Walk-in John spent 9,300
      expect(top1.customer_id).toBe('cust-whatsapp');
      expect(top1.total_spent).toBe(17500);
    });
  });

  describe('4. Customer Acquisition & Source Intelligence', () => {
    it('21. Attributes Facebook sales and customer count correctly', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      const fb = analytics.customer_sources.find(s => s.source === 'FACEBOOK');

      expect(fb?.customer_count).toBe(1);
      expect(fb?.transaction_count).toBe(1);
      expect(fb?.sales).toBe(6500);
    });

    it('22. Attributes WhatsApp sales and customer count correctly', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      const wa = analytics.customer_sources.find(s => s.source === 'WHATSAPP');

      expect(wa?.customer_count).toBe(1);
      expect(wa?.transaction_count).toBe(1);
      expect(wa?.sales).toBe(17500);
    });

    it('23. Attributes Instagram sales and customer count correctly', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      const ig = analytics.customer_sources.find(s => s.source === 'INSTAGRAM');

      expect(ig?.customer_count).toBe(1);
      expect(ig?.transaction_count).toBe(1);
      expect(ig?.sales).toBe(1100);
    });

    it('24. Attributes Walk-in sales and customer count correctly', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      const walkin = analytics.customer_sources.find(s => s.source === 'WALK_IN');

      expect(walkin?.customer_count).toBe(1);
      expect(walkin?.transaction_count).toBe(1);
      expect(walkin?.sales).toBe(9300);
    });

    it('25. Attributes Referral sales and repeat transactions correctly', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      const ref = analytics.customer_sources.find(s => s.source === 'REFERRAL');

      expect(ref?.customer_count).toBe(1);
      expect(ref?.transaction_count).toBe(2); // 2 transactions
      expect(ref?.sales).toBe(8500 + 4500); // 13,000
    });

    it('26. Attributes Other source correctly', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      const other = analytics.customer_sources.find(s => s.source === 'OTHER');

      expect(other?.customer_count).toBe(1);
      expect(other?.transaction_count).toBe(1);
      expect(other?.sales).toBe(1600);
    });

    it('27. Maps unrecorded / missing sources to UNKNOWN without error', () => {
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, analysisDateRange);
      const unknown = analytics.customer_sources.find(s => s.source === 'UNKNOWN');

      // cust-unknown (tx-008: 650) + anonymous sale (tx-009: 650)
      expect(unknown?.sales).toBe(1300);
      expect(unknown?.transaction_count).toBe(2);
    });

    it('28. Strict zero-fabrication: Never guesses channels from name or phone', () => {
      // Even if customer name contains 'WhatsApp' or has a phone number, if customer_source is undefined, it is UNKNOWN
      const customCust: Customer = {
        id: 'cust-fake',
        name: 'WhatsApp Fan Guy',
        phone: '0799999999',
        // customer_source missing
        loyalty_points: 0,
        total_spent: 0,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
        sync_status: 'synced',
      };

      const customTx: Transaction = {
        id: 'tx-custom-fake',
        customer_id: 'cust-fake',
        total_amount: 1000,
        subtotal: 1000,
        delivery_fee: 0,
        payment_method: 'cash',
        status: 'completed',
        created_at: '2026-09-01T10:00:00.000Z',
        sync_status: 'synced',
        items: [{ id: 'it', product_id: 'prod-cement', product_name: 'Cement', quantity: 1, unit_price: 1000, subtotal: 1000 }],
      };

      const analytics = calculateAuthoritativeAnalytics([customTx], [customCust], mockProducts, analysisDateRange);
      const wa = analytics.customer_sources.find(s => s.source === 'WHATSAPP');
      const unk = analytics.customer_sources.find(s => s.source === 'UNKNOWN');

      expect(wa?.sales).toBe(0); // MUST NOT attribute to WhatsApp!
      expect(unk?.sales).toBe(1000); // Strictly UNKNOWN
    });
  });

  describe('5. Transaction States', () => {
    it('29. Completed transactions are included in sales and product units', () => {
      const completedTx: Transaction = {
        id: 'tx-comp',
        total_amount: 2000,
        subtotal: 2000,
        delivery_fee: 0,
        payment_method: 'cash',
        status: 'completed',
        created_at: '2026-09-01T10:00:00.000Z',
        sync_status: 'synced',
        items: [{ id: 'it1', product_id: 'prod-cement', product_name: 'Cement', quantity: 2, unit_price: 1000, subtotal: 2000 }],
      };

      expect(isValidSalesTransaction(completedTx)).toBe(true);
      const analytics = calculateAuthoritativeAnalytics([completedTx], [], mockProducts, analysisDateRange);
      expect(analytics.kpis.completed_transactions).toBe(1);
      expect(analytics.kpis.total_sales).toBe(2000);
    });

    it('30. Pending transactions are handled as valid active sales', () => {
      const pendingTx: Transaction = {
        id: 'tx-pend',
        total_amount: 3000,
        subtotal: 3000,
        delivery_fee: 0,
        payment_method: 'cash',
        status: 'pending',
        created_at: '2026-09-01T10:00:00.000Z',
        sync_status: 'pending',
        items: [{ id: 'it2', product_id: 'prod-cement', product_name: 'Cement', quantity: 3, unit_price: 1000, subtotal: 3000 }],
      };

      expect(isValidSalesTransaction(pendingTx)).toBe(true);
      const analytics = calculateAuthoritativeAnalytics([pendingTx], [], mockProducts, analysisDateRange);
      expect(analytics.kpis.completed_transactions).toBe(1);
      expect(analytics.kpis.total_sales).toBe(3000);
    });

    it('31. Failed transactions are excluded from analytics', () => {
      const failedTx: Transaction = {
        id: 'tx-fail',
        total_amount: 5000,
        subtotal: 5000,
        delivery_fee: 0,
        payment_method: 'kcb_buni',
        status: 'failed',
        created_at: '2026-09-01T10:00:00.000Z',
        sync_status: 'synced',
        items: [{ id: 'it3', product_id: 'prod-cement', product_name: 'Cement', quantity: 5, unit_price: 1000, subtotal: 5000 }],
      };

      expect(isValidSalesTransaction(failedTx)).toBe(false);
      const analytics = calculateAuthoritativeAnalytics([failedTx], [], mockProducts, analysisDateRange);
      expect(analytics.kpis.completed_transactions).toBe(0);
      expect(analytics.kpis.total_sales).toBe(0);
      expect(analytics.fast_moving_products.length).toBe(0);
    });

    it('32. Voided transactions are excluded from analytics', () => {
      const voidedTx: Transaction = {
        id: 'tx-void',
        total_amount: 7000,
        subtotal: 7000,
        delivery_fee: 0,
        payment_method: 'cash',
        status: 'voided',
        created_at: '2026-09-01T10:00:00.000Z',
        sync_status: 'synced',
        items: [{ id: 'it4', product_id: 'prod-cement', product_name: 'Cement', quantity: 7, unit_price: 1000, subtotal: 7000 }],
      };

      expect(isValidSalesTransaction(voidedTx)).toBe(false);
      const analytics = calculateAuthoritativeAnalytics([voidedTx], [], mockProducts, analysisDateRange);
      expect(analytics.kpis.completed_transactions).toBe(0);
      expect(analytics.kpis.total_sales).toBe(0);
    });

    it('33. Cancelled transactions are excluded from analytics', () => {
      const cancelledTx: Transaction = {
        id: 'tx-canc',
        total_amount: 8000,
        subtotal: 8000,
        delivery_fee: 0,
        payment_method: 'cash',
        status: 'cancelled',
        created_at: '2026-09-01T10:00:00.000Z',
        sync_status: 'synced',
        items: [{ id: 'it5', product_id: 'prod-cement', product_name: 'Cement', quantity: 8, unit_price: 1000, subtotal: 8000 }],
      };

      expect(isValidSalesTransaction(cancelledTx)).toBe(false);
      const analytics = calculateAuthoritativeAnalytics([cancelledTx], [], mockProducts, analysisDateRange);
      expect(analytics.kpis.completed_transactions).toBe(0);
      expect(analytics.kpis.total_sales).toBe(0);
    });
  });

  describe('6. Date Periods & Filtering', () => {
    it('34. Calculates single-day Today period correctly (total_days = 1)', () => {
      const singleDayRange = {
        start: new Date('2026-09-05T00:00:00.000Z'),
        end: new Date('2026-09-05T23:59:59.999Z'),
      };
      const dayTxs = sampleTransactions.filter(tx => tx.created_at.startsWith('2026-09-05'));
      const analytics = calculateAuthoritativeAnalytics(dayTxs, mockCustomers, mockProducts, singleDayRange);

      expect(analytics.period.total_days).toBe(1);
      const pipe = analytics.fast_moving_products.find(p => p.product_id === 'prod-pipe');
      // Pipe sold 2 units on Sep 5 (tx-008 and tx-009)
      expect(pipe?.units_sold).toBe(2);
      expect(pipe?.velocity_period_days).toBe(2); // 2 / 1 day
    });

    it('35. Calculates Week period correctly (total_days = 7)', () => {
      const weekRange = {
        start: new Date('2026-08-30T00:00:00.000Z'),
        end: new Date('2026-09-05T23:59:59.999Z'),
      };
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, weekRange);
      expect(analytics.period.total_days).toBe(7);
    });

    it('36. Calculates Month period correctly', () => {
      const monthRange = {
        start: new Date('2026-09-01T00:00:00.000Z'),
        end: new Date('2026-09-30T23:59:59.999Z'),
      };
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, monthRange);
      expect(analytics.period.total_days).toBe(30);
    });

    it('37. Calculates custom date ranges correctly', () => {
      const customRange = {
        start: new Date('2026-09-02T00:00:00.000Z'),
        end: new Date('2026-09-04T23:59:59.999Z'),
      };
      const analytics = calculateAuthoritativeAnalytics(sampleTransactions, mockCustomers, mockProducts, customRange);
      expect(analytics.period.total_days).toBe(3);
    });

    it('38. Calculates full 31-day August period without omitting zero-sales days', () => {
      const augustRange = {
        start: new Date('2026-08-01T00:00:00.000Z'),
        end: new Date('2026-08-31T23:59:59.999Z'),
      };
      // 1 single transaction on Aug 15: 31 units
      const singleAugTx: Transaction = {
        id: 'tx-aug-15',
        total_amount: 31000,
        subtotal: 31000,
        delivery_fee: 0,
        payment_method: 'cash',
        status: 'completed',
        created_at: '2026-08-15T12:00:00.000Z',
        sync_status: 'synced',
        items: [{ id: 'aug-it', product_id: 'prod-cement', product_name: 'Cement', quantity: 31, unit_price: 1000, subtotal: 31000 }],
      };

      const analytics = calculateAuthoritativeAnalytics([singleAugTx], mockCustomers, mockProducts, augustRange);
      expect(analytics.period.total_days).toBe(31);

      const cement = analytics.fast_moving_products.find(p => p.product_id === 'prod-cement');
      // Velocity over 31 days: 31 units / 31 days = 1.0 unit/day
      expect(cement?.velocity_period_days).toBe(1.0);
      // Active days velocity: 31 units / 1 active day = 31.0 units/active day
      expect(cement?.velocity_active_days).toBe(31.0);
    });
  });

  describe('7. Offline & Sync Resilience', () => {
    it('39. Offline transactions appear accurately in analytics derivations', () => {
      const offlineTx: Transaction = {
        id: 'tx-offline-1',
        total_amount: 5000,
        subtotal: 5000,
        delivery_fee: 0,
        payment_method: 'cash',
        status: 'completed',
        created_at: '2026-09-05T15:00:00.000Z',
        sync_status: 'pending', // offline pending sync
        items: [{ id: 'off-it', product_id: 'prod-cement', product_name: 'Cement', quantity: 5, unit_price: 1000, subtotal: 5000 }],
      };

      const analytics = calculateAuthoritativeAnalytics([offlineTx], mockCustomers, mockProducts, analysisDateRange);
      expect(analytics.kpis.completed_transactions).toBe(1);
      expect(analytics.kpis.total_sales).toBe(5000);
      expect(analytics.fast_moving_products[0].units_sold).toBe(5);
    });

    it('40. Synced transactions appear accurately without disruption', () => {
      const syncedTx: Transaction = {
        id: 'tx-synced-1',
        total_amount: 4000,
        subtotal: 4000,
        delivery_fee: 0,
        payment_method: 'cash',
        status: 'completed',
        created_at: '2026-09-05T15:30:00.000Z',
        sync_status: 'synced',
        items: [{ id: 'sync-it', product_id: 'prod-cement', product_name: 'Cement', quantity: 4, unit_price: 1000, subtotal: 4000 }],
      };

      const analytics = calculateAuthoritativeAnalytics([syncedTx], mockCustomers, mockProducts, analysisDateRange);
      expect(analytics.kpis.completed_transactions).toBe(1);
      expect(analytics.kpis.total_sales).toBe(4000);
    });

    it('41. Duplicate transaction ids do not corrupt customer or source sets', () => {
      const txA: Transaction = {
        id: 'tx-unique-1',
        customer_id: 'cust-walkin',
        total_amount: 1000,
        subtotal: 1000,
        delivery_fee: 0,
        payment_method: 'cash',
        status: 'completed',
        created_at: '2026-09-05T16:00:00.000Z',
        sync_status: 'synced',
        items: [{ id: 'it-a', product_id: 'prod-cement', product_name: 'Cement', quantity: 1, unit_price: 1000, subtotal: 1000 }],
      };

      const analytics = calculateAuthoritativeAnalytics([txA, txA], mockCustomers, mockProducts, analysisDateRange);
      // Even if feed contains duplicated record, the items transaction_ids Set tracks distinct transactions
      const cement = analytics.fast_moving_products.find(p => p.product_id === 'prod-cement');
      expect(cement?.transaction_count).toBe(1);
    });
  });
});
