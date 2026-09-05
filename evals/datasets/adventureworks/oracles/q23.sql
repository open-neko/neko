WITH anchor AS (
  SELECT max(orderdate)::date AS anchor_date
  FROM sales.salesorderheader
),
winner AS (
  SELECT
    header.shipmethodid,
    shipmethod.name,
    count(*) AS value
  FROM sales.salesorderheader AS header
  JOIN purchasing.shipmethod AS shipmethod USING (shipmethodid)
  CROSS JOIN anchor
  WHERE header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
  GROUP BY header.shipmethodid, shipmethod.name
  ORDER BY value DESC
  LIMIT 1
)
SELECT
  anchor_date::text,
  (anchor_date - 364)::text AS start_date,
  winner.value::text AS expected_value,
  (
    SELECT count(*)
    FROM sales.salesorderheader
    WHERE shipmethodid = winner.shipmethodid
      AND orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
  )::text AS baseline_value,
  winner.name AS expected_dimension
FROM anchor
CROSS JOIN winner;
