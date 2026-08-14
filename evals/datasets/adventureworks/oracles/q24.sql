WITH anchor AS (
  SELECT max(orderdate)::date AS anchor_date
  FROM sales.salesorderheader
),
winner AS (
  SELECT
    territory."group" AS name,
    sum(header.totaldue) AS value
  FROM sales.salesorderheader AS header
  JOIN sales.salesterritory AS territory USING (territoryid)
  CROSS JOIN anchor
  WHERE header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
  GROUP BY territory."group"
  ORDER BY value DESC
  LIMIT 1
)
SELECT
  anchor_date::text,
  (anchor_date - 364)::text AS start_date,
  round(winner.value, 2)::text AS expected_value,
  round((
    SELECT sum(header.totaldue)
    FROM sales.salesorderheader AS header
    JOIN sales.salesterritory AS territory USING (territoryid)
    WHERE territory."group" = winner.name
      AND header.orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
  ), 2)::text AS baseline_value,
  winner.name AS expected_dimension
FROM anchor
CROSS JOIN winner;
