import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, graphRequest, jsonResult } from "../http.js";
import { guardWrite } from "../guard.js";

const DEVICE_SELECT =
  "id,deviceName,userPrincipalName,operatingSystem,osVersion,complianceState,managementAgent,enrolledDateTime,lastSyncDateTime,model,manufacturer,serialNumber,isEncrypted,jailBroken,azureADDeviceId";

/** Simple sync/reboot style actions are recoverable; these are not. */
const DESTRUCTIVE_ACTIONS = new Set(["wipe", "retire", "cleanWindowsDevice", "resetPasscode"]);

export function registerIntuneTools(server: McpServer): void {
  server.registerTool(
    "intune_list_devices",
    {
      title: "Intune: list managed devices",
      description:
        "List Intune managed devices with the most relevant admin fields. " +
        'Optional OData filter, e.g. "complianceState eq \'noncompliant\'" or "operatingSystem eq \'Windows\'".',
      inputSchema: {
        filter: z.string().optional(),
        maxItems: z.number().int().min(1).max(2000).optional().default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filter, maxItems }) => {
      try {
        const query: Record<string, string> = { $select: DEVICE_SELECT };
        if (filter) query.$filter = filter;
        return jsonResult(await graphRequest("/deviceManagement/managedDevices", { query, maxItems }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "intune_get_device",
    {
      title: "Intune: device details",
      description: "Full details of one managed device by Intune device id.",
      inputSchema: { deviceId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deviceId }) => {
      try {
        return jsonResult(
          await graphRequest(`/deviceManagement/managedDevices/${encodeURIComponent(deviceId)}`)
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "intune_device_action",
    {
      title: "Intune: remote device action",
      description:
        "Execute a remote action on a managed device. ALWAYS requires confirm:true after explicit user approval. " +
        "For destructive actions (wipe, retire, cleanWindowsDevice, resetPasscode) you must also pass " +
        "expectedDeviceName exactly matching the device, as a second safety check.",
      inputSchema: {
        deviceId: z.string(),
        action: z.enum([
          "syncDevice",
          "rebootNow",
          "remoteLock",
          "shutDown",
          "locateDevice",
          "disableLostMode",
          "windowsDefenderScan",
          "windowsDefenderUpdateSignatures",
          "retire",
          "wipe",
          "cleanWindowsDevice",
          "resetPasscode",
        ]),
        expectedDeviceName: z
          .string()
          .optional()
          .describe("Required for destructive actions: must exactly match the deviceName."),
        confirm: z.boolean().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ deviceId, action, expectedDeviceName, confirm }) => {
      try {
        // Look the device up first so the confirmation names the actual target.
        const device = (await graphRequest(
          `/deviceManagement/managedDevices/${encodeURIComponent(deviceId)}`,
          { query: { $select: "id,deviceName,userPrincipalName,operatingSystem" } }
        )) as { deviceName?: string; userPrincipalName?: string; operatingSystem?: string };

        const guard = guardWrite(
          confirm,
          `Intune action "${action}" on device "${device.deviceName}" (${device.operatingSystem}, user ${device.userPrincipalName}, id ${deviceId})`
        );
        if (guard) return guard;

        if (DESTRUCTIVE_ACTIONS.has(action) && expectedDeviceName !== device.deviceName) {
          return errorResult(
            `Safety check failed: action "${action}" is destructive. Pass expectedDeviceName="${device.deviceName}" ` +
              "(exact match) to prove the right device is targeted. Nothing was executed."
          );
        }

        let body: unknown;
        if (action === "wipe") body = { keepEnrollmentData: false, keepUserData: false };
        if (action === "windowsDefenderScan") body = { quickScan: true };

        await graphRequest(
          `/deviceManagement/managedDevices/${encodeURIComponent(deviceId)}/${action}`,
          { method: "POST", body }
        );
        return jsonResult({
          executed: action,
          device: device.deviceName,
          note: "Action accepted by Intune. Execution on the device can take minutes depending on connectivity.",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "intune_compliance_overview",
    {
      title: "Intune: compliance overview",
      description:
        "Summarize device compliance: counts per compliance state and per OS, plus the list of noncompliant devices. Ideal as input for a report.",
      inputSchema: {
        maxItems: z.number().int().min(1).max(2000).optional().default(1000),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ maxItems }) => {
      try {
        const data = (await graphRequest("/deviceManagement/managedDevices", {
          query: { $select: "id,deviceName,userPrincipalName,operatingSystem,complianceState,lastSyncDateTime" },
          maxItems,
        })) as { value: Array<Record<string, string>> };

        const byState: Record<string, number> = {};
        const byOs: Record<string, number> = {};
        const noncompliant: Array<Record<string, string>> = [];
        for (const d of data.value) {
          byState[d.complianceState] = (byState[d.complianceState] ?? 0) + 1;
          byOs[d.operatingSystem] = (byOs[d.operatingSystem] ?? 0) + 1;
          if (d.complianceState === "noncompliant") noncompliant.push(d);
        }
        return jsonResult({
          totalDevices: data.value.length,
          byComplianceState: byState,
          byOperatingSystem: byOs,
          noncompliantDevices: noncompliant,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "intune_list_apps",
    {
      title: "Intune: list apps",
      description:
        "List mobile/desktop apps registered in Intune, with assignment state. Uses the beta endpoint for the richest data.",
      inputSchema: {
        search: z.string().optional().describe("Case-insensitive match on display name."),
        maxItems: z.number().int().min(1).max(999).optional().default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ search, maxItems }) => {
      try {
        const data = (await graphRequest("/deviceAppManagement/mobileApps", {
          version: "beta",
          query: {
            $select: "id,displayName,publisher,isAssigned,createdDateTime,lastModifiedDateTime",
            $orderby: "displayName",
          },
          maxItems: search ? 999 : maxItems,
        })) as { value: Array<Record<string, unknown>> };
        let value = data.value;
        if (search) {
          const s = search.toLowerCase();
          value = value.filter((a) => String(a.displayName ?? "").toLowerCase().includes(s)).slice(0, maxItems);
        }
        return jsonResult({ count: value.length, value });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "intune_list_policies",
    {
      title: "Intune: compliance and configuration policies",
      description:
        "List device compliance policies and device configuration profiles, including assignment status.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const [compliance, configs] = await Promise.allSettled([
          graphRequest("/deviceManagement/deviceCompliancePolicies", {
            query: { $expand: "assignments" },
            maxItems: 200,
          }),
          graphRequest("/deviceManagement/deviceConfigurations", {
            query: { $expand: "assignments" },
            maxItems: 200,
          }),
        ]);
        const unwrap = (r: PromiseSettledResult<unknown>) =>
          r.status === "fulfilled" ? r.value : `unavailable: ${(r.reason as Error).message?.slice(0, 200)}`;
        return jsonResult({ compliancePolicies: unwrap(compliance), configurationProfiles: unwrap(configs) });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
