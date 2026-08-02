import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export type RecordCatalogColumn = {
  schema: string;
  table: string;
  relationKind: string;
  position: number;
  column: string;
  dataType: string;
  notNull: boolean;
  defaultExpression: string | null;
};

export type RecordCatalogConstraint = {
  schema: string;
  table: string;
  name: string;
  definition: string;
};

export type RecordCatalogIndex = {
  schema: string;
  table: string;
  name: string;
  definition: string;
};

export type RecordsCatalogSnapshot = {
  revision: string;
  columns: RecordCatalogColumn[];
  constraints: RecordCatalogConstraint[];
  indexes: RecordCatalogIndex[];
};

function hashCatalog(input: Omit<RecordsCatalogSnapshot, "revision">): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

/**
 * Hash the complete non-system live catalog used by the schema approval
 * boundary. A relation, column, constraint, or index drift changes revision.
 */
export async function loadRecordsCatalogSnapshot(
  client: Queryable,
): Promise<RecordsCatalogSnapshot> {
  const columnsResult = await client.query<{
    schema_name: string;
    table_name: string;
    relation_kind: string;
    position: number;
    column_name: string;
    data_type: string;
    not_null: boolean;
    default_expression: string | null;
  }>(`
    select n.nspname::text as schema_name,
           c.relname::text as table_name,
           c.relkind::text as relation_kind,
           a.attnum::integer as position,
           a.attname::text as column_name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
           a.attnotnull as not_null,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expression
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid
      and a.attnum > 0 and not a.attisdropped
    left join pg_catalog.pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
    where c.relkind in ('r', 'p', 'v', 'm', 'f')
      and n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    order by n.nspname, c.relname, a.attnum
  `);
  const constraintsResult = await client.query<{
    schema_name: string;
    table_name: string;
    constraint_name: string;
    definition: string;
  }>(`
    select n.nspname::text as schema_name,
           c.relname::text as table_name,
           con.conname::text as constraint_name,
           pg_catalog.pg_get_constraintdef(con.oid, true) as definition
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class c on c.oid = con.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    order by n.nspname, c.relname, con.conname
  `);
  const indexesResult = await client.query<{
    schema_name: string;
    table_name: string;
    index_name: string;
    definition: string;
  }>(`
    select n.nspname::text as schema_name,
           c.relname::text as table_name,
           i.relname::text as index_name,
           pg_catalog.pg_get_indexdef(i.oid) as definition
    from pg_catalog.pg_index ix
    join pg_catalog.pg_class c on c.oid = ix.indrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_class i on i.oid = ix.indexrelid
    where n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    order by n.nspname, c.relname, i.relname
  `);

  const catalog = {
    columns: columnsResult.rows.map((row): RecordCatalogColumn => ({
      schema: row.schema_name,
      table: row.table_name,
      relationKind: row.relation_kind,
      position: row.position,
      column: row.column_name,
      dataType: row.data_type,
      notNull: row.not_null,
      defaultExpression: row.default_expression,
    })),
    constraints: constraintsResult.rows.map(
      (row): RecordCatalogConstraint => ({
        schema: row.schema_name,
        table: row.table_name,
        name: row.constraint_name,
        definition: row.definition,
      }),
    ),
    indexes: indexesResult.rows.map((row): RecordCatalogIndex => ({
      schema: row.schema_name,
      table: row.table_name,
      name: row.index_name,
      definition: row.definition,
    })),
  };
  return { revision: hashCatalog(catalog), ...catalog };
}
