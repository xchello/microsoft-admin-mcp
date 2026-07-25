#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getActiveEnvironment, log } from "./auth.js";
import { analyzeScript } from "./powershell-analysis.js";
import { recordAudit, redact, scrubText, type AuditEntry } from "./audit.js";
import { registerGraphAzureTools } from "./tools/graph-azure.js";
import { registerEntraTools } from "./tools/entra.js";
import { registerIntuneTools } from "./tools/intune.js";
import { registerPowerShellTools } from "./tools/powershell.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerEnvironmentTools } from "./tools/environments.js";
import { registerReportTools } from "./tools/report.js";
import { registerVisualizeTools } from "./tools/visualize.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerTenantMemoryTools } from "./tools/tenant-memory.js";
import { registerDiagnosticsTools } from "./tools/diagnostics.js";
import { registerMultiTenantTools } from "./tools/multi-tenant.js";
import { noteCount } from "./knowledge-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
  version: string;
};

const INSTRUCTIONS = `
Microsoft admin MCP server (v${pkg.version}) for Azure, Entra ID, Intune and PowerShell.

Working principles:
1. CURRENT INFORMATION FIRST. Before generating PowerShell scripts or choosing API versions,
   verify with psgallery_module_info (latest module versions) and mslearn_search/mslearn_fetch
   (current documented approach). Never pin outdated module versions or use deprecated cmdlets
   (no MSOnline, no AzureAD module; use Microsoft.Graph and Az).
2. MULTI-TENANT. Use environment_list and environment_use to switch between customers. When the
   user asks to connect a NEW tenant, use environment_add (default: interactive browser login, no
   secrets needed); it stores the tenant locally in the user profile, never in a git repository.
   Never ask the user to paste a real client secret in chat; point to 'env:VARNAME' references.
   For cross-customer reports: query each environment in turn, merge rows with a customer column,
   then call export_report once.
3. SAFETY. Read operations run directly. Every write (Graph/Azure non-GET, Intune actions,
   mutating PowerShell) requires explicit user approval and confirm:true. Destructive Intune
   actions additionally require expectedDeviceName. Respect READ_ONLY mode.
4. REPORTS AND VISUALS. For 'give me a report/overview as xlsx/pdf/csv/word', gather data with the
   read tools and finish with export_report. Keep column labels human-friendly (Dutch when the user
   speaks Dutch). For diagrams, architecture overviews and process flows use export_visualization
   (infographic panels with icon cards and flow arrows, or Mermaid).
5. POWERSHELL GENERATION. Scripts must follow modern standards: #Requires headers with pinned
   current versions, comment-based help, [CmdletBinding(SupportsShouldProcess)], Set-StrictMode,
   try/catch with -ErrorAction Stop, objects instead of Write-Host, least-privilege scopes.
6. TROUBLESHOOTING. For Windows/Intune device problems (enrollment, sync, stuck apps, compliance
   mismatches) read intune_troubleshooting_guide item 'method' first and follow its tiered approach.
7. CONTEXT LINE. Every tool result starts with "[microsoft-admin-mcp] <scope> | <LEES/SCHRIJFACTIE>".
   Relay this to the user for every write: name the tenant/environment and the action type explicitly
   before asking for confirmation, so the user always knows where a change will land. When the line
   mentions "N tenantnotities bekend", call tenant_notes before drawing conclusions.
8. TENANT MEMORY. The server keeps a per-tenant knowledge base (tenant_notes / tenant_note_add).
   Read it when starting work on a tenant and before judging compliance or configuration: a note may
   explain that a finding is intentional or technically impossible. Whenever the user states a durable
   tenant-specific fact ("this device runs Windows 11 Home so BitLocker is impossible", "this customer
   has no Intune Plan 2", "always pilot on group X"), store it with tenant_note_add and confirm briefly.
   Do not store one-off task instructions, secrets, or data you can simply query again.
9. DIAGNOSE, DO NOT GUESS. For a compliance verdict use intune_device_compliance_detail, which names the
   failing policy and setting. For app assignments use intune_app_assignments; Graph's isAssigned flag is
   unreliable, assignmentCount is the truth. For deep Windows problems use intune_troubleshooting_guide.
10. CROSS-CUSTOMER WORK. Use multi_tenant_query for anything spanning several customers; it restores the
   active environment afterwards. Feed its rows and columnsSuggestion straight into export_report, and use
   autoChart or explicit charts so the result is visual, not just a table.
11. ACCOUNTABILITY. Every write is recorded in a local audit log; audit_log answers "what did we change
   here". server_diagnostics shows where local data lives and which optional capabilities are present.
`.trim();

const server = new McpServer(
  { name: "microsoft-admin-mcp", version: pkg.version },
  { instructions: INSTRUCTIONS }
);

/**
 * Context header: every tool result starts with one line stating the active
 * environment/tenant and whether this was a read or a write action, so the
 * user always sees WHERE something happened and WHAT kind of action it was.
 */
const LOCAL_READ_TOOLS = new Set([
  "environment_list",
  "environment_use",
  "auth_status",
  "psgallery_module_info",
  "mslearn_search",
  "mslearn_fetch",
  "intune_troubleshooting_guide",
  "tenant_notes",
  "audit_log",
  "server_diagnostics",
]);
const LOCAL_WRITE_TOOLS = new Set([
  "export_report",
  "export_visualization",
  "environment_add",
  "environment_remove",
  "tenant_note_add",
  "tenant_note_remove",
]);

const TENANT_MEMORY_TOOLS = new Set(["tenant_note_add", "tenant_notes", "tenant_note_remove"]);

function activeEnvOrUndefined(): { name: string; tenantId: string } | undefined {
  try {
    return getActiveEnvironment();
  } catch {
    return undefined;
  }
}

interface Classification {
  header: string;
  isWrite: boolean;
}

function classify(
  toolName: string,
  args: Record<string, unknown> | undefined,
  readOnlyHint: boolean
): Classification {
  const env = activeEnvOrUndefined();
  let scope: string;
  let action: string;
  let isWrite: boolean;

  if (TENANT_MEMORY_TOOLS.has(toolName)) {
    scope = env
      ? `lokale kennisbank van omgeving "${env.name}" (tenant ${env.tenantId})`
      : "lokale kennisbank";
    isWrite = !readOnlyHint;
    action = isWrite ? "SCHRIJFACTIE (lokaal bestand, geen tenant-wijziging)" : "LEESACTIE";
  } else if (toolName === "powershell_run") {
    scope = "lokale machine";
    const analysis = analyzeScript(String(args?.script ?? ""));
    isWrite = analysis.mutating;
    action = isWrite
      ? `SCHRIJFACTIE (PowerShell, ${analysis.because})`
      : `LEESACTIE (PowerShell, ${analysis.because})`;
  } else if (LOCAL_WRITE_TOOLS.has(toolName)) {
    scope = "lokaal";
    isWrite = true;
    action = "SCHRIJFACTIE (lokaal bestand, geen tenant-wijziging)";
  } else if (LOCAL_READ_TOOLS.has(toolName)) {
    scope = "lokaal";
    isWrite = false;
    action = "LEESACTIE";
  } else {
    scope = env ? `omgeving "${env.name}" (tenant ${env.tenantId})` : "geen omgeving geconfigureerd";
    const method = String(args?.method ?? "GET").toUpperCase();
    isWrite =
      toolName === "intune_device_action" ||
      ((toolName === "graph_request" || toolName === "azure_request") && method !== "GET") ||
      (!readOnlyHint && toolName !== "graph_request" && toolName !== "azure_request");
    action = isWrite ? `SCHRIJFACTIE${method !== "GET" ? ` (${method})` : ""}` : "LEESACTIE";

    // Nudge: remind the assistant that tenant-specific knowledge is available.
    if (env) {
      const notes = noteCount(env.tenantId);
      if (notes > 0) {
        action += ` | ${notes} tenantnotitie${notes === 1 ? "" : "s"} bekend (tenant_notes)`;
      }
    }
  }
  return { header: `[microsoft-admin-mcp] ${scope} | ${action}`, isWrite };
}

function outcomeOf(result: { isError?: boolean; content?: Array<{ text?: string }> }): AuditEntry["outcome"] {
  const text = String(result?.content?.[0]?.text ?? "");
  // Order matters: guardWrite returns BLOCKED as an error result, so this check has
  // to come first or a blocked write is indistinguishable from a real failure.
  if (text.startsWith("BLOCKED:")) return "blocked_read_only";
  if (text.startsWith("CONFIRMATION REQUIRED")) return "awaiting_confirmation";
  if (result?.isError) return "error";
  return "ok";
}

/**
 * Tenant selection lives in module state (the active environment), and the MCP SDK
 * dispatches requests concurrently. Without serialization, a multi_tenant_query that
 * switches environments mid-flight would make a parallel call read the wrong customer's
 * tenant, which is the worst failure this server could have. Tools that neither read
 * nor change the active environment stay outside the lock so a long PowerShell run or
 * a slow documentation fetch cannot block tenant work.
 */
const UNSERIALIZED_TOOLS = new Set([
  "powershell_run",
  "psgallery_module_info",
  "mslearn_search",
  "mslearn_fetch",
  "intune_troubleshooting_guide",
  "audit_log",
  "server_diagnostics",
]);

/**
 * The queue slot must be taken when the REQUEST ARRIVES, not when the handler is
 * entered: the SDK validates arguments with an await first, and how many microtasks
 * that costs depends on the schema, so a tool with a simple schema (environment_use)
 * systematically overtakes one queued ahead of it. That reordering was proven to make
 * a call the user approved for customer A execute against customer B.
 */
const LOCK_WAIT_MS = 120_000;
/** Backstop so a request that never reaches its handler cannot wedge the queue. */
const GATE_MAX_MS = 15 * 60_000;

interface Gate {
  wait: Promise<void>;
  release: () => void;
}
const gates = new Map<string | number, Gate>();
let tenantLock: Promise<unknown> = Promise.resolve();

function enqueueGate(id: string | number): void {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  // Chain on both fulfilment and rejection so one failing call cannot wedge the queue.
  const myTurn = tenantLock.then(
    () => undefined,
    () => undefined
  );
  tenantLock = myTurn.then(() => finished);
  const safety = setTimeout(() => finish(), GATE_MAX_MS);
  if (typeof safety.unref === "function") safety.unref();
  gates.set(id, {
    wait: myTurn,
    release: () => {
      clearTimeout(safety);
      gates.delete(id);
      finish();
    },
  });
}

function withTenantLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tenantLock.then(fn, fn);
  tenantLock = run.catch(() => undefined);
  return run;
}

async function waitWithDeadline(wait: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([wait.then(() => true), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function audit(
  tool: string,
  args: unknown,
  outcome: AuditEntry["outcome"],
  detail: string,
  started: number,
  // Captured when the call STARTED: reading it afterwards attributed a long-running
  // PowerShell change to whichever customer happened to be active when it finished.
  env: { name: string; tenantId: string } | undefined
): void {
  recordAudit({
    ts: new Date().toISOString(),
    environment: env?.name ?? "-",
    tenantId: env?.tenantId ?? "-",
    tool,
    outcome,
    args: redact(args),
    // Result text can contain a freshly created secret (Graph addPassword returns one
    // as a plain value), so it goes through the value scrubber before it hits disk.
    detail: scrubText(detail).slice(0, 400),
    durationMs: Date.now() - started,
  });
}

// Wrap registerTool: prepend the context header and audit every write action.
const origRegisterTool = server.registerTool.bind(server);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(server as any).registerTool = (name: string, cfg: any, handler: any) =>
  origRegisterTool(name, cfg, (async (args: any, extra: any) => {
    const invoke = async () => {
      const started = Date.now();
      const cls = classify(name, args, cfg?.annotations?.readOnlyHint === true);
      const startEnv = activeEnvOrUndefined();
      let result: any;
      try {
        result = await handler(args, extra);
      } catch (err) {
        if (cls.isWrite) {
          audit(name, args, "error", (err as Error).message ?? "unknown error", started, startEnv);
        }
        throw err;
      }
      if (cls.isWrite) {
        audit(name, args, outcomeOf(result), String(result?.content?.[0]?.text ?? ""), started, startEnv);
      }
      return {
        ...result,
        content: [{ type: "text", text: cls.header }, ...(result?.content ?? [])],
      };
    };

    if (UNSERIALIZED_TOOLS.has(name)) return invoke();

    const gate = extra?.requestId !== undefined ? gates.get(extra.requestId) : undefined;
    if (!gate) return withTenantLock(invoke); // no arrival hook available: still serialize
    const ourTurn = await waitWithDeadline(gate.wait, LOCK_WAIT_MS);
    if (!ourTurn) {
      gate.release();
      return {
        isError: true,
        content: [
          { type: "text", text: classify(name, args, cfg?.annotations?.readOnlyHint === true).header },
          {
            type: "text",
            text:
              "BEZIG: een andere tenant-bewerking loopt nog en is niet binnen twee minuten klaar. " +
              "Er is niets uitgevoerd. Wacht tot die klaar is (of tot de aanmelding is afgerond) en probeer opnieuw.",
          },
        ],
      };
    }
    try {
      return await invoke();
    } finally {
      gate.release();
    }
  }) as any);

// Prompt template: generate a modern PowerShell script the right way.
server.registerPrompt(
  "generate-powershell",
  {
    title: "Generate a modern PowerShell script",
    description:
      "Guided workflow to generate an enterprise-grade PowerShell script using current module versions and current Microsoft guidance.",
    argsSchema: {
      goal: z.string().describe("What the script should accomplish"),
    },
  },
  ({ goal }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Generate a production-grade PowerShell script for the following goal:

${goal}

Follow this workflow strictly:
1. Use psgallery_module_info to find the LATEST versions of every module you will use (e.g. Microsoft.Graph, Az) and pin them in #Requires.
2. Use mslearn_search (and mslearn_fetch for detail) to verify the CURRENT recommended cmdlets and API surface. Never use deprecated modules (MSOnline, AzureAD) or retired endpoints.
3. Write the script with: comment-based help, #Requires -Version 7.0 and pinned modules, [CmdletBinding(SupportsShouldProcess)], Set-StrictMode -Version Latest, $ErrorActionPreference='Stop', try/catch/finally with disconnect cleanup, typed output objects (no Write-Host for data), least-privilege Graph scopes, and -WhatIf support for every mutating operation.
4. Offer to test the read-only parts via powershell_run before the user runs the full script.`,
        },
      },
    ],
  })
);

registerEnvironmentTools(server);
registerGraphAzureTools(server, pkg.version);
registerEntraTools(server);
registerIntuneTools(server);
registerPowerShellTools(server);
registerDocsTools(server);
registerReportTools(server);
registerVisualizeTools(server);
registerKnowledgeTools(server);
registerTenantMemoryTools(server);
registerDiagnosticsTools(server);
registerMultiTenantTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

// Hook the transport AFTER connect: this is the only place where request arrival order
// is still observable, and tenant serialization must follow that order (see enqueueGate).
/* eslint-disable @typescript-eslint/no-explicit-any */
// Spread the arguments through untouched: the SDK has changed this signature between
// versions, and we only care about inspecting the first argument.
const originalOnMessage = transport.onmessage?.bind(transport) as ((...args: any[]) => void) | undefined;
(transport as any).onmessage = (...args: any[]) => {
  const message = args[0];
  const tool = message?.params?.name;
  if (
    message?.method === "tools/call" &&
    message?.id !== undefined &&
    typeof tool === "string" &&
    !UNSERIALIZED_TOOLS.has(tool)
  ) {
    enqueueGate(message.id);
  }
  originalOnMessage?.(...args);
};

// Backstop: a request that never reaches its handler (for example an argument that
// fails schema validation) still gets a response, so release the slot there too.
const originalSend = transport.send.bind(transport) as (...args: any[]) => Promise<void>;
(transport as any).send = async (...args: any[]) => {
  const message = args[0];
  if (message?.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    gates.get(message.id)?.release();
  }
  return originalSend(...args);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

log(`microsoft-admin-mcp v${pkg.version} running on stdio`);
