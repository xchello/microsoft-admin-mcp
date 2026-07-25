import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "../http.js";
import { auditFilePath, readAudit } from "../audit.js";

export function registerDiagnosticsTools(server: McpServer): void {
  server.registerTool(
    "audit_log",
    {
      title: "Audit log of write actions",
      description:
        "Read the local audit log of every write action this server performed: timestamp, environment, " +
        "tenant, tool, redacted arguments and outcome (ok, error, awaiting_confirmation, blocked_read_only). " +
        "Use this to answer 'what did we change in this tenant', to reconstruct an incident, or to verify " +
        "that a change really went through. The log lives in the user profile and is never pushed to git.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().default(25),
        tool: z.string().optional().describe("Filter on one tool name, e.g. intune_device_action."),
        environment: z.string().optional().describe("Filter on one environment/customer name."),
        since: z
          .string()
          .optional()
          .describe("Only entries from this ISO timestamp onwards, e.g. 2026-07-01T00:00:00Z."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, tool, environment, since }) => {
      try {
        const result = readAudit({ limit, tool, environment, since });
        return jsonResult({
          file: result.file,
          matchingEntries: result.totalEntries,
          shown: result.entries.length,
          newestFirst: result.entries,
          hint:
            result.totalEntries === 0
              ? "Nog geen schrijfacties gelogd (of het logbestand bestaat nog niet)."
              : undefined,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "server_diagnostics",
    {
      title: "Server diagnostics",
      description:
        "Show where this server stores its local data (environments, tenant knowledge, audit log, reports) " +
        "and which optional capabilities are available on this machine. Useful when troubleshooting setup.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const { environmentsFilePath } = await import("../config.js");
        const { knowledgeFilePath } = await import("../knowledge-store.js");
        const { findBrowser } = await import("../render.js");
        const { persistenceStatus } = await import("../token-cache.js");
        return jsonResult({
          storage: {
            environments: environmentsFilePath(),
            tenantKnowledge: knowledgeFilePath(),
            auditLog: auditFilePath(),
          },
          capabilities: {
            pdfAndPngRendering: findBrowser() ?? "geen Edge/Chrome gevonden (zet BROWSER_PATH of gebruik html)",
            persistentTokenCache: persistenceStatus(),
            platform: `${process.platform} ${process.arch}`,
            nodeVersion: process.version,
          },
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
