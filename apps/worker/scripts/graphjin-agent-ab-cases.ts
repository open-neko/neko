import type { MetricAgentInput, TimeWindowGrain } from "@neko/llm";

export type GraphjinAbMetricType =
  | "count"
  | "currency"
  | "decimal"
  | "percent";

export type GraphjinAbCaseDefinition = Pick<
  MetricAgentInput,
  "role" | "slug" | "title" | "why" | "chartHint"
> & {
  id: `q${string}`;
  category: string;
  difficulty: "filter" | "aggregate" | "join" | "grouped-rank";
  metricType: GraphjinAbMetricType;
  expectedGrain: TimeWindowGrain;
  maxRelativeError: number;
  groundTruthSql: string;
};

const ONE_PERCENT = 0.01;

/**
 * Twenty deterministic AdventureWorks questions for comparing OpenNeko's
 * direct GraphQL data path with GraphJin's built-in server agent.
 *
 * Every SQL statement returns one row with the same five columns:
 *   anchor_date, start_date, expected_value, baseline_value,
 *   expected_dimension.
 *
 * The SQL is used only by the host-side evaluator. Neither experiment arm
 * receives it.
 */
export const GRAPHJIN_AB_CASES: readonly GraphjinAbCaseDefinition[] = [
  {
    id: "q01",
    category: "sales-date-window",
    difficulty: "filter",
    metricType: "count",
    role: "CFO",
    slug: "order-volume-trend",
    title: "Trailing 12-month total order count",
    why:
      "Anchor to the latest sales.salesorderheader.orderdate in live data. The single headline number must be the count of sales orders in the inclusive 365-calendar-day window ending on that date. Compare it with the immediately preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        count(*) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        )::text AS expected_value,
        count(*) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q02",
    category: "sales-date-boundary",
    difficulty: "filter",
    metricType: "count",
    role: "COO",
    slug: "latest-sales-day-orders",
    title: "Orders placed on the latest sales date",
    why:
      "Find the latest sales.salesorderheader.orderdate in live data. The single headline number must be the count of orders whose orderdate is exactly that calendar date, including every timestamp on that date. Compare it with the immediately preceding calendar day.",
    chartHint: "kpi",
    expectedGrain: "day",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        anchor_date::text AS start_date,
        count(*) FILTER (
          WHERE orderdate::date = anchor_date
        )::text AS expected_value,
        count(*) FILTER (
          WHERE orderdate::date = anchor_date - 1
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q03",
    category: "sales-date-window",
    difficulty: "filter",
    metricType: "count",
    role: "COO",
    slug: "last-30-days-orders",
    title: "Order count in the latest 30 calendar days",
    why:
      "Anchor to the latest sales.salesorderheader.orderdate. The single headline number must count orders in the inclusive 30-calendar-day window from anchor minus 29 days through the anchor. Compare it with the immediately preceding non-overlapping 30-day window.",
    chartHint: "kpi",
    expectedGrain: "month",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 29)::text AS start_date,
        count(*) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 29 AND anchor_date
        )::text AS expected_value,
        count(*) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 59 AND anchor_date - 30
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q04",
    category: "sales-aggregate",
    difficulty: "aggregate",
    metricType: "currency",
    role: "CFO",
    slug: "ttm-gross-sales",
    title: "Trailing 12-month gross sales billed",
    why:
      "Anchor to the latest sales.salesorderheader.orderdate. The single headline number must be the sum of salesorderheader.totaldue, including tax and freight, in the inclusive 365-day window ending on the anchor. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        round(sum(totaldue) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        ), 2)::text AS expected_value,
        round(sum(totaldue) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        ), 2)::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q05",
    category: "sales-aggregate",
    difficulty: "aggregate",
    metricType: "currency",
    role: "CFO",
    slug: "ttm-average-order-value",
    title: "Trailing 12-month average order value",
    why:
      "Anchor to the latest sales.salesorderheader.orderdate. The single headline number must be the average salesorderheader.totaldue per order in the inclusive 365-day window ending on the anchor. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        round(avg(totaldue) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        ), 2)::text AS expected_value,
        round(avg(totaldue) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        ), 2)::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q06",
    category: "sales-distinct",
    difficulty: "aggregate",
    metricType: "count",
    role: "CRO",
    slug: "ttm-purchasing-customers",
    title: "Distinct customers purchasing in the trailing 12 months",
    why:
      "Anchor to the latest sales.salesorderheader.orderdate. The single headline number must be the distinct count of salesorderheader.customerid in the inclusive 365-day window ending on the anchor. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        count(DISTINCT customerid) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        )::text AS expected_value,
        count(DISTINCT customerid) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q07",
    category: "sales-boolean-filter",
    difficulty: "filter",
    metricType: "count",
    role: "CRO",
    slug: "ttm-online-order-count",
    title: "Online orders in the trailing 12 months",
    why:
      "Anchor to the latest sales.salesorderheader.orderdate. The single headline number must count rows where salesorderheader.onlineorderflag is true in the inclusive 365-day window ending on the anchor. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        count(*) FILTER (
          WHERE onlineorderflag
            AND orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        )::text AS expected_value,
        count(*) FILTER (
          WHERE onlineorderflag
            AND orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q08",
    category: "sales-ratio",
    difficulty: "aggregate",
    metricType: "percent",
    role: "CRO",
    slug: "ttm-online-order-share",
    title: "Online share of trailing 12-month orders",
    why:
      "Anchor to the latest sales.salesorderheader.orderdate. The single headline number must be 100 times the count of rows with onlineorderflag=true divided by all orders in the inclusive 365-day window ending on the anchor. Report percentage points and compare with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        round(
          100.0 * count(*) FILTER (
            WHERE onlineorderflag
              AND orderdate::date BETWEEN anchor_date - 364 AND anchor_date
          ) / nullif(count(*) FILTER (
            WHERE orderdate::date BETWEEN anchor_date - 364 AND anchor_date
          ), 0),
          4
        )::text AS expected_value,
        round(
          100.0 * count(*) FILTER (
            WHERE onlineorderflag
              AND orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
          ) / nullif(count(*) FILTER (
            WHERE orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
          ), 0),
          4
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q09",
    category: "sales-aggregate",
    difficulty: "aggregate",
    metricType: "currency",
    role: "CFO",
    slug: "ttm-sales-subtotal",
    title: "Trailing 12-month sales subtotal before tax and freight",
    why:
      "Anchor to the latest sales.salesorderheader.orderdate. The single headline number must be the sum of salesorderheader.subtotal, excluding tax and freight, in the inclusive 365-day window ending on the anchor. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        round(sum(subtotal) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        ), 2)::text AS expected_value,
        round(sum(subtotal) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        ), 2)::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q10",
    category: "sales-aggregate",
    difficulty: "aggregate",
    metricType: "currency",
    role: "COO",
    slug: "ttm-freight-charges",
    title: "Trailing 12-month freight charges",
    why:
      "Anchor to the latest sales.salesorderheader.orderdate. The single headline number must be the sum of salesorderheader.freight in the inclusive 365-day window ending on the anchor. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        round(sum(freight) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        ), 2)::text AS expected_value,
        round(sum(freight) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        ), 2)::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q11",
    category: "sales-header-detail",
    difficulty: "join",
    metricType: "count",
    role: "COO",
    slug: "ttm-units-sold",
    title: "Units sold in the trailing 12 months",
    why:
      "Join sales.salesorderdetail to sales.salesorderheader by salesorderid and anchor to the latest header orderdate. The single headline number must be the sum of salesorderdetail.orderqty for orders in the inclusive 365-day window ending on the anchor. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        sum(detail.orderqty) FILTER (
          WHERE header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        )::text AS expected_value,
        sum(detail.orderqty) FILTER (
          WHERE header.orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader AS header
      JOIN sales.salesorderdetail AS detail USING (salesorderid)
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q12",
    category: "sales-header-detail",
    difficulty: "join",
    metricType: "count",
    role: "CPO",
    slug: "ttm-distinct-products-sold",
    title: "Distinct products sold in the trailing 12 months",
    why:
      "Join sales.salesorderdetail to sales.salesorderheader by salesorderid and anchor to the latest header orderdate. The single headline number must be the distinct count of salesorderdetail.productid sold in the inclusive 365-day window ending on the anchor. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        count(DISTINCT detail.productid) FILTER (
          WHERE header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        )::text AS expected_value,
        count(DISTINCT detail.productid) FILTER (
          WHERE header.orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader AS header
      JOIN sales.salesorderdetail AS detail USING (salesorderid)
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q13",
    category: "sales-header-detail",
    difficulty: "join",
    metricType: "decimal",
    role: "COO",
    slug: "ttm-average-lines-per-order",
    title: "Average line items per sales order in the trailing 12 months",
    why:
      "Join sales.salesorderdetail to sales.salesorderheader by salesorderid and anchor to the latest header orderdate. The single headline number must be detail-row count divided by distinct salesorderid count for the inclusive 365-day window ending on the anchor. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        round(
          count(detail.*) FILTER (
            WHERE header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
          )::numeric /
          nullif(count(DISTINCT header.salesorderid) FILTER (
            WHERE header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
          ), 0),
          4
        )::text AS expected_value,
        round(
          count(detail.*) FILTER (
            WHERE header.orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
          )::numeric /
          nullif(count(DISTINCT header.salesorderid) FILTER (
            WHERE header.orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
          ), 0),
          4
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader AS header
      JOIN sales.salesorderdetail AS detail USING (salesorderid)
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q14",
    category: "sales-header-detail",
    difficulty: "join",
    metricType: "count",
    role: "CRO",
    slug: "ttm-discounted-lines",
    title: "Discounted sales line items in the trailing 12 months",
    why:
      "Join sales.salesorderdetail to sales.salesorderheader by salesorderid and anchor to the latest header orderdate. The single headline number must count detail rows with unitpricediscount greater than zero for orders in the inclusive 365-day window ending on the anchor. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        count(*) FILTER (
          WHERE detail.unitpricediscount > 0
            AND header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        )::text AS expected_value,
        count(*) FILTER (
          WHERE detail.unitpricediscount > 0
            AND header.orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader AS header
      JOIN sales.salesorderdetail AS detail USING (salesorderid)
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q15",
    category: "sales-ranking",
    difficulty: "grouped-rank",
    metricType: "currency",
    role: "CRO",
    slug: "top-territory-ttm-revenue",
    title: "Revenue from the top sales territory in the trailing 12 months",
    why:
      "Anchor to the latest sales.salesorderheader.orderdate. Group orders in the inclusive 365-day window by territoryid, rank territories by sum(totaldue), and join sales.salesterritory for the name. The single headline number must be the winning territory's totaldue and the output must name that territory. Compare that same territory with its totaldue in the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      ),
      winner AS (
        SELECT
          header.territoryid,
          territory.name,
          sum(header.totaldue) AS value
        FROM sales.salesorderheader AS header
        LEFT JOIN sales.salesterritory AS territory USING (territoryid)
        CROSS JOIN anchor
        WHERE header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        GROUP BY header.territoryid, territory.name
        ORDER BY value DESC
        LIMIT 1
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        round(winner.value, 2)::text AS expected_value,
        round((
          SELECT sum(totaldue)
          FROM sales.salesorderheader
          WHERE territoryid = winner.territoryid
            AND orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        ), 2)::text AS baseline_value,
        winner.name AS expected_dimension
      FROM anchor
      CROSS JOIN winner
    `,
  },
  {
    id: "q16",
    category: "sales-ranking",
    difficulty: "grouped-rank",
    metricType: "count",
    role: "CPO",
    slug: "top-product-ttm-units",
    title: "Units sold for the top product in the trailing 12 months",
    why:
      "Join sales.salesorderdetail to sales.salesorderheader, anchor to the latest header orderdate, group the inclusive 365-day window by productid, and rank by sum(orderqty). Join production.product for the name. The single headline number must be units for the winning product and the output must name it. Compare that same product's units in the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      ),
      winner AS (
        SELECT
          detail.productid,
          product.name,
          sum(detail.orderqty)::numeric AS value
        FROM sales.salesorderheader AS header
        JOIN sales.salesorderdetail AS detail USING (salesorderid)
        JOIN production.product AS product USING (productid)
        CROSS JOIN anchor
        WHERE header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        GROUP BY detail.productid, product.name
        ORDER BY value DESC
        LIMIT 1
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        winner.value::text AS expected_value,
        (
          SELECT sum(detail.orderqty)::text
          FROM sales.salesorderheader AS header
          JOIN sales.salesorderdetail AS detail USING (salesorderid)
          WHERE detail.productid = winner.productid
            AND header.orderdate::date
              BETWEEN anchor_date - 729 AND anchor_date - 365
        ) AS baseline_value,
        winner.name AS expected_dimension
      FROM anchor
      CROSS JOIN winner
    `,
  },
  {
    id: "q17",
    category: "purchasing-date-window",
    difficulty: "filter",
    metricType: "count",
    role: "COO",
    slug: "ttm-purchase-order-count",
    title: "Purchase orders in the trailing 12 months",
    why:
      "Anchor to the latest purchasing.purchaseorderheader.orderdate. The single headline number must count purchase orders in the inclusive 365-day window ending on that date. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM purchasing.purchaseorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        count(*) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        )::text AS expected_value,
        count(*) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM purchasing.purchaseorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q18",
    category: "purchasing-aggregate",
    difficulty: "aggregate",
    metricType: "currency",
    role: "CFO",
    slug: "ttm-purchase-order-subtotal",
    title: "Purchase order subtotal in the trailing 12 months",
    why:
      "Anchor to the latest purchasing.purchaseorderheader.orderdate. The single headline number must be the sum of purchaseorderheader.subtotal in the inclusive 365-day window ending on that date. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM purchasing.purchaseorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        round(sum(subtotal) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        ), 2)::text AS expected_value,
        round(sum(subtotal) FILTER (
          WHERE orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        ), 2)::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM purchasing.purchaseorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q19",
    category: "purchasing-header-detail",
    difficulty: "join",
    metricType: "decimal",
    role: "COO",
    slug: "ttm-rejected-purchase-units",
    title: "Rejected purchase units in the trailing 12 months",
    why:
      "Join purchasing.purchaseorderdetail to purchasing.purchaseorderheader by purchaseorderid and anchor to the latest header orderdate. The single headline number must be the sum of purchaseorderdetail.rejectedqty for orders in the inclusive 365-day window ending on the anchor. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM purchasing.purchaseorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        round(sum(detail.rejectedqty) FILTER (
          WHERE header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        ), 2)::text AS expected_value,
        round(sum(detail.rejectedqty) FILTER (
          WHERE header.orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        ), 2)::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM purchasing.purchaseorderheader AS header
      JOIN purchasing.purchaseorderdetail AS detail USING (purchaseorderid)
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
  {
    id: "q20",
    category: "production-date-window",
    difficulty: "filter",
    metricType: "count",
    role: "COO",
    slug: "ttm-work-order-count",
    title: "Manufacturing work orders started in the trailing 12 months",
    why:
      "Anchor to the latest production.workorder.startdate. The single headline number must count work orders whose startdate is in the inclusive 365-day window ending on that date. Compare it with the preceding non-overlapping 365-day window.",
    chartHint: "kpi",
    expectedGrain: "year",
    maxRelativeError: ONE_PERCENT,
    groundTruthSql: `
      WITH anchor AS (
        SELECT max(startdate)::date AS anchor_date
        FROM production.workorder
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        count(*) FILTER (
          WHERE startdate::date BETWEEN anchor_date - 364 AND anchor_date
        )::text AS expected_value,
        count(*) FILTER (
          WHERE startdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM production.workorder
      CROSS JOIN anchor
      GROUP BY anchor_date
    `,
  },
];

export function selectGraphjinAbCases(
  rawIds: string | undefined,
): readonly GraphjinAbCaseDefinition[] {
  const requested = rawIds
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!requested?.length) return GRAPHJIN_AB_CASES;

  const byId = new Map(GRAPHJIN_AB_CASES.map((item) => [item.id, item]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown GraphJin A/B case IDs: ${unknown.join(", ")}`);
  }
  return requested.map((id) => byId.get(id)!);
}
