import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult } from "../http.js";

/**
 * Bundled expert knowledge, shipped with the server so it is available on
 * every device. Currently: advanced Intune troubleshooting methodology
 * (four-tier forensic approach, based on powerstacks-corp/intune-advanced-troubleshooting,
 * in the investigative style of Rudy Ooms / call4cloud.nl).
 */

const here = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = join(here, "..", "..", "knowledge", "intune-troubleshooting");

const ITEMS: Record<string, { file: string; what: string }> = {
  method: { file: "SKILL.md", what: "The full four-tier troubleshooting methodology" },
  overview: { file: "README.md", what: "Short overview and quick start" },
  "collect-forensics-script": {
    file: join("scripts", "Collect-IntuneForensics.ps1"),
    what: "Tier 1: PowerShell forensic snapshot collector (logs, registry, certificates, events)",
  },
  "ime-decompile-script": {
    file: join("scripts", "Invoke-ImeDecompile.ps1"),
    what: "Tier 3: decompile Intune Management Extension .NET assemblies",
  },
  "native-decompile-script": {
    file: join("scripts", "Invoke-NativeDecompile.ps1"),
    what: "Tier 4: native binary analysis wrapper (Ghidra)",
  },
  "example-check-in": {
    file: join("examples", "last-check-in-analysis.md"),
    what: "Worked example: analyzing a stale last check-in",
  },
  "example-stuck-app": {
    file: join("examples", "stuck-app-install-analysis.md"),
    what: "Worked example: diagnosing a stuck app install",
  },
};

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
        `Available items: ${Object.entries(ITEMS)
          .map(([k, v]) => `'${k}' (${v.what})`)
          .join("; ")}.`,
      inputSchema: {
        item: z
          .enum(Object.keys(ITEMS) as [string, ...string[]])
          .optional()
          .describe("Which knowledge item to read. Default: 'method'."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ item }) => {
      try {
        const chosen = ITEMS[item ?? "method"];
        const path = join(KNOWLEDGE_DIR, chosen.file);
        if (!existsSync(path)) {
          const available = existsSync(KNOWLEDGE_DIR) ? readdirSync(KNOWLEDGE_DIR).join(", ") : "none";
          throw new Error(`Knowledge file missing: ${chosen.file}. Present: ${available}`);
        }
        return { content: [{ type: "text" as const, text: readFileSync(path, "utf8") }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
