import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection, type Connection } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { MAGENTO_READ_TABLES } from "./magento-source-policy.js";

interface GrantRow extends RowDataPacket {}

interface CoreConfigRow extends RowDataPacket {
  path: string;
  value: string | null;
}

interface DatabaseVersionRow extends RowDataPacket {
  database_version: string;
  sql_mode: string;
  database_timezone: string;
}

interface TableNameRow extends RowDataPacket {
  table_name: string;
}

interface StoreRow extends RowDataPacket {
  store_id: number;
}

export const MAGENTO_ANALYTICS_TABLES = MAGENTO_READ_TABLES;

const REQUIRED_TABLES = [
  "sales_order",
  "sales_order_item",
  "sales_order_address",
  "sales_order_status_history",
  "sales_order_payment",
  "sales_invoice",
  "sales_invoice_item",
  "sales_creditmemo",
  "sales_creditmemo_item",
  "sales_shipment",
  "sales_shipment_item",
  "customer_entity",
  "customer_address_entity",
  "catalog_product_entity",
  "inventory_source_item",
  "store",
  "store_group",
  "store_website",
  "cron_schedule",
  "indexer_state",
] as const;

export type MagentoPreflightInput = {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tablePrefix: string;
  baseUrl: string;
  storeCode: string;
  integrationToken?: string | null;
};

export type MagentoPreflightResult = {
  databaseVersion: string;
  databaseType: "mariadb" | "mysql";
  sqlMode: string;
  databaseTimezone: string;
  tablePrefix: string;
  tableNames: string[];
  availableAnalyticsTables: string[];
  blockedTables: string[];
  storeIds: number[];
  baseCurrency: string | null;
  timezone: string | null;
  magentoVersion: string;
  operatorReadiness:
    | "integration_token_missing"
    | "integration_token_invalid"
    | "acl_missing"
    | "graphjin_version_unsupported";
};

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`invalid Magento SQL identifier: ${value}`);
  }
  return `\`${value}\``;
}

export function supportedMagentoDatabase(
  version: string,
): { type: "mariadb" | "mysql"; version: string } {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!match) throw new Error(`could not parse MariaDB/MySQL version ${JSON.stringify(version)}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const type = /mariadb/i.test(version) ? "mariadb" : "mysql";
  const supported = type === "mariadb"
    ? major > 10 || (major === 10 && minor >= 6)
    : major >= 8;
  if (!supported) {
    throw new Error(
      `${type === "mariadb" ? "MariaDB 10.6+" : "MySQL 8.0+"} is required; found ${version}`,
    );
  }
  return { type, version };
}

function grantedPrivileges(grant: string): string[] {
  const match = /^GRANT\s+(.+?)\s+ON\s+/i.exec(grant);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

async function assertReadOnlyGrants(connection: Connection): Promise<void> {
  const [rows] = await connection.query<GrantRow[]>("SHOW GRANTS FOR CURRENT_USER()");
  const allowed = new Set(["SELECT", "SHOW VIEW", "USAGE"]);
  for (const row of rows) {
    const grant = Object.values(row as unknown as Record<string, string>)[0] ?? "";
    if (/WITH\s+GRANT\s+OPTION/i.test(grant)) {
      throw new Error("analytics account must not have GRANT OPTION");
    }
    const unexpected = grantedPrivileges(grant).filter((privilege) => !allowed.has(privilege));
    if (unexpected.length > 0 || /ALL PRIVILEGES/i.test(grant)) {
      throw new Error(`analytics account is not read-only (unexpected grants: ${unexpected.join(", ") || "ALL PRIVILEGES"})`);
    }
  }
}

function detectTablePrefix(tableNames: string[], configured: string): string {
  if (configured && !/^[A-Za-z0-9_]+$/.test(configured)) {
    throw new Error("magento.table_prefix may contain letters, numbers, and underscores only");
  }
  const candidates = configured
    ? [configured]
    : tableNames
        .filter((name) => name.endsWith("sales_order"))
        .map((name) => name.slice(0, -"sales_order".length));
  const valid = [...new Set(candidates)].filter((prefix) =>
    REQUIRED_TABLES.every((table) => tableNames.includes(`${prefix}${table}`)),
  );
  if (valid.length === 0) {
    throw new Error("Magento analytics tables are missing or the table prefix is incorrect");
  }
  if (valid.length > 1) {
    throw new Error(`multiple Magento table prefixes detected: ${valid.map((value) => value || "<empty>").join(", ")}`);
  }
  return valid[0]!;
}

async function discoverCoreConfig(
  connection: Connection,
  prefix: string,
): Promise<{ baseCurrency: string | null; timezone: string | null }> {
  const table = quoteIdentifier(`${prefix}core_config_data`);
  const [rows] = await connection.query<CoreConfigRow[]>(
    `SELECT path, value FROM ${table} WHERE scope = 'default' AND scope_id = 0 AND path IN ('currency/options/base', 'general/locale/timezone')`,
  );
  const config = new Map(rows.map((row) => [row.path, row.value]));
  return {
    baseCurrency: config.get("currency/options/base") ?? null,
    timezone: config.get("general/locale/timezone") ?? null,
  };
}

async function discoverStoreIds(
  connection: Connection,
  prefix: string,
  storeCode: string,
): Promise<number[]> {
  const table = quoteIdentifier(`${prefix}store`);
  const normalized = storeCode.trim();
  const [rows] = normalized === "all"
    ? await connection.execute<StoreRow[]>(
        `SELECT store_id FROM ${table} WHERE is_active = 1 AND code <> 'admin' ORDER BY store_id`,
      )
    : await connection.execute<StoreRow[]>(
        `SELECT store_id FROM ${table} WHERE is_active = 1 AND code = ? ORDER BY store_id`,
        [normalized],
      );
  const ids = rows.map((row) => Number(row.store_id)).filter(Number.isInteger);
  if (ids.length === 0) {
    throw new Error(`Magento store code ${JSON.stringify(storeCode)} is missing or inactive`);
  }
  return ids;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

type HostHeaderResponse = { status: number; text: string };

async function requestWithHostHeader(endpoint: string, host: string): Promise<HostHeaderResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { headers: { host } },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 64 * 1024) {
            request.destroy(new Error("Magento version response exceeded 64 KiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error("Magento version preflight timed out")));
    request.on("error", reject);
    request.end();
  });
}

export async function readMagentoVersion(
  baseUrl: string,
  hostHeaderRequest: (endpoint: string, host: string) => Promise<HostHeaderResponse> = requestWithHostHeader,
): Promise<string> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/magento_version`;
  const request = { redirect: "manual" as const, signal: AbortSignal.timeout(10_000) };
  let response = await fetch(endpoint, request);
  let responseText: string | null = null;
  let responseStatus = response.status;
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location) {
    const source = new URL(endpoint);
    const target = new URL(location, source);
    if (!isLoopbackHostname(source.hostname) && isLoopbackHostname(target.hostname)) {
      // Local Compose stores commonly advertise http://localhost while callers
      // reach them through a host gateway. Preserve the routable address and
      // send Magento its configured Host header so version discovery does not
      // escape back into the worker container itself.
      const retried = await hostHeaderRequest(endpoint, target.host);
      responseStatus = retried.status;
      responseText = retried.text;
    } else {
      response = await fetch(endpoint, {
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
      responseStatus = response.status;
    }
  }
  if (responseStatus < 200 || responseStatus >= 300) {
    throw new Error(`Magento version preflight failed: HTTP ${responseStatus}`);
  }
  const text = responseText ?? (await response.text());
  const match = /2\.4(?:\.\d+(?:-p\d+)?)?/i.exec(text);
  if (!match) throw new Error("Magento version endpoint did not report a supported 2.4.x version");
  return match[0] === "2.4" ? "2.4.x" : match[0];
}

async function operatorReadiness(input: MagentoPreflightInput): Promise<MagentoPreflightResult["operatorReadiness"]> {
  if (!input.integrationToken) return "integration_token_missing";
  const url = new URL(
    `${input.baseUrl.replace(/\/+$/, "")}/rest/${encodeURIComponent(input.storeCode)}/V1/orders`,
  );
  url.searchParams.set("searchCriteria[pageSize]", "1");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${input.integrationToken}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response) return "integration_token_invalid";
  if (response.status === 401) return "integration_token_invalid";
  if (response.status === 403) return "acl_missing";
  if (!response.ok) return "acl_missing";
  // The current OpenNeko pin lacks the released GraphJin mutation contract.
  return "graphjin_version_unsupported";
}

export async function runMagentoPreflight(
  input: MagentoPreflightInput,
): Promise<MagentoPreflightResult> {
  const connection = await createConnection({
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.username,
    password: input.password,
    connectTimeout: 10_000,
    multipleStatements: false,
  });
  try {
    await assertReadOnlyGrants(connection);
    const [versionRows] = await connection.query<DatabaseVersionRow[]>(
      "SELECT VERSION() AS database_version, @@sql_mode AS sql_mode, @@session.time_zone AS database_timezone",
    );
    const [tableRows] = await connection.execute<TableNameRow[]>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
      [input.database],
    );
    const tableNames = tableRows.map((row) => row.table_name);
    const tablePrefix = detectTablePrefix(tableNames, input.tablePrefix);
    const analyticsTables = new Set<string>(
      MAGENTO_ANALYTICS_TABLES.map((name) => `${tablePrefix}${name}`),
    );
    const config = await discoverCoreConfig(connection, tablePrefix);
    const storeIds = await discoverStoreIds(connection, tablePrefix, input.storeCode);
    const database = versionRows[0];
    if (!database) throw new Error("MariaDB/MySQL version preflight returned no row");
    const supportedDatabase = supportedMagentoDatabase(database.database_version);
    return {
      databaseVersion: database.database_version,
      databaseType: supportedDatabase.type,
      sqlMode: database.sql_mode,
      databaseTimezone: database.database_timezone,
      tablePrefix,
      tableNames,
      availableAnalyticsTables: MAGENTO_ANALYTICS_TABLES.filter((name) =>
        tableNames.includes(`${tablePrefix}${name}`),
      ),
      blockedTables: tableNames.filter((name) => !analyticsTables.has(name)),
      storeIds,
      ...config,
      magentoVersion: await readMagentoVersion(input.baseUrl),
      operatorReadiness: await operatorReadiness(input),
    };
  } finally {
    await connection.end();
  }
}
