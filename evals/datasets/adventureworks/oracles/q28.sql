WITH anchor AS (
  SELECT max(orderdate)::date AS anchor_date
  FROM sales.salesorderheader
)
SELECT
  anchor_date::text,
  (anchor_date - 364)::text AS start_date,
  round(sum(totaldue) FILTER (
    WHERE onlineorderflag
      AND orderdate::date BETWEEN anchor_date - 364 AND anchor_date
  ), 2)::text AS expected_value,
  round(sum(totaldue) FILTER (
    WHERE onlineorderflag
      AND orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
  ), 2)::text AS baseline_value,
  NULL::text AS expected_dimension
FROM sales.salesorderheader
CROSS JOIN anchor
GROUP BY anchor_date;
