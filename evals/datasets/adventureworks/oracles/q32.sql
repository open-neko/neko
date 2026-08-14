WITH anchor AS (
  SELECT max(orderdate)::date AS anchor_date
  FROM purchasing.purchaseorderheader
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
FROM purchasing.purchaseorderheader
CROSS JOIN anchor
GROUP BY anchor_date;
