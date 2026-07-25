import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { armRequest, errorResult, graphRequest, jsonResult } from "../http.js";
import { guardWrite } from "../guard.js";
import { authStatus, tokenClaims, GRAPH_SCOPE } from "../auth.js";

export function registerGraphAzureTools(server: McpServer, version: string): void {
  server.registerTool(
    "auth_status",
    {
      title: "Authentication status",
      description:
        "Show the server version, configured auth mode, tenant, cached tokens and the identity " +
        "(user or app) of the current Microsoft Graph token. Use this first when troubleshooting.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return jsonResult({
          serverVersion: version,
          ...authStatus(),
          graphIdentity: tokenClaims(GRAPH_SCOPE) ?? "no Graph token acquired yet",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "graph_request",
    {
      title: "Microsoft Graph request",
      description:
        "Call any Microsoft Graph endpoint (Entra ID, Intune, users, groups, devices, policies, mail, etc.). " +
        "GET requests run directly and page automatically. POST/PATCH/PUT/DELETE require confirm:true after " +
        "user approval. Use OData parameters ($select, $filter, $search, $orderby, $count) to keep results small. " +
        "Prefer version v1.0; use beta only when the property or endpoint does not exist in v1.0 " +
        "(much of Intune management still requires beta).",
      inputSchema: {
        path: z.string().describe('Graph path, e.g. "/users" or "/deviceManagement/managedDevices"'),
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).optional().default("GET"),
        version: z.enum(["v1.0", "beta"]).optional(),
        queryParams: z
          .record(z.string())
          .optional()
          .describe('OData query parameters, e.g. {"$select":"displayName,id","$top":"50"}'),
        body: z.unknown().optional().describe("JSON body for POST/PATCH/PUT."),
        maxItems: z.number().int().min(1).max(2000).optional().default(100),
        confirm: z.boolean().optional().describe("Required (true) for non-GET requests."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ path, method, version: v, queryParams, body, maxItems, confirm }) => {
      try {
        const m = method ?? "GET";
        if (m !== "GET") {
          const guard = guardWrite(
            confirm,
            `${m} ${v ?? "v1.0"}${path} with body: ${JSON.stringify(body ?? {}).slice(0, 800)}`
          );
          if (guard) return guard;
        }
        const data = await graphRequest(path, {
          method: m,
          version: v,
          query: queryParams,
          body,
          maxItems,
        });
        return jsonResult(data);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "azure_request",
    {
      title: "Azure Resource Manager request",
      description:
        "Call the Azure Resource Manager REST API (subscriptions, resource groups, VMs, storage, policy, RBAC, etc.). " +
        "Always pass apiVersion. GET runs directly; other methods require confirm:true after user approval. " +
        'Examples: path "/subscriptions" apiVersion "2022-12-01", or a full resource id path.',
      inputSchema: {
        path: z
          .string()
          .describe('ARM path, e.g. "/subscriptions" or "/subscriptions/{id}/resourceGroups"'),
        apiVersion: z.string().describe('ARM api-version, e.g. "2022-12-01". Check mslearn_search when unsure.'),
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).optional().default("GET"),
        queryParams: z.record(z.string()).optional(),
        body: z.unknown().optional(),
        confirm: z.boolean().optional().describe("Required (true) for non-GET requests."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ path, apiVersion, method, queryParams, body, confirm }) => {
      try {
        const m = method ?? "GET";
        if (m !== "GET") {
          const guard = guardWrite(
            confirm,
            `${m} ${path} (api-version ${apiVersion}) with body: ${JSON.stringify(body ?? {}).slice(0, 800)}`
          );
          if (guard) return guard;
        }
        const data = await armRequest(path, { method: m, apiVersion, query: queryParams, body });
        return jsonResult(data);
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
