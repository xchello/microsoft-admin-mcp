import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, graphBatch, graphRequest, jsonResult } from "../http.js";
import { guardWrite } from "../guard.js";
import { missingScopeMessage, scopesForDeviceAction } from "../scopes.js";

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
        const data = (await graphRequest("/deviceManagement/managedDevices", { query, maxItems })) as {
          count: number;
          truncatedAt?: number;
          value: unknown[];
        };
        return jsonResult({
          ...data,
          // Say it out loud: a capped list presented as complete leads to wrong conclusions.
          incompleteResult:
            data.truncatedAt !== undefined
              ? `Er zijn meer devices dan de opgevraagde ${data.truncatedAt}; verhoog maxItems of gebruik een filter voor een volledig beeld.`
              : undefined,
        });
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

        // Fail fast with a clear message instead of an opaque 403 halfway through.
        const scopeProblem = missingScopeMessage(scopesForDeviceAction(action), `Intune action "${action}"`);
        if (scopeProblem) return errorResult(scopeProblem);

        if (DESTRUCTIVE_ACTIONS.has(action)) {
          // Refuse when Graph gave us no usable name to compare against: otherwise both
          // sides are undefined (or blank), the comparison passes, and a wipe runs with
          // effectively no name supplied.
          if (!device.deviceName || device.deviceName.trim() === "") {
            return errorResult(
              `Safety check failed: action "${action}" is destructive, but Graph returned no deviceName for id ${deviceId}, ` +
                "so the target cannot be verified. Nothing was executed. Verify the device in the Intune portal first."
            );
          }
          if (!expectedDeviceName || expectedDeviceName !== device.deviceName) {
            return errorResult(
              `Safety check failed: action "${action}" is destructive. Pass expectedDeviceName="${device.deviceName}" ` +
                "(exact match) to prove the right device is targeted. Nothing was executed."
            );
          }
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
        })) as { value: Array<Record<string, string>>; truncatedAt?: number };

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
          incompleteResult:
            data.truncatedAt !== undefined
              ? `Let op: alleen de eerste ${data.truncatedAt} devices zijn meegenomen, de tenant heeft er meer. Deze cijfers zijn dus geen tenantbreed totaal.`
              : undefined,
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
        "List mobile/desktop apps registered in Intune with their real assignment state. " +
        "Assignments are expanded, because Graph's own isAssigned flag can be stale: assignmentCount " +
        "is the trustworthy value. Includes the app type (Win32, WinGet, macOS pkg/dmg, Office suite) " +
        "so Windows and macOS versions of the same product are easy to tell apart. " +
        "Use intune_app_assignments for the group names behind an app.",
      inputSchema: {
        search: z.string().optional().describe("Case-insensitive match on display name."),
        unassignedOnly: z.boolean().optional().describe("Only apps without any assignment."),
        maxItems: z.number().int().min(1).max(999).optional().default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ search, unassignedOnly, maxItems }) => {
      try {
        const data = (await graphRequest("/deviceAppManagement/mobileApps", {
          version: "beta",
          query: {
            // @odata.type must be selected explicitly, otherwise the app type is empty
            // and every macOS app would be reported as Windows.
            $select: "id,displayName,publisher,isAssigned,createdDateTime,lastModifiedDateTime",
            $expand: "assignments",
            $orderby: "displayName",
          },
          maxItems: search || unassignedOnly ? 999 : maxItems,
        })) as { value: Array<Record<string, unknown>>; truncatedAt?: number };

        let value = data.value.map((app) => {
          const assignments = Array.isArray(app.assignments) ? app.assignments : [];
          const type = String(app["@odata.type"] ?? "").replace("#microsoft.graph.", "");
          return {
            id: app.id,
            displayName: app.displayName,
            publisher: app.publisher,
            appType: type,
            platform: /^macOS/i.test(type) ? "macOS" : /ios/i.test(type) ? "iOS" : "Windows",
            assignmentCount: assignments.length,
            intents: [...new Set(assignments.map((a) => String((a as Record<string, unknown>).intent)))],
            isAssignedFlagFromGraph: app.isAssigned,
            createdDateTime: app.createdDateTime,
            lastModifiedDateTime: app.lastModifiedDateTime,
          };
        });

        if (search) {
          const s = search.toLowerCase();
          value = value.filter((a) => String(a.displayName ?? "").toLowerCase().includes(s));
        }
        if (unassignedOnly) value = value.filter((a) => a.assignmentCount === 0);
        // Count before slicing, otherwise a page-local number is presented as a total.
        const matched = value.length;
        const unassignedCount = value.filter((a) => a.assignmentCount === 0).length;
        value = value.slice(0, maxItems);

        return jsonResult({
          count: value.length,
          matchedBeforeLimit: matched,
          unassignedCount,
          incompleteResult:
            data.truncatedAt !== undefined
              ? `Let op: er zijn meer apps in de tenant dan opgehaald (${data.truncatedAt}); unassignedCount geldt alleen over wat is opgehaald.`
              : matched > value.length
                ? `${matched - value.length} van de ${matched} treffers zijn niet weergegeven vanwege maxItems.`
                : undefined,
          value,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "intune_app_assignments",
    {
      title: "Intune: app assignments with group names",
      description:
        "Show exactly who an app is assigned to: intent (required, available, uninstall), target type " +
        "(group, all devices, all licensed users) and the resolved group display names. Group names are " +
        "fetched in a single batched request. Use this before changing or removing an app assignment.",
      inputSchema: { appId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ appId }) => {
      try {
        const app = (await graphRequest(`/deviceAppManagement/mobileApps/${encodeURIComponent(appId)}`, {
          version: "beta",
          query: { $expand: "assignments" },
        })) as Record<string, unknown>;

        const assignments = (Array.isArray(app.assignments) ? app.assignments : []) as Array<
          Record<string, unknown>
        >;
        const groupIds = [
          ...new Set(
            assignments
              .map((a) => (a.target as Record<string, unknown> | undefined)?.groupId)
              .filter((g): g is string => typeof g === "string")
          ),
        ];

        // One batched call instead of one request per group.
        const names = new Map<string, string>();
        if (groupIds.length > 0) {
          const responses = await graphBatch(
            groupIds.map((id, index) => ({
              id: String(index),
              url: `/groups/${id}?$select=id,displayName`,
            })),
            { version: "v1.0" }
          );
          responses.forEach((response, index) => {
            const body = response.body as { displayName?: string } | undefined;
            const groupId = groupIds[index];
            names.set(
              groupId,
              response.status === 200 && body?.displayName
                ? body.displayName
                : `(groep niet gevonden of geen leesrecht: ${groupId})`
            );
          });
        }

        return jsonResult({
          app: { id: app.id, displayName: app.displayName, type: app["@odata.type"] },
          assignmentCount: assignments.length,
          assignments: assignments.map((a) => {
            const target = (a.target ?? {}) as Record<string, unknown>;
            const targetType = String(target["@odata.type"] ?? "").replace("#microsoft.graph.", "");
            const groupId = typeof target.groupId === "string" ? target.groupId : undefined;
            return {
              intent: a.intent,
              targetType,
              groupId,
              groupName: groupId ? names.get(groupId) : undefined,
              filterId: target.deviceAndAppManagementAssignmentFilterId ?? undefined,
              filterType: target.deviceAndAppManagementAssignmentFilterType ?? undefined,
            };
          }),
          hint:
            assignments.length === 0
              ? "Deze app heeft geen enkele toewijzing en doet dus niets in de tenant."
              : undefined,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "intune_device_compliance_detail",
    {
      title: "Intune: why is this device (non)compliant",
      description:
        "Explain the compliance verdict of one device: which policies apply, which of them fail, and " +
        "exactly which setting inside a failing policy is the culprit (with error code and current value). " +
        "Setting states are fetched in one batched request. For Windows devices the encryption and " +
        "Defender state is included too. Use this instead of guessing why a device shows as noncompliant.",
      inputSchema: { deviceId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deviceId }) => {
      try {
        const id = encodeURIComponent(deviceId);
        const device = (await graphRequest(`/deviceManagement/managedDevices/${id}`, {
          query: {
            $select:
              "id,deviceName,userPrincipalName,operatingSystem,osVersion,complianceState,lastSyncDateTime,isEncrypted",
          },
        })) as Record<string, unknown>;

        const states = (await graphRequest(
          `/deviceManagement/managedDevices/${id}/deviceCompliancePolicyStates`,
          { version: "beta", maxItems: 50 }
        )) as { value: Array<Record<string, unknown>> };

        // Only failing policies need their settings inspected; batch those lookups.
        const failing = states.value.filter(
          (s) => String(s.state).toLowerCase() !== "compliant" && String(s.state).toLowerCase() !== "notapplicable"
        );
        const settingResponses =
          failing.length > 0
            ? await graphBatch(
                failing.map((s, index) => ({
                  id: String(index),
                  url: `/deviceManagement/managedDevices/${deviceId}/deviceCompliancePolicyStates/${String(s.id)}/settingStates`,
                })),
                { version: "beta" }
              )
            : [];

        const failingPolicies = failing.map((policy, index) => {
          const response = settingResponses[index];
          // A failed sub-request must never be presented as "no failing setting found":
          // that would turn a permission problem into a fabricated diagnosis.
          if (response && response.status !== 200) {
            return {
              policyName: policy.displayName,
              platformType: policy.platformType,
              state: policy.state,
              appliesToUser: policy.userPrincipalName,
              failedSettings: [],
              settingsLookupFailed: `HTTP ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`,
              note:
                "De instellingen van deze policy konden niet worden opgehaald, dus de oorzaak is hier NIET vastgesteld. Controleer je rechten (DeviceManagementConfiguration.Read.All) en probeer opnieuw.",
            };
          }
          const body = response?.body as { value?: Array<Record<string, unknown>> } | undefined;
          const settings = body?.value ?? [];
          const failedSettings = settings
            .filter((s) => String(s.state).toLowerCase() !== "compliant")
            .map((s) => ({
              settingName: s.settingName,
              state: s.state,
              errorCode: s.errorCode,
              errorDescription: s.errorDescription,
              currentValue: s.currentValue,
            }));
          return {
            policyName: policy.displayName,
            platformType: policy.platformType,
            state: policy.state,
            appliesToUser: policy.userPrincipalName,
            failedSettings,
            note:
              failedSettings.length === 0
                ? "Policy staat als niet-compliant maar levert geen falende instelling op; meestal betekent dit dat het device de policy nog niet heeft geëvalueerd of te lang niet heeft ingecheckt."
                : undefined,
          };
        });

        // Windows-only extras; never fatal when unavailable.
        let protection: unknown = "niet opgehaald (geen Windows-device)";
        if (String(device.operatingSystem).toLowerCase().includes("windows")) {
          try {
            protection = await graphRequest(
              `/deviceManagement/managedDevices/${id}/windowsProtectionState`,
              { version: "beta" }
            );
          } catch (err) {
            protection = `niet beschikbaar: ${(err as Error).message.slice(0, 200)}`;
          }
        }

        return jsonResult({
          device,
          verdict: device.complianceState,
          policiesEvaluated: states.value.length,
          failingPolicies,
          compliantPolicies: states.value
            .filter((s) => String(s.state).toLowerCase() === "compliant")
            .map((s) => s.displayName),
          windowsProtectionState: protection,
          hint:
            failingPolicies.length === 0 && String(device.complianceState) !== "compliant"
              ? "Geen falende policy gevonden terwijl het device niet compliant is: check lastSyncDateTime, het device is dan vermoedelijk te lang niet in contact geweest."
              : undefined,
        });
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
