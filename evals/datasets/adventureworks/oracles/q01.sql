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
GROUP BY anchor_date;
