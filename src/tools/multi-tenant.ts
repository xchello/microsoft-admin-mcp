import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, graphRequest, jsonResult } from "../http.js";
import { getActiveEnvironment, listEnvironments, setActiveEnvironment } from "../auth.js";

/** One merged output row. Values are scalars only, so it can go straight into export_report. */
type FlatRow = Record<string, string | number | boolean | null>;

interface Column {
  key: string;
  label: string;
}

interface TenantResult {
  environment: string;
  tenantId?: string;
  rowCount: number;
  error?: string;
}

type Dataset =
  | "devices"
  | "noncompliant_devices"
  | "compliance_summary"
  | "users"
  | "groups"
  | "apps";

interface DatasetSpec {
  path: string;
  version: "v1.0" | "beta";
  /** Fields requested via $select AND the column order of the merged rows. */
  fields: string[];
  filter?: string;
  orderby?: string;
}

const DEVICE_FIELDS = [
  "deviceName",
  "userPrincipalName",
  "operatingSystem",
  "osVersion",
  "complianceState",
  "lastSyncDateTime",
  "model",
  "isEncrypted",
];

const DATASETS: Record<Dataset, DatasetSpec> = {
  devices: {
    path: "/deviceManagement/managedDevices",
    version: "v1.0",
    fields: DEVICE_FIELDS,
  },
  noncompliant_devices: {
    path: "/deviceManagement/managedDevices",
    version: "v1.0",
    fields: DEVICE_FIELDS,
    filter: "complianceState eq 'noncompliant'",
  },
  // Aggregated per tenant: fetched like `devices`, then folded into a single row.
  compliance_summary: {
    path: "/deviceManagement/managedDevices",
    version: "v1.0",
    fields: DEVICE_FIELDS,
  },
  users: {
    path: "/users",
    version: "v1.0",
    fields: ["displayName", "userPrincipalName", "accountEnabled", "jobTitle", "department"],
  },
  groups: {
    path: "/groups",
    version: "v1.0",
    fields: ["displayName", "description", "securityEnabled", "mailEnabled"],
  },
  // mobileApps only exposes isAssigned reliably on beta.
  apps: {
    path: "/deviceAppManagement/mobileApps",
    version: "beta",
    fields: ["displayName", "publisher", "isAssigned"],
    orderby: "displayName",
  },
};

/** Friendly Dutch labels, ready for export_report's `columns` parameter. */
const LABELS: Record<string, string> = {
  deviceName: "Apparaat",
  userPrincipalName: "Gebruiker",
  operatingSystem: "Besturingssysteem",
  osVersion: "OS-versie",
  complianceState: "Compliance",
  lastSyncDateTime: "Laatste sync",
  model: "Model",
  isEncrypted: "Versleuteld",
  displayName: "Naam",
  accountEnabled: "Actief",
  jobTitle: "Functie",
  department: "Afdeling",
  description: "Omschrijving",
  securityEnabled: "Beveiligingsgroep",
  mailEnabled: "Mail-groep",
  publisher: "Uitgever",
  isAssigned: "Toegewezen",
  total: "Totaal apparaten",
  compliant: "Compliant",
  noncompliant: "Niet compliant",
  compliancePercentage: "Compliance %",
};

function labelFor(key: string, customerColumn: string): string {
  if (key === customerColumn) return "Klant";
  const known = LABELS[key];
  if (known) return known;
  // Fall back to a readable label: "osBuildNumber" -> "Os build number".
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Coerce a Graph value into something a spreadsheet cell can hold. */
function flatten(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  // Nested objects/arrays would break export_report; keep a compact readable form.
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  return JSON.stringify(value);
}

/** Narrow an unknown graphRequest result to its collection items. */
function collectionItems(result: unknown): Array<Record<string, unknown>> {
  if (result && typeof result === "object" && Array.isArray((result as { value?: unknown }).value)) {
    return (result as { value: unknown[] }).value.filter(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null
    );
  }
  return [];
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Graph errors carry a whole JSON body; keep it short enough to stay readable in a report.
  return raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
}

/**
 * Fold one tenant's devices into a single aggregated row: totals, per compliance
 * state, a count per operating system and the compliance percentage.
 */
function summarizeCompliance(
  items: Array<Record<string, unknown>>,
  customerColumn: string,
  environmentName: string
): FlatRow {
  let compliant = 0;
  let noncompliant = 0;
  const perOs = new Map<string, number>();

  for (const item of items) {
    const state = typeof item.complianceState === "string" ? item.complianceState : "unknown";
    if (state === "compliant") compliant++;
    if (state === "noncompliant") noncompliant++;
    const os = typeof item.operatingSystem === "string" && item.operatingSystem ? item.operatingSystem : "onbekend";
    perOs.set(os, (perOs.get(os) ?? 0) + 1);
  }

  const total = items.length;
  const row: FlatRow = {
    [customerColumn]: environmentName,
    total,
    compliant,
    noncompliant,
    compliancePercentage: total === 0 ? 0 : Math.round((compliant / total) * 1000) / 10,
  };
  // One extra flat column per OS, sorted high to low so the biggest platform comes first.
  for (const [os, count] of [...perOs.entries()].sort((a, b) => b[1] - a[1])) {
    row[`os_${os}`] = count;
  }
  return row;
}

export function registerMultiTenantTools(server: McpServer): void {
  server.registerTool(
    "multi_tenant_query",
    {
      title: "Multi-tenant query (multiple customers in one call)",
      description:
        "Query the SAME dataset across MULTIPLE customer tenants in one call and return one merged, flat table " +
        "with a customer column per row. This is the right way to build a cross-customer report: use it instead " +
        "of calling environment_use / intune_list_devices / entra_list_users repeatedly and merging by hand. " +
        "Typical requests: 'geef me het compliance rapport voor klant X en Y', 'welke apparaten zijn niet " +
        "compliant bij al mijn klanten', 'vergelijk het aantal gebruikers per klant'. " +
        "Omit `environments` to cover every configured tenant. Datasets: devices, noncompliant_devices, " +
        "compliance_summary (one aggregated row per customer), users, groups, apps. " +
        "Tenants are queried sequentially and a failure at one customer (sign-in, missing permission, throttling) " +
        "never aborts the others: it is reported in `perTenant`. The environment that was active before the call " +
        "is always restored afterwards, so nothing else starts targeting the wrong customer. " +
        "Pass the returned `rows` and `columnsSuggestion` straight to export_report. " +
        "Read-only: it never writes to any tenant. For a single customer the regular per-tenant tools are simpler.",
      inputSchema: {
        environments: z
          .array(z.string())
          .optional()
          .describe(
            "Environment names as shown by environment_list. Omitted or empty means ALL configured environments."
          ),
        dataset: z
          .enum(["devices", "noncompliant_devices", "compliance_summary", "users", "groups", "apps"])
          .describe("Which data to collect per tenant."),
        maxItemsPerTenant: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .default(500)
          .describe("Cap on items fetched per tenant, to keep large tenants manageable."),
        customerColumn: z
          .string()
          .optional()
          .default("klant")
          .describe("Name of the column that identifies the tenant in the merged rows."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ environments, dataset, maxItemsPerTenant, customerColumn }) => {
      // Remember the caller's environment BEFORE anything switches, and restore it in finally.
      // Leaving the wrong tenant active would silently retarget every following action.
      let previousEnvironment: string | undefined;
      try {
        previousEnvironment = getActiveEnvironment().name;
      } catch {
        previousEnvironment = undefined;
      }

      const column = customerColumn && customerColumn.trim() ? customerColumn.trim() : "klant";
      const limit = maxItemsPerTenant ?? 500;
      const spec = DATASETS[dataset as Dataset];

      try {
        const configured = listEnvironments().map((e) => String(e.name));
        const requested =
          environments && environments.length > 0 ? environments : configured;

        if (requested.length === 0) {
          return errorResult(
            "Er zijn geen omgevingen geconfigureerd. Voeg eerst een klant toe met environment_add."
          );
        }

        const rows: FlatRow[] = [];
        const perTenant: TenantResult[] = [];
        const extraKeys = new Set<string>();

        // Sequential on purpose: all environments share one credential/token cache,
        // so switching in parallel would race and mix tenants.
        for (const name of requested) {
          let tenantId: string | undefined;
          try {
            // Unknown names throw here; that must land in perTenant, not crash the call.
            const env = setActiveEnvironment(name);
            tenantId = env.tenantId;

            const query: Record<string, string> = { $select: spec.fields.join(",") };
            if (spec.filter) query.$filter = spec.filter;
            if (spec.orderby) query.$orderby = spec.orderby;

            const result = await graphRequest(spec.path, {
              version: spec.version,
              query,
              maxItems: limit,
            });
            const items = collectionItems(result);

            if (dataset === "compliance_summary") {
              const summary = summarizeCompliance(items, column, env.name);
              for (const key of Object.keys(summary)) {
                if (key !== column && !["total", "compliant", "noncompliant", "compliancePercentage"].includes(key)) {
                  extraKeys.add(key);
                }
              }
              rows.push(summary);
              perTenant.push({ environment: env.name, tenantId, rowCount: 1 });
            } else {
              for (const item of items) {
                // Customer column first, then the selected fields in a fixed order.
                const row: FlatRow = { [column]: env.name };
                for (const field of spec.fields) row[field] = flatten(item[field]);
                rows.push(row);
              }
              perTenant.push({ environment: env.name, tenantId, rowCount: items.length });
            }
          } catch (err) {
            perTenant.push({
              environment: name,
              tenantId,
              rowCount: 0,
              error: errorMessage(err),
            });
          }
        }

        const columnKeys =
          dataset === "compliance_summary"
            ? [column, "total", "compliant", "noncompliant", "compliancePercentage", ...[...extraKeys].sort()]
            : [column, ...spec.fields];
        const columnsSuggestion: Column[] = columnKeys.map((key) => ({
          key,
          label: labelFor(key, column),
        }));

        const failed = perTenant.filter((t) => t.error);
        const chartColumn = dataset === "compliance_summary" ? column : "complianceState";
        const hints = [
          `Geef 'rows' en 'columnsSuggestion' direct door aan export_report (columns: columnsSuggestion) voor een kant-en-klaar rapport.`,
          `Voor een grafiek: gebruik export_report met autoChart { column: "${chartColumn}" } (of "${column}" voor een verdeling per klant).`,
        ];
        if (failed.length > 0) {
          hints.push(
            `Let op: ${failed.length} van ${perTenant.length} omgeving(en) leverde een fout op; zie 'perTenant'. De overige klanten staan wel in 'rows'.`
          );
        }

        return jsonResult({
          dataset,
          customerColumn: column,
          environmentsQueried: perTenant.map((t) => t.environment),
          rowCount: rows.length,
          rows,
          perTenant,
          columnsSuggestion,
          hint: hints.join(" "),
        });
      } catch (err) {
        return errorResult(err);
      } finally {
        // Always restore, also on an unexpected throw above.
        if (previousEnvironment) {
          try {
            setActiveEnvironment(previousEnvironment);
          } catch {
            /* environment disappeared meanwhile; nothing sensible left to restore */
          }
        }
      }
    }
  );
}
