import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult } from "../http.js";
import { readOnlyReason } from "../guard.js";

/**
 * Bundled expert knowledge, shipped with the server so it is available on
 * every device: advanced Intune troubleshooting methodology (four-tier forensic
 * approach, based on powerstacks-corp/intune-advanced-troubleshooting, in the
 * investigative style of Rudy Ooms / call4cloud.nl).
 *
 * The bundled copy is a snapshot. `refresh: true` pulls the current version from
 * the source repository into a local cache in the user profile, so the knowledge
 * can be brought up to date without releasing a new server version. The cache is
 * preferred over the snapshot once it exists.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = join(here, "..", "..", "knowledge", "intune-troubleshooting");
const RAW_BASE =
  "https://raw.githubusercontent.com/powerstacks-corp/intune-advanced-troubleshooting/main/";

function cacheDir(): string {
  return (
    process.env.KNOWLEDGE_CACHE_DIR ??
    join(homedir(), ".microsoft-admin-mcp", "knowledge-cache", "intune-troubleshooting")
  );
}

const ITEMS: Record<string, { file: string; what: string }> = {
  method: { file: "SKILL.md", what: "The full four-tier troubleshooting methodology" },
  overview: { file: "README.md", what: "Short overview and quick start" },
  "collect-forensics-script": {
    file: "scripts/Collect-IntuneForensics.ps1",
    what: "Tier 1: PowerShell forensic snapshot collector (logs, registry, certificates, events)",
  },
  "ime-decompile-script": {
    file: "scripts/Invoke-ImeDecompile.ps1",
    what: "Tier 3: decompile Intune Management Extension .NET assemblies",
  },
  "native-decompile-script": {
    file: "scripts/Invoke-NativeDecompile.ps1",
    what: "Tier 4: native binary analysis wrapper (Ghidra)",
  },
  "example-check-in": {
    file: "examples/last-check-in-analysis.md",
    what: "Worked example: analyzing a stale last check-in",
  },
  "example-stuck-app": {
    file: "examples/stuck-app-install-analysis.md",
    what: "Worked example: diagnosing a stuck app install",
  },
};

/** Local path inside the cache for a repository-relative file. */
function cachePathFor(file: string): string {
  return join(cacheDir(), ...file.split("/"));
}

async function refreshFromSource(): Promise<{ updated: string[]; failed: string[] }> {
  const updated: string[] = [];
  const failed: string[] = [];
  for (const { file } of Object.values(ITEMS)) {
    try {
      // Bounded: a stalled connection must not hang the tool call forever.
      const response = await fetch(`${RAW_BASE}${file}`, {
        headers: { "User-Agent": "microsoft-admin-mcp" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const target = cachePathFor(file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text, "utf8");
      updated.push(file);
    } catch (err) {
      failed.push(`${file}: ${(err as Error).message}`);
    }
  }
  return { updated, failed };
}

export function registerKnowledgeTools(server: McpServer): void {
  server.registerTool(
    "intune_troubleshooting_guide",
    {
      title: "Intune advanced troubleshooting knowledge",
      description:
        "Deep Intune troubleshooting methodology bundled with this server: a four-tier escalating " +
        "approach (1: built-in Windows forensics, 2: live process tracing, 3: .NET decompilation of the " +
        "Intune Management Extension, 4: native code analysis) plus ready-to-run collector scripts and " +
        "worked examples. Call with item 'method' first when investigating enrollment failures, sync " +
        "issues, stuck app installs, compliance mismatches or policy application problems on Windows. " +
        "Set refresh:true to pull the current version from the source repository into a local cache. " +
        `Available items: ${Object.entries(ITEMS)
          .map(([k, v]) => `'${k}' (${v.what})`)
          .join("; ")}.`,
      inputSchema: {
        item: z
          .enum(Object.keys(ITEMS) as [string, ...string[]])
          .optional()
          .describe("Which knowledge item to read. Default: 'method'."),
        refresh: z
          .boolean()
          .optional()
          .describe("Fetch the latest version from the source repository first (needs internet)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ item, refresh }) => {
      try {
        let refreshNote = "";
        if (refresh) {
          // Refresh fetches from the internet and writes files, so it is a write.
          const blocked = readOnlyReason();
          if (blocked) {
            return errorResult(
              `Geweigerd: verversen schrijft bestanden en schrijven is uitgeschakeld (${blocked}). ` +
                "Vraag de kennis op zonder refresh om de meegeleverde versie te lezen."
            );
          }
          const result = await refreshFromSource();
          refreshNote =
            `\n\n[verversing: ${result.updated.length} bestand(en) bijgewerkt vanaf de bron` +
            (result.failed.length > 0 ? `, ${result.failed.length} mislukt: ${result.failed.join("; ")}` : "") +
            `, opgeslagen in ${cacheDir()}]`;
        }

        const chosen = ITEMS[item ?? "method"];
        const cached = cachePathFor(chosen.file);
        const bundled = join(BUNDLED_DIR, ...chosen.file.split("/"));

        let path: string;
        let source: string;
        if (existsSync(cached)) {
          path = cached;
          source = `lokale cache, bijgewerkt ${statSync(cached).mtime.toISOString().slice(0, 10)}`;
        } else if (existsSync(bundled)) {
          path = bundled;
          source = "meegeleverde snapshot in de server";
        } else {
          throw new Error(
            `Knowledge file missing: ${chosen.file}. Probeer refresh:true om hem vanaf de bron te halen.`
          );
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `[bron: ${source}]${refreshNote}\n\n${readFileSync(path, "utf8")}`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
