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

/**
 * Fetch with retry, honoring Retry-After and backing off exponentially.
 *
 * Retry policy is deliberately asymmetric, because a retry must never re-issue an
 * operation the service already accepted:
 *  - 429 is safe for every method: the request was rejected BEFORE execution and
 *    Graph tells us when to come back.
 *  - 503/504 only for GET. A 504 on POST /managedDevices/{id}/wipe or on
 *    DELETE /applications/{id} means "no answer", not "not done" — the service may
 *    well have executed it, so retrying could wipe a device twice.
 */
async function fetchWithRetry(url: string, scope: string, opts: RequestOptions): Promise<Response> {
  const method = opts.method ?? "GET";
  let attempt = 0;
  for (;;) {
    const token = await getToken(scope);
    const res = await doFetch(url, token, opts);
    const retryable = res.status === 429 || ((res.status === 503 || res.status === 504) && method === "GET");
    if (retryable && attempt < 3) {
      const header = Number(res.headers.get("retry-after"));
      const retryAfter = Number.isFinite(header) && header > 0 ? header : Math.pow(2, attempt + 1);
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
      // Defence in depth: the next page URL comes from the response body, and it is
      // followed WITH the bearer token. Refuse to send that token anywhere but Graph.
      if (new URL(next).origin !== GRAPH_BASE) {
        throw new Error(`Refused to follow @odata.nextLink to a non-Graph host: ${new URL(next).origin}`);
      }
      const page = (await parseResponse(
        await fetchWithRetry(next, GRAPH_SCOPE, { method: "GET", headers })
      )) as { value?: unknown[]; ["@odata.nextLink"]?: string };
      out.value.push(...(page.value ?? []));
      next = page["@odata.nextLink"];
    }
    // Only claim truncation when data was actually left behind: either a nextLink
    // still remained, or we fetched past maxItems and had to cut. A collection of
    // exactly maxItems items with no nextLink is COMPLETE, and reporting it as
    // truncated made callers chase pages that do not exist.
    let truncated = Boolean(next);
    if (out.value.length > maxItems) {
      out.value = out.value.slice(0, maxItems);
      truncated = true;
    }
    delete out["@odata.nextLink"];
    return { count: out.value.length, truncatedAt: truncated ? maxItems : undefined, value: out.value };
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

export interface BatchRequest {
  id: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  url: string; // relative to the Graph version root, e.g. "/users/abc"
  body?: unknown;
  headers?: Record<string, string>;
}
export interface BatchResponse {
  id: string;
  status: number;
  body: unknown;
}

/**
 * Combine many Graph calls into one round trip with $batch. Graph accepts at most
 * 20 requests per batch, so larger sets are chunked automatically. Individual
 * failures are returned per request instead of failing the whole batch, which is
 * what you want when enriching a list of devices where one may have been deleted.
 *
 * POSITIONAL GUARANTEE — callers rely on this: the returned array has EXACTLY one
 * entry per request, at the SAME index as that request, with the same id. Graph may
 * return sub-responses out of order and may omit one entirely; when a response is
 * missing we insert a synthetic entry (status 0) instead of shortening the array.
 * Without that guarantee callers that index by position (src/tools/intune.ts does
 * this for compliance setting states and group names) would attach one device's
 * data to a different device.
 */
export async function graphBatch(
  requests: BatchRequest[],
  opts: { version?: "v1.0" | "beta" } = {}
): Promise<BatchResponse[]> {
  const version = opts.version ?? config.defaultGraphVersion;
  const out: BatchResponse[] = [];
  const CHUNK = 20;

  for (let i = 0; i < requests.length; i += CHUNK) {
    const chunk = requests.slice(i, i + CHUNK);
    const payload = {
      requests: chunk.map((r) => ({
        id: r.id,
        method: r.method ?? "GET",
        url: r.url.startsWith("/") ? r.url : `/${r.url}`,
        ...(r.body === undefined ? {} : { body: r.body }),
        ...(r.headers || r.body !== undefined
          ? { headers: { "Content-Type": "application/json", ...r.headers } }
          : {}),
      })),
    };
    const result = (await graphRequest("/$batch", {
      method: "POST",
      version,
      body: payload,
    })) as { responses?: Array<{ id: string; status: number; body?: unknown }> };

    // Index the sub-responses by id as a queue, so duplicate ids in one chunk each
    // consume their own response instead of sharing the first match.
    const byId = new Map<string, Array<{ id: string; status: number; body?: unknown }>>();
    for (const response of result.responses ?? []) {
      const queue = byId.get(response.id);
      if (queue) queue.push(response);
      else byId.set(response.id, [response]);
    }
    for (const request of chunk) {
      const match = byId.get(request.id)?.shift();
      out.push(
        match
          ? { id: match.id, status: match.status, body: match.body }
          : {
              id: request.id,
              status: 0,
              body: {
                error: {
                  code: "missingBatchResponse",
                  message: `Graph gaf geen antwoord terug voor batch-request "${request.id}" (${request.method ?? "GET"} ${request.url}). Probeer deze aanvraag los opnieuw.`,
                },
              },
            }
      );
    }
  }
  return out;
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
