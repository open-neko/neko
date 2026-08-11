WITH anchor AS (
        SELECT max(orderdate)::date AS anchor_date
        FROM sales.salesorderheader
      ),
      winner AS (
        SELECT
          detail.productid,
          product.name,
          sum(detail.orderqty)::numeric AS value
        FROM sales.salesorderheader AS header
        JOIN sales.salesorderdetail AS detail USING (salesorderid)
        JOIN production.product AS product USING (productid)
        CROSS JOIN anchor
        WHERE header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
        GROUP BY detail.productid, product.name
        ORDER BY value DESC
        LIMIT 1
      )
      SELECT
        anchor_date::text,
        (anchor_date - 364)::text AS start_date,
        winner.value::text AS expected_value,
        (
          SELECT sum(detail.orderqty)::text
          FROM sales.salesorderheader AS header
          JOIN sales.salesorderdetail AS detail USING (salesorderid)
          WHERE detail.productid = winner.productid
            AND header.orderdate::date
              BETWEEN anchor_date - 729 AND anchor_date - 365
        ) AS baseline_value,
        winner.name AS expected_dimension
      FROM anchor
      CROSS JOIN winner
