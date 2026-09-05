WITH anchor AS (
  SELECT max(orderdate)::date AS anchor_date
  FROM purchasing.purchaseorderheader
),
winner AS (
  SELECT
    header.vendorid,
    vendor.name,
    sum(header.subtotal + header.taxamt + header.freight) AS value
  FROM purchasing.purchaseorderheader AS header
  JOIN purchasing.vendor AS vendor ON vendor.businessentityid = header.vendorid
  CROSS JOIN anchor
  WHERE header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
  GROUP BY header.vendorid, vendor.name
  ORDER BY value DESC
  LIMIT 1
)
SELECT
  anchor_date::text,
  (anchor_date - 364)::text AS start_date,
  round(winner.value, 2)::text AS expected_value,
  round((
    SELECT sum(subtotal + taxamt + freight)
    FROM purchasing.purchaseorderheader
    WHERE vendorid = winner.vendorid
      AND orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
  ), 2)::text AS baseline_value,
  winner.name AS expected_dimension
FROM anchor
CROSS JOIN winner;
