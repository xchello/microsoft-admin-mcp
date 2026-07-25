#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { log } from "./auth.js";
import { registerGraphAzureTools } from "./tools/graph-azure.js";
import { registerEntraTools } from "./tools/entra.js";
import { registerIntuneTools } from "./tools/intune.js";
import { registerPowerShellTools } from "./tools/powershell.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerEnvironmentTools } from "./tools/environments.js";
import { registerReportTools } from "./tools/report.js";
import { registerVisualizeTools } from "./tools/visualize.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";

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
2. MULTI-TENANT. Use environment_list and environment_use to switch between customers.
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
`.trim();

const server = new McpServer(
  { name: "microsoft-admin-mcp", version: pkg.version },
  { instructions: INSTRUCTIONS }
);

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

const transport = new StdioServerTransport();
await server.connect(transport);
log(`microsoft-admin-mcp v${pkg.version} running on stdio`);
