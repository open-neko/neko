-- Copper Kettle Roasters — production Postgres schema (excerpt)
CREATE TABLE regions (id serial PRIMARY KEY, name text, manager text);
CREATE TABLE cafes (id serial PRIMARY KEY, region_id int REFERENCES regions(id), name text, city text);
CREATE TABLE products (sku text PRIMARY KEY, name text, roast text, unit_price numeric);
CREATE TABLE inventory (sku text REFERENCES products(sku), warehouse text, on_hand int, reorder_point int);
CREATE TABLE suppliers (id serial PRIMARY KEY, name text, country text, lead_time_days int);
CREATE TABLE purchase_orders (id serial PRIMARY KEY, supplier_id int REFERENCES suppliers(id),
  sku text, qty int, status text, ordered_at timestamptz, eta date);
CREATE TABLE roast_batches (id serial PRIMARY KEY, sku text, stage text, -- green|roasting|cooling|packed
  qty_kg numeric, started_at timestamptz);
CREATE TABLE orders (id serial PRIMARY KEY, cafe_id int REFERENCES cafes(id),
  status text, -- pending|packed|shipped|delivered|cancelled
  total numeric, placed_at timestamptz, shipped_at timestamptz);
CREATE TABLE order_items (order_id int, sku text, qty int, price numeric);
