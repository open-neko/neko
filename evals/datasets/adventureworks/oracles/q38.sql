WITH anchor AS (
  SELECT max(orderdate)::date AS anchor_date
  FROM sales.salesorderheader
)
SELECT
  anchor_date::text,
  (anchor_date - 364)::text AS start_date,
  round((count(*) FILTER (
    WHERE orderdate::date BETWEEN anchor_date - 364 AND anchor_date
  ))::numeric / nullif(count(DISTINCT customerid) FILTER (
    WHERE orderdate::date BETWEEN anchor_date - 364 AND anchor_date
  ), 0), 4)::text AS expected_value,
  round((count(*) FILTER (
    WHERE orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
  ))::numeric / nullif(count(DISTINCT customerid) FILTER (
    WHERE orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
  ), 0), 4)::text AS baseline_value,
  NULL::text AS expected_dimension
FROM sales.salesorderheader
CROSS JOIN anchor
GROUP BY anchor_date;
