WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        round(
          100.0 * count(*) FILTER (
            WHERE onlineorderflag
              AND orderdate::date BETWEEN anchor_date - 364 AND anchor_date
          ) / nullif(count(*) FILTER (
            WHERE orderdate::date BETWEEN anchor_date - 364 AND anchor_date
          ), 0),
          4
        )::text AS expected_value,
        round(
          100.0 * count(*) FILTER (
            WHERE onlineorderflag
              AND orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
          ) / nullif(count(*) FILTER (
            WHERE orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
          ), 0),
          4
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM sales.salesorderheader
      CROSS JOIN anchor
      GROUP BY anchor_date
