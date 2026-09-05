WITH anchor AS (
  SELECT max(orderdate)::date AS anchor_date
  FROM sales.salesorderheader
)
SELECT
  anchor_date::text,
  (anchor_date - 6)::text AS start_date,
  count(*) FILTER (
    WHERE orderdate::date BETWEEN anchor_date - 6 AND anchor_date
  )::text AS expected_value,
  count(*) FILTER (
    WHERE orderdate::date BETWEEN anchor_date - 13 AND anchor_date - 7
  )::text AS baseline_value,
  NULL::text AS expected_dimension
FROM sales.salesorderheader
CROSS JOIN anchor
GROUP BY anchor_date;
