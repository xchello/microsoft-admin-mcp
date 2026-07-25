import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "../http.js";
import { config } from "../config.js";

/**
 * Live documentation tools. These exist so generated scripts and actions are
 * always based on CURRENT information: latest module versions from the
 * PowerShell Gallery and up-to-date guidance from Microsoft Learn.
 */

/** Response-size ceilings, so one enormous page cannot balloon memory. */
const MAX_XML_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 3 * 1024 * 1024;

/**
 * Read a response body but stop after `maxBytes`. These are public endpoints we do
 * not control; a Learn page with an unexpected payload would otherwise be buffered
 * in full before being sliced down to 40 kB.
 */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return await res.text();
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (total >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}

/**
 * fetch() + bounded body read under ONE abort deadline. Without this a stalled
 * connection (or a server that sends headers and then goes quiet) hangs the tool
 * call forever; src/http.ts already guards its Graph calls this way.
 */
async function fetchText(
  url: string,
  init: RequestInit,
  source: string,
  maxBytes: number
): Promise<{ res: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await readBounded(res, maxBytes);
    return { res, text };
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new Error(
        `${source} reageerde niet binnen ${Math.round(config.timeoutMs / 1000)} seconden (timeout). ` +
          "Probeer het later opnieuw of verhoog REQUEST_TIMEOUT_MS."
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
export function registerDocsTools(server: McpServer): void {
  server.registerTool(
    "psgallery_module_info",
    {
      title: "PowerShell Gallery module info",
      description:
        "Look up the LATEST published version of a PowerShell module on the PowerShell Gallery " +
        "(e.g. Microsoft.Graph, Az, Microsoft.Graph.Beta, ExchangeOnlineManagement, PnP.PowerShell). " +
        "Always use this before pinning module versions in generated scripts, so scripts never rely on outdated versions.",
      inputSchema: {
        moduleName: z.string().describe("Exact module name, e.g. Microsoft.Graph or Az.Accounts"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ moduleName }) => {
      try {
        const url =
          "https://www.powershellgallery.com/api/v2/FindPackagesById()?id='" +
          encodeURIComponent(moduleName) +
          "'&$filter=IsLatestVersion eq true&$orderby=Version desc&$top=1";
        const { res, text: xml } = await fetchText(
          url,
          { headers: { Accept: "application/atom+xml" } },
          "PowerShell Gallery",
          MAX_XML_BYTES
        );
        if (!res.ok) throw new Error(`PowerShell Gallery returned HTTP ${res.status}`);
        const version = xml.match(/<d:Version[^>]*>([^<]+)<\/d:Version>/)?.[1];
        const published = xml.match(/<d:Published[^>]*>([^<]+)<\/d:Published>/)?.[1];
        const description = xml.match(/<d:Description[^>]*>([\s\S]*?)<\/d:Description>/)?.[1]?.slice(0, 500);
        if (!version) {
          return jsonResult({ moduleName, found: false, hint: "Check the exact module name." });
        }
        return jsonResult({ moduleName, found: true, latestVersion: version, published, description });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "mslearn_search",
    {
      title: "Search Microsoft Learn",
      description:
        "Search current Microsoft Learn documentation (Graph API, Azure, Entra, Intune, PowerShell). " +
        "Use this to verify the CURRENT recommended approach, API versions and cmdlet names before " +
        "generating scripts or performing actions, instead of relying on possibly outdated knowledge.",
      inputSchema: {
        query: z.string().describe("Search query, e.g. 'Intune managedDevices wipe Graph API'"),
        top: z.number().int().min(1).max(10).optional().default(5),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, top }) => {
      try {
        const url = new URL("https://learn.microsoft.com/api/search");
        url.searchParams.set("search", query);
        url.searchParams.set("locale", "en-us");
        url.searchParams.set("$top", String(top ?? 5));
        const { res, text } = await fetchText(
          url.toString(),
          { headers: { Accept: "application/json" } },
          "Microsoft Learn zoeken",
          MAX_JSON_BYTES
        );
        if (!res.ok) throw new Error(`Microsoft Learn search returned HTTP ${res.status}`);
        const data = JSON.parse(text) as { results?: Array<Record<string, unknown>> };
        const results = (data.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          summary: r.description,
          lastUpdated: r.lastUpdatedDate,
        }));
        return jsonResult({ query, results });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "mslearn_fetch",
    {
      title: "Fetch a Microsoft Learn page",
      description:
        "Fetch the raw content of a learn.microsoft.com page (as markdown-ish text) to read the " +
        "current documentation in detail. Only learn.microsoft.com URLs are allowed.",
      inputSchema: {
        url: z.string().url().describe("A learn.microsoft.com URL from mslearn_search results."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        const parsed = new URL(url);
        if (parsed.hostname !== "learn.microsoft.com") {
          throw new Error("Only learn.microsoft.com URLs are allowed.");
        }
        const { res, text: html } = await fetchText(
          parsed.toString(),
          { headers: { Accept: "text/html", "User-Agent": "microsoft-admin-mcp" } },
          "Microsoft Learn",
          MAX_HTML_BYTES
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const main = html.match(/<main[\s\S]*?<\/main>/)?.[0] ?? html;
        const text = main
          .replace(/<script[\s\S]*?<\/script>/g, "")
          .replace(/<style[\s\S]*?<\/style>/g, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/\s{3,}/g, "\n")
          .trim()
          .slice(0, 40_000);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
