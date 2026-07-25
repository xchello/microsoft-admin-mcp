import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, graphRequest, jsonResult } from "../http.js";

const USER_SELECT =
  "id,displayName,userPrincipalName,mail,jobTitle,department,accountEnabled,createdDateTime,userType,onPremisesSyncEnabled";

export function registerEntraTools(server: McpServer): void {
  server.registerTool(
    "entra_list_users",
    {
      title: "Entra: list users",
      description:
        "List Entra ID users with sensible default fields. Supports OData filter and search " +
        '(e.g. search "displayName:jan"). For anything more advanced use graph_request.',
      inputSchema: {
        filter: z.string().optional().describe('OData $filter, e.g. "accountEnabled eq false"'),
        search: z.string().optional().describe('$search expression, e.g. "displayName:jan"'),
        select: z.string().optional().describe("Comma-separated fields (default: common admin fields)"),
        maxItems: z.number().int().min(1).max(999).optional().default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filter, search, select, maxItems }) => {
      try {
        const query: Record<string, string> = { $select: select ?? USER_SELECT, $count: "true" };
        if (filter) query.$filter = filter;
        if (search) query.$search = `"${search.replace(/"/g, '\\"')}"`;
        return jsonResult(await graphRequest("/users", { query, maxItems }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "entra_get_user",
    {
      title: "Entra: get user details",
      description:
        "Get one user by id or userPrincipalName, including group memberships, registered devices and license details.",
      inputSchema: {
        idOrUpn: z.string().describe("Object id or userPrincipalName"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ idOrUpn }) => {
      try {
        const id = encodeURIComponent(idOrUpn);
        const [user, memberOf, licenses, devices] = await Promise.allSettled([
          graphRequest(`/users/${id}`, { query: { $select: USER_SELECT + ",assignedLicenses,signInActivity" } }),
          graphRequest(`/users/${id}/memberOf`, {
            query: { $select: "id,displayName" },
            maxItems: 100,
          }),
          graphRequest(`/users/${id}/licenseDetails`, { maxItems: 50 }),
          graphRequest(`/users/${id}/managedDevices`, {
            query: { $select: "id,deviceName,operatingSystem,complianceState,lastSyncDateTime" },
            maxItems: 50,
          }),
        ]);
        const unwrap = (r: PromiseSettledResult<unknown>) =>
          r.status === "fulfilled" ? r.value : `unavailable: ${(r.reason as Error).message?.slice(0, 200)}`;
        return jsonResult({
          user: unwrap(user),
          memberOf: unwrap(memberOf),
          licenses: unwrap(licenses),
          managedDevices: unwrap(devices),
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "entra_list_groups",
    {
      title: "Entra: list groups",
      description: "List Entra ID groups. Optional filter/search.",
      inputSchema: {
        filter: z.string().optional(),
        search: z.string().optional(),
        maxItems: z.number().int().min(1).max(999).optional().default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filter, search, maxItems }) => {
      try {
        const query: Record<string, string> = {
          $select: "id,displayName,description,groupTypes,securityEnabled,mailEnabled,membershipRule",
          $count: "true",
        };
        if (filter) query.$filter = filter;
        if (search) query.$search = `"${search.replace(/"/g, '\\"')}"`;
        return jsonResult(await graphRequest("/groups", { query, maxItems }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "entra_group_members",
    {
      title: "Entra: group members",
      description: "List the members of a group by group id.",
      inputSchema: {
        groupId: z.string(),
        maxItems: z.number().int().min(1).max(999).optional().default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ groupId, maxItems }) => {
      try {
        return jsonResult(
          await graphRequest(`/groups/${encodeURIComponent(groupId)}/members`, {
            query: { $select: "id,displayName,userPrincipalName,mail" },
            maxItems,
          })
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "entra_signin_logs",
    {
      title: "Entra: sign-in logs",
      description:
        "Query recent sign-in logs (requires Entra ID P1/P2 and AuditLog.Read.All). " +
        'Optional OData filter, e.g. "userPrincipalName eq \'jan@contoso.com\'" or "status/errorCode ne 0" for failures.',
      inputSchema: {
        filter: z.string().optional(),
        maxItems: z.number().int().min(1).max(500).optional().default(25),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filter, maxItems }) => {
      try {
        const query: Record<string, string> = {
          $select:
            "createdDateTime,userPrincipalName,appDisplayName,ipAddress,clientAppUsed,conditionalAccessStatus,riskLevelDuringSignIn,status,location",
          $orderby: "createdDateTime desc",
        };
        if (filter) query.$filter = filter;
        return jsonResult(await graphRequest("/auditLogs/signIns", { query, maxItems }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "entra_audit_logs",
    {
      title: "Entra: directory audit logs",
      description:
        "Query directory audit logs (who changed what). Requires AuditLog.Read.All. " +
        'Optional filter, e.g. "activityDisplayName eq \'Add member to group\'".',
      inputSchema: {
        filter: z.string().optional(),
        maxItems: z.number().int().min(1).max(500).optional().default(25),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filter, maxItems }) => {
      try {
        const query: Record<string, string> = { $orderby: "activityDateTime desc" };
        if (filter) query.$filter = filter;
        return jsonResult(await graphRequest("/auditLogs/directoryAudits", { query, maxItems }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
