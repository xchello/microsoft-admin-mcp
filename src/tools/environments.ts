import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "../http.js";
import {
  GRAPH_SCOPE,
  getActiveEnvironment,
  getToken,
  invalidateEnvironment,
  listEnvironments,
  setActiveEnvironment,
  tokenClaims,
} from "../auth.js";
import { addEnvironmentEntry, environmentsFilePath, removeEnvironmentEntry } from "../config.js";
import { guardWrite } from "../guard.js";

export function registerEnvironmentTools(server: McpServer): void {
  server.registerTool(
    "environment_list",
    {
      title: "List environments (customers/tenants)",
      description:
        "List all configured environments (customer tenants) and show which one is active. " +
        "Environments are stored LOCALLY in the user profile (see environment_add), never in a git repository.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return jsonResult({ storedIn: environmentsFilePath(), environments: listEnvironments() });
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
          note: "All following calls now target this tenant. Authentication happens lazily on the next call, or run environment_login to sign in now.",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "environment_add",
    {
      title: "Add environment (connect a new tenant)",
      description:
        "Interactively add a new customer/tenant and store it LOCALLY in the user profile " +
        "(~/.microsoft-admin-mcp/environments.json). This file is outside every git repository, " +
        "so tenant details never reach GitHub. Default authMode 'interactive' opens a browser to " +
        "sign in, so no secret is needed at all. When a clientSecret is unavoidable, prefer the " +
        "reference form 'env:VARNAME' over pasting a real secret into the chat. " +
        "The new environment becomes active immediately; set login:true (default) to test sign-in right away.",
      inputSchema: {
        name: z.string().describe("Short name, e.g. 'klant-x'"),
        tenantId: z.string().describe("Tenant id (GUID) or domain, e.g. klantx.onmicrosoft.com"),
        authMode: z
          .enum(["auto", "cli", "interactive", "devicecode", "app"])
          .optional()
          .default("interactive")
          .describe("How to sign in. 'interactive' (browser) needs no stored secrets."),
        clientId: z.string().optional().describe("Optional app registration client id."),
        clientSecret: z
          .string()
          .optional()
          .describe("Only for authMode 'app'. Prefer 'env:VARNAME' so no secret is stored in plain text."),
        certificatePath: z.string().optional().describe("PEM certificate path, alternative to clientSecret."),
        description: z.string().optional(),
        login: z.boolean().optional().default(true).describe("Sign in immediately to verify the connection."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ name, tenantId, authMode, clientId, clientSecret, certificatePath, description, login }) => {
      try {
        const file = addEnvironmentEntry({
          name,
          tenantId,
          authMode: authMode ?? "interactive",
          clientId,
          clientSecret,
          certificatePath,
          description,
        });
        setActiveEnvironment(name);
        let identity: unknown = "login skipped (login:false)";
        if (login ?? true) {
          await getToken(GRAPH_SCOPE);
          identity = tokenClaims(GRAPH_SCOPE) ?? "token acquired";
        }
        return jsonResult({
          added: name,
          tenantId,
          authMode: authMode ?? "interactive",
          storedIn: file,
          storageNote:
            "Lokaal opgeslagen in je gebruikersprofiel, buiten het git-repository. Gaat nooit mee naar GitHub.",
          activeEnvironment: name,
          signedInAs: identity,
        });
      } catch (err) {
        // Keep the environment but report the login failure clearly.
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "environment_remove",
    {
      title: "Remove environment",
      description:
        "Remove a stored environment from the local environments.json. Requires confirm:true after user approval. " +
        "The env-var based 'default' environment cannot be removed.",
      inputSchema: {
        name: z.string(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ name, confirm }) => {
      try {
        const guard = guardWrite(confirm, `remove environment "${name}" from ${environmentsFilePath()}`);
        if (guard) return guard;
        const removed = removeEnvironmentEntry(name);
        if (!removed) return errorResult(`No stored environment named "${name}" found (note: 'default' is not stored).`);
        invalidateEnvironment(name);
        return jsonResult({
          removed: name,
          activeEnvironment: getActiveEnvironment().name,
          environments: listEnvironments(),
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "environment_login",
    {
      title: "Sign in to the active environment",
      description:
        "Force authentication for the active environment now (instead of lazily on the next call) and " +
        "return the signed-in identity (user or app). Use after environment_use, or to re-check a connection.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const env = getActiveEnvironment();
        await getToken(GRAPH_SCOPE);
        return jsonResult({
          environment: env.name,
          tenantId: env.tenantId,
          signedInAs: tokenClaims(GRAPH_SCOPE) ?? "token acquired",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
