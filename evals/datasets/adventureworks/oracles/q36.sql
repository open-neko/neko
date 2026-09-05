WITH anchor AS (
  SELECT max(startdate)::date AS anchor_date
  FROM production.workorder
),
winner AS (
  SELECT
    workorder.productid,
    product.name,
    count(*) AS value
  FROM production.workorder AS workorder
  JOIN production.product AS product USING (productid)
  CROSS JOIN anchor
  WHERE workorder.startdate::date BETWEEN anchor_date - 364 AND anchor_date
  GROUP BY workorder.productid, product.name
  ORDER BY value DESC
  LIMIT 1
)
SELECT
  anchor_date::text,
  (anchor_date - 364)::text AS start_date,
  winner.value::text AS expected_value,
  (
    SELECT count(*)
    FROM production.workorder
    WHERE productid = winner.productid
      AND startdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
  )::text AS baseline_value,
  winner.name AS expected_dimension
FROM anchor
CROSS JOIN winner;
