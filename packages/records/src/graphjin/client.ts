import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveSigningSecret } from "@neko/secret-crypt";

const DEFAULT_TOKEN_TTL_SECONDS = 300;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Deployment-key-derived secret shared by the config writer and token minter. */
export function recordsGraphjinSigningSecret(orgId: string): string {
  const value = orgId.trim();
  if (!value || value !== orgId) {
    throw new Error("records GraphJin signing secret requires a canonical org id");
  }
  return deriveSigningSecret(`records-graphjin:${value}`).toString("base64");
}

/** Separate cursor key prevents a token from being replayed as cursor state. */
export function recordsGraphjinCursorSecret(orgId: string): string {
  const value = orgId.trim();
  if (!value || value !== orgId) {
    throw new Error("records GraphJin cursor secret requires a canonical org id");
  }
  return deriveSigningSecret(`records-graphjin-cursor:${value}`).toString(
    "base64",
  );
}

/** Signing domain dedicated to the internal native-watch GraphJin process. */
export function recordsWatchGraphjinSigningSecret(orgId: string): string {
  const value = orgId.trim();
  if (!value || value !== orgId) {
    throw new Error("records watch GraphJin signing secret requires a canonical org id");
  }
  return deriveSigningSecret(`records-watch-graphjin:${value}`).toString("base64");
}

export function recordsWatchGraphjinCursorSecret(orgId: string): string {
  const value = orgId.trim();
  if (!value || value !== orgId) {
    throw new Error("records watch GraphJin cursor secret requires a canonical org id");
  }
  return deriveSigningSecret(`records-watch-graphjin-cursor:${value}`).toString(
    "base64",
  );
}

export function recordsWatchWebhookSecret(orgId: string): string {
  const value = orgId.trim();
  if (!value || value !== orgId) {
    throw new Error("records watch webhook secret requires a canonical org id");
  }
  return deriveSigningSecret(`records-watch-webhook:${value}`).toString("base64");
}

export type RecordsGraphjinRole = "admin" | "member" | "service";

export type RecordsGraphjinTokenInput = {
  secret: string;
  orgId: string;
  userId: string;
  role: RecordsGraphjinRole;
  ttlSeconds?: number;
  nowMs?: number;
  audience?: string;
  issuer?: string;
};

export type RecordsGraphjinTokenClaims = {
  sub: string;
  org_id: string;
  role: RecordsGraphjinRole;
  roles: RecordsGraphjinRole[];
  iat: number;
  exp: number;
  aud?: string;
  iss?: string;
};

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function validateTokenTtl(ttlSeconds: number): number {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 15 * 60) {
    throw new Error("records GraphJin token TTL must be between 30 and 900 seconds");
  }
  return ttlSeconds;
}

/** Mint the exact short-lived HS256 identity consumed by roles_query. */
export function mintRecordsGraphjinToken(input: RecordsGraphjinTokenInput): string {
  if (input.secret.length < 32) {
    throw new Error("records GraphJin signing secret must be at least 32 characters");
  }
  if (!input.orgId.trim() || !input.userId.trim()) {
    throw new Error("records GraphJin token requires org and user ids");
  }
  const now = Math.floor((input.nowMs ?? Date.now()) / 1_000);
  const ttl = validateTokenTtl(input.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS);
  const claims: RecordsGraphjinTokenClaims = {
    sub: input.userId,
    org_id: input.orgId,
    role: input.role,
    roles: [input.role],
    iat: now,
    exp: now + ttl,
    ...(input.audience ? { aud: input.audience } : {}),
    ...(input.issuer ? { iss: input.issuer } : {}),
  };
  const unsigned = `${base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64url(
    JSON.stringify(claims),
  )}`;
  const signature = createHmac("sha256", input.secret)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

export function verifyRecordsGraphjinToken(
  token: string,
  input: { secret: string; orgId: string; nowMs?: number },
): RecordsGraphjinTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac("sha256", input.secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as RecordsGraphjinTokenClaims;
    if (
      claims.org_id !== input.orgId ||
      !claims.sub ||
      claims.exp * 1_000 <= (input.nowMs ?? Date.now())
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export function recordsGraphjinEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("records GraphJin endpoint must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("records GraphJin endpoint must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("records GraphJin endpoint cannot contain credentials, query, or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/api/v1/graphql")) {
    url.pathname = `${url.pathname}/api/v1/graphql`.replace(/\/{2,}/g, "/");
  }
  return url.toString().replace(/\/$/, "");
}

export class RecordsGraphjinRequestError extends Error {
  readonly code = "records_graphjin_request_failed";

  constructor(
    message: string,
    readonly status: number | null,
    readonly graphjinErrors: Array<{ message: string; path?: Array<string | number> }> = [],
  ) {
    super(message);
    this.name = "RecordsGraphjinRequestError";
  }
}

export type RecordsGraphjinExecuteInput = {
  operationName: string;
  query: string;
  variables?: Record<string, unknown>;
  token: string;
  signal?: AbortSignal;
};

export interface RecordsGraphjinTransport {
  execute<T>(input: RecordsGraphjinExecuteInput): Promise<T>;
}

function validateBudget(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function parseErrors(value: unknown): Array<{ message: string; path?: Array<string | number> }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    if (typeof item === "string") return { message: item.slice(0, 1_000) };
    if (item && typeof item === "object") {
      const candidate = item as { message?: unknown; path?: unknown };
      return {
        message:
          typeof candidate.message === "string"
            ? candidate.message.slice(0, 1_000)
            : "GraphJin returned an unspecified error",
        ...(Array.isArray(candidate.path)
          ? { path: candidate.path.slice(0, 20) as Array<string | number> }
          : {}),
      };
    }
    return { message: "GraphJin returned an unspecified error" };
  });
}

export class RecordsGraphjinClient implements RecordsGraphjinTransport {
  readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(input: {
    baseUrl: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
  }) {
    this.endpoint = recordsGraphjinEndpoint(input.baseUrl);
    this.timeoutMs = validateBudget(
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "records GraphJin timeout",
      60_000,
    );
    this.maxResponseBytes = validateBudget(
      input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "records GraphJin response budget",
      16 * 1024 * 1024,
    );
  }

  async execute<T>(input: RecordsGraphjinExecuteInput): Promise<T> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.operationName)) {
      throw new Error("records GraphJin requests require a named operation");
    }
    if (!input.query.includes(input.operationName)) {
      throw new Error("records GraphJin operation name is absent from its document");
    }
    if (!input.token.trim()) throw new Error("records GraphJin request requires a token");

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operationName: input.operationName,
          query: input.query,
          variables: input.variables ?? {},
        }),
        signal,
      });
    } catch (error) {
      throw new RecordsGraphjinRequestError(
        error instanceof Error && error.name === "TimeoutError"
          ? "records GraphJin request timed out"
          : "records GraphJin request was unavailable",
        null,
      );
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > this.maxResponseBytes) {
      throw new RecordsGraphjinRequestError(
        "records GraphJin response exceeded its byte budget",
        response.status,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > this.maxResponseBytes) {
      throw new RecordsGraphjinRequestError(
        "records GraphJin response exceeded its byte budget",
        response.status,
      );
    }
    if (!response.ok) {
      throw new RecordsGraphjinRequestError(
        `records GraphJin request failed with HTTP ${response.status}`,
        response.status,
      );
    }

    let body: { data?: T | null; errors?: unknown };
    try {
      body = JSON.parse(bytes.toString("utf8")) as typeof body;
    } catch {
      throw new RecordsGraphjinRequestError(
        "records GraphJin returned invalid JSON",
        response.status,
      );
    }
    const errors = parseErrors(body.errors);
    if (errors.length > 0) {
      throw new RecordsGraphjinRequestError(
        `records GraphJin rejected ${input.operationName}`,
        response.status,
        errors,
      );
    }
    if (body.data === null || body.data === undefined) {
      throw new RecordsGraphjinRequestError(
        "records GraphJin response omitted data",
        response.status,
      );
    }
    return body.data;
  }
}
