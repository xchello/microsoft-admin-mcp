import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "../http.js";
import { listEnvironments, setActiveEnvironment } from "../auth.js";

export function registerEnvironmentTools(server: McpServer): void {
  server.registerTool(
    "environment_list",
    {
      title: "List environments (customers/tenants)",
      description:
        "List all configured environments (customer tenants) and show which one is active. " +
        "Environments are defined in ~/.microsoft-admin-mcp/environments.json or via ENVIRONMENTS_FILE.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return jsonResult({ environments: listEnvironments() });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "environment_use",
    {
      title: "Switch environment (customer/tenant)",
      description:
        "Switch the active environment. All subsequent Graph, Azure, Entra and Intune calls target " +
        "this tenant. Use this to work for a different customer, or to combine data from multiple " +
        "customers in one answer or report (switch, query, switch back, query again).",
      inputSchema: {
        name: z.string().describe("Environment name as shown by environment_list."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      try {
        const env = setActiveEnvironment(name);
        return jsonResult({
          activeEnvironment: env.name,
          tenantId: env.tenantId,
          note: "All following calls now target this tenant. Authentication happens lazily on the next call.",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
