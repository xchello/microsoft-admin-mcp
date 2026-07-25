import { ARM_SCOPE, GRAPH_SCOPE, getToken } from "./auth.js";
import { config } from "./config.js";

const GRAPH_BASE = "https://graph.microsoft.com";
const ARM_BASE = "https://management.azure.com";

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Follow @odata.nextLink pages until this many items are collected. */
  maxItems?: number;
}

async function doFetch(url: string, token: string, opts: RequestOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    return await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch with retry on throttling (429) and transient errors (5xx), honoring Retry-After. */
async function fetchWithRetry(url: string, scope: string, opts: RequestOptions): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const token = await getToken(scope);
    const res = await doFetch(url, token, opts);
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after") ?? Math.pow(2, attempt + 1));
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
      attempt++;
      continue;
    }
    return res;
  }
}

async function parseResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : { status: res.status, ok: res.ok };
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${JSON.stringify(parsed).slice(0, 2000)}`);
  }
  return parsed;
}

/** Call Microsoft Graph. Path example: "/users" or "/deviceManagement/managedDevices". */
export async function graphRequest(
  path: string,
  opts: RequestOptions & { version?: "v1.0" | "beta" } = {}
): Promise<unknown> {
  const version = opts.version ?? config.defaultGraphVersion;
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${GRAPH_BASE}/${version}${cleanPath}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const headers = { ...opts.headers };
  // Advanced queries ($search, $count, certain $filter operators) need eventual consistency.
  const q = url.search;
  if (q.includes("%24search") || q.includes("%24count") || q.includes("$search") || q.includes("$count")) {
    headers["ConsistencyLevel"] = "eventual";
  }

  const first = await parseResponse(await fetchWithRetry(url.toString(), GRAPH_SCOPE, { ...opts, headers }));

  // Transparent paging for collections.
  const maxItems = opts.maxItems ?? 100;
  if (
    first &&
    typeof first === "object" &&
    Array.isArray((first as Record<string, unknown>).value)
  ) {
    const out = first as { value: unknown[]; ["@odata.nextLink"]?: string };
    let next = out["@odata.nextLink"];
    while (next && out.value.length < maxItems) {
      const page = (await parseResponse(
        await fetchWithRetry(next, GRAPH_SCOPE, { method: "GET", headers })
      )) as { value?: unknown[]; ["@odata.nextLink"]?: string };
      out.value.push(...(page.value ?? []));
      next = page["@odata.nextLink"];
    }
    if (out.value.length > maxItems) out.value = out.value.slice(0, maxItems);
    delete out["@odata.nextLink"];
    return { count: out.value.length, truncatedAt: out.value.length >= maxItems ? maxItems : undefined, value: out.value };
  }
  return first;
}

/** Call Azure Resource Manager. Path example: "/subscriptions" or a full resource id. */
export async function armRequest(
  path: string,
  opts: RequestOptions & { apiVersion?: string } = {}
): Promise<unknown> {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${ARM_BASE}${cleanPath}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  if (opts.apiVersion) url.searchParams.set("api-version", opts.apiVersion);
  if (!url.searchParams.has("api-version")) {
    throw new Error("Azure Resource Manager requests require an api-version (parameter apiVersion).");
  }
  return parseResponse(await fetchWithRetry(url.toString(), ARM_SCOPE, opts));
}

export function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}
