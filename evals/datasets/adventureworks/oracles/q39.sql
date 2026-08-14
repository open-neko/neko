WITH anchor AS (
  SELECT max(orderdate)::date AS anchor_date
  FROM sales.salesorderheader
)
SELECT
  anchor_date::text,
  anchor_date::text AS start_date,
  round(sum(totaldue) FILTER (
    WHERE orderdate::date = anchor_date
  ), 2)::text AS expected_value,
  round(sum(totaldue) FILTER (
    WHERE orderdate::date = anchor_date - 1
  ), 2)::text AS baseline_value,
  NULL::text AS expected_dimension
FROM sales.salesorderheader
CROSS JOIN anchor
GROUP BY anchor_date;
