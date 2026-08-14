WITH anchor AS (
  SELECT max(orderdate)::date AS anchor_date
  FROM purchasing.purchaseorderheader
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
FROM purchasing.purchaseorderheader AS header
JOIN purchasing.purchaseorderdetail AS detail USING (purchaseorderid)
CROSS JOIN anchor
GROUP BY anchor_date;
