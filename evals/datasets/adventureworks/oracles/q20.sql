WITH anchor AS (
        SELECT max(startdate)::date AS anchor_date
        FROM production.workorder
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        count(*) FILTER (
          WHERE startdate::date BETWEEN anchor_date - 364 AND anchor_date
        )::text AS expected_value,
        count(*) FILTER (
          WHERE startdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
        )::text AS baseline_value,
        NULL::text AS expected_dimension
      FROM production.workorder
      CROSS JOIN anchor
      GROUP BY anchor_date
