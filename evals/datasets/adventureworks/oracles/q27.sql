WITH anchor AS (
  SELECT max(orderdate)::date AS anchor_date
  FROM sales.salesorderheader
)
SELECT
  anchor_date::text,
  (anchor_date - 29)::text AS start_date,
  round(sum(subtotal) FILTER (
    WHERE orderdate::date BETWEEN anchor_date - 29 AND anchor_date
  ), 2)::text AS expected_value,
  round(sum(subtotal) FILTER (
    WHERE orderdate::date BETWEEN anchor_date - 59 AND anchor_date - 30
  ), 2)::text AS baseline_value,
  NULL::text AS expected_dimension
FROM sales.salesorderheader
CROSS JOIN anchor
GROUP BY anchor_date;
