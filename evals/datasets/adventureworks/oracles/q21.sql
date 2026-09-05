WITH anchor AS (
  SELECT max(orderdate)::date AS anchor_date
  FROM sales.salesorderheader
),
winner AS (
  SELECT
    category.productcategoryid,
    category.name,
    sum(detail.unitprice * (1 - detail.unitpricediscount) * detail.orderqty) AS value
  FROM sales.salesorderheader AS header
  JOIN sales.salesorderdetail AS detail USING (salesorderid)
  JOIN production.product AS product USING (productid)
  JOIN production.productsubcategory AS subcategory USING (productsubcategoryid)
  JOIN production.productcategory AS category USING (productcategoryid)
  CROSS JOIN anchor
  WHERE header.orderdate::date BETWEEN anchor_date - 364 AND anchor_date
  GROUP BY category.productcategoryid, category.name
  ORDER BY value DESC
  LIMIT 1
)
SELECT
  anchor_date::text,
  (anchor_date - 364)::text AS start_date,
  round(winner.value, 2)::text AS expected_value,
  round((
    SELECT sum(detail.unitprice * (1 - detail.unitpricediscount) * detail.orderqty)
    FROM sales.salesorderheader AS header
    JOIN sales.salesorderdetail AS detail USING (salesorderid)
    JOIN production.product AS product USING (productid)
    JOIN production.productsubcategory AS subcategory USING (productsubcategoryid)
    WHERE subcategory.productcategoryid = winner.productcategoryid
      AND header.orderdate::date BETWEEN anchor_date - 729 AND anchor_date - 365
  ), 2)::text AS baseline_value,
  winner.name AS expected_dimension
FROM anchor
CROSS JOIN winner;
