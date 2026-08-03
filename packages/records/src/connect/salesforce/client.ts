export type SalesforceFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SalesforceApiBudgetSnapshot = {
  day: string;
  used: number;
  limit: number;
};

export class SalesforceApiError extends Error {
  readonly code: string = "salesforce_api_error";

  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "SalesforceApiError";
  }
}

export class SalesforceApiBudgetExceededError extends SalesforceApiError {
  override readonly code = "salesforce_api_budget_exceeded";

  constructor(readonly snapshot: SalesforceApiBudgetSnapshot) {
    super(
      `Salesforce daily API budget exhausted (${snapshot.used}/${snapshot.limit})`,
      429,
      true,
      null,
    );
    this.name = "SalesforceApiBudgetExceededError";
  }
}

const DEFAULT_ALLOWED_SUFFIXES = [
  ".salesforce.com",
  ".force.com",
  ".my.salesforce.com",
];

function hostnameAllowed(hostname: string, explicit: ReadonlySet<string>): boolean {
  const lower = hostname.toLowerCase();
  return (
    explicit.has(lower) ||
    DEFAULT_ALLOWED_SUFFIXES.some(
      (suffix) => lower.endsWith(suffix) && lower.length > suffix.length,
    )
  );
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function retryAfterMs(response: Response, now: Date): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1_000;
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - now.getTime());
}

function responseMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => {
          if (typeof entry !== "object" || entry === null) return String(entry);
          const value = entry as Record<string, unknown>;
          return [value.errorCode, value.message].filter(Boolean).join(": ");
        })
        .filter(Boolean)
        .join("; ");
    }
    if (typeof parsed === "object" && parsed !== null) {
      const value = parsed as Record<string, unknown>;
      return String(value.error_description ?? value.message ?? body);
    }
  } catch {
    // Salesforce occasionally returns plain text from edge/proxy failures.
  }
  return body.trim() || `Salesforce request failed (${status})`;
}

export class SalesforceApiGovernor {
  private day: string;
  private used: number;

  constructor(
    private readonly limit: number,
    input: { day?: string; used?: number; now?: () => Date } = {},
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Salesforce API budget must be a positive integer");
    }
    this.now = input.now ?? (() => new Date());
    this.day = input.day ?? dayKey(this.now());
    this.used = input.used ?? 0;
  }

  private readonly now: () => Date;

  consume(): void {
    const current = dayKey(this.now());
    if (current !== this.day) {
      this.day = current;
      this.used = 0;
    }
    if (this.used >= this.limit) {
      throw new SalesforceApiBudgetExceededError(this.snapshot());
    }
    this.used += 1;
  }

  snapshot(): SalesforceApiBudgetSnapshot {
    return { day: this.day, used: this.used, limit: this.limit };
  }

  restore(snapshot: SalesforceApiBudgetSnapshot): void {
    if (
      snapshot.limit !== this.limit ||
      !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.day) ||
      !Number.isSafeInteger(snapshot.used) ||
      snapshot.used < 0
    ) {
      throw new Error("Salesforce API budget checkpoint is incompatible");
    }
    const current = dayKey(this.now());
    this.day = current;
    this.used = snapshot.day === current ? Math.min(snapshot.used, this.limit) : 0;
  }
}

type SalesforceToken = {
  accessToken: string;
  instanceUrl: URL;
  expiresAt: number;
};

/** Allowlisted Salesforce REST/Bulk client with token caching and quota backoff. */
export class SalesforceApiClient {
  private readonly instanceUrl: URL;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly fetcher: SalesforceFetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private token: SalesforceToken | null = null;

  readonly apiVersion: string;

  constructor(
    private readonly options: {
      instanceUrl: string;
      clientId: string;
      clientSecret: string;
      apiVersion?: string;
      fetch?: SalesforceFetch;
      sleep?: (milliseconds: number) => Promise<void>;
      now?: () => Date;
      governor?: SalesforceApiGovernor;
      allowedHosts?: string[];
      allowInsecureHttp?: boolean;
      maxRetries?: number;
    },
  ) {
    this.instanceUrl = new URL(options.instanceUrl);
    this.allowedHosts = new Set(
      (options.allowedHosts ?? []).map((hostname) => hostname.toLowerCase()),
    );
    this.assertAllowedUrl(this.instanceUrl);
    if (!options.clientId.trim() || !options.clientSecret) {
      throw new Error("Salesforce client id and secret are required");
    }
    this.apiVersion = options.apiVersion ?? "64.0";
    if (!/^\d{2,3}\.0$/.test(this.apiVersion)) {
      throw new Error("Salesforce API version must look like 64.0");
    }
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
  }

  private assertAllowedUrl(url: URL): void {
    if (url.username || url.password) {
      throw new Error("Salesforce URLs cannot contain credentials");
    }
    if (
      url.protocol !== "https:" &&
      !(this.options.allowInsecureHttp === true && url.protocol === "http:")
    ) {
      throw new Error("Salesforce URLs must use HTTPS");
    }
    if (!hostnameAllowed(url.hostname, this.allowedHosts)) {
      throw new Error(`Salesforce host is not allowlisted: ${url.hostname}`);
    }
  }

  private async accessToken(signal?: AbortSignal): Promise<SalesforceToken> {
    if (this.token && this.token.expiresAt - 30_000 > this.now().getTime()) {
      return this.token;
    }
    const url = new URL("/services/oauth2/token", this.instanceUrl);
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    const response = await this.perform(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal,
    }, false);
    const raw = (await response.json()) as Record<string, unknown>;
    if (typeof raw.access_token !== "string" || !raw.access_token) {
      throw new SalesforceApiError("Salesforce token response has no access token", 502, false);
    }
    const tokenInstance = new URL(
      typeof raw.instance_url === "string" ? raw.instance_url : this.instanceUrl,
    );
    this.assertAllowedUrl(tokenInstance);
    const expiresIn =
      typeof raw.expires_in === "number" && raw.expires_in > 0
        ? raw.expires_in * 1_000
        : 10 * 60_000;
    this.token = {
      accessToken: raw.access_token,
      instanceUrl: tokenInstance,
      expiresAt: this.now().getTime() + expiresIn,
    };
    return this.token;
  }

  private async perform(
    initialUrl: URL,
    init: RequestInit,
    authenticated: boolean,
  ): Promise<Response> {
    let url = initialUrl;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      this.assertAllowedUrl(url);
      this.options.governor?.consume();
      const response = await this.fetcher(url, { ...init, redirect: "manual" });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (!location || redirect === 3) {
        throw new SalesforceApiError("Salesforce redirect was invalid", response.status, false);
      }
      url = new URL(location, url);
      if (authenticated && url.origin !== initialUrl.origin) {
        throw new SalesforceApiError(
          "Salesforce refused to forward credentials across origins",
          response.status,
          false,
        );
      }
    }
    throw new SalesforceApiError("Salesforce redirect limit exceeded", null, false);
  }

  async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    if (!path.startsWith("/services/")) {
      throw new Error("Salesforce API paths must start with /services/");
    }
    const retries = this.options.maxRetries ?? 4;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const token = await this.accessToken(init.signal ?? undefined);
      const url = new URL(path, token.instanceUrl);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token.accessToken}`);
      if (path.startsWith("/services/async/")) {
        headers.set("x-sfdc-session", token.accessToken);
      }
      headers.set("accept", headers.get("accept") ?? "application/json");
      let response: Response;
      try {
        response = await this.perform(url, { ...init, headers }, true);
      } catch (error) {
        if (
          attempt < retries &&
          !(error instanceof SalesforceApiBudgetExceededError) &&
          (!(error instanceof SalesforceApiError) || error.retryable)
        ) {
          await this.sleep(Math.min(30_000, 500 * 2 ** attempt));
          continue;
        }
        throw error;
      }
      if (response.ok) return response;
      const body = await response.text();
      const limitExceeded = body.includes("REQUEST_LIMIT_EXCEEDED");
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500 ||
        limitExceeded;
      const delay = retryAfterMs(response, this.now()) ?? Math.min(30_000, 500 * 2 ** attempt);
      if (retryable && attempt < retries) {
        await this.sleep(delay);
        continue;
      }
      throw new SalesforceApiError(
        responseMessage(body, response.status),
        response.status,
        retryable,
        retryable ? delay : null,
      );
    }
    throw new SalesforceApiError("Salesforce retry limit exceeded", null, true);
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  dataPath(suffix: string): string {
    return `/services/data/v${this.apiVersion}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  }

  /** Original Bulk API endpoint, used only for its explicit PK-chunk fallback. */
  asyncPath(suffix: string): string {
    return `/services/async/${this.apiVersion}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  }

  budgetSnapshot(): SalesforceApiBudgetSnapshot | null {
    return this.options.governor?.snapshot() ?? null;
  }

  restoreBudget(snapshot: SalesforceApiBudgetSnapshot | null): void {
    if (snapshot) this.options.governor?.restore(snapshot);
  }
}
