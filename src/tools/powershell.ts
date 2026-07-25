import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { guardWrite } from "../guard.js";
import { errorResult } from "../http.js";

export const MUTATING_VERBS =
  /\b(Set|New|Remove|Add|Update|Clear|Disable|Enable|Stop|Start|Restart|Reset|Grant|Revoke|Install|Uninstall|Move|Rename|Register|Unregister|Suspend|Resume|Deny|Block|Approve|Invoke)-[A-Za-z]+/;

const OUTPUT_CAP = 60_000;

function findShell(): { cmd: string; args: string[] } {
  // Prefer PowerShell 7 (pwsh), fall back to Windows PowerShell 5.1.
  const candidates =
    process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh"];
  return { cmd: candidates[0], args: [] };
}

async function runPowerShell(
  script: string,
  timeoutMs: number
): Promise<{ exitCode: number | null; stdout: string; stderr: string; shell: string }> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const shells =
    process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh", "powershell"];

  let lastError: Error | undefined;
  for (const shell of shells) {
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(
          shell,
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
          { windowsHide: true }
        );
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`PowerShell timed out after ${timeoutMs} ms`));
        }, timeoutMs);

        child.stdout.on("data", (d) => {
          if (stdout.length < OUTPUT_CAP) stdout += d.toString();
        });
        child.stderr.on("data", (d) => {
          if (stderr.length < OUTPUT_CAP) stderr += d.toString();
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code, stdout, stderr, shell });
        });
      });
    } catch (err) {
      lastError = err as Error;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // try next shell
      throw err;
    }
  }
  throw lastError ?? new Error("No PowerShell executable found (tried pwsh and powershell).");
}

export function registerPowerShellTools(server: McpServer): void {
  server.registerTool(
    "powershell_run",
    {
      title: "Run PowerShell",
      description:
        "Execute a PowerShell script on this machine (pwsh preferred, Windows PowerShell fallback). " +
        "Read-only commands (Get-*, reporting) run directly. Scripts containing mutating verbs " +
        "(Set-, New-, Remove-, Invoke-, etc.) require confirm:true after user approval. " +
        "Output of both stdout and stderr is returned, capped at 60 KB.",
      inputSchema: {
        script: z.string().describe("The PowerShell script to execute."),
        confirm: z
          .boolean()
          .optional()
          .describe("Required (true) when the script contains mutating commands."),
        timeoutSeconds: z.number().int().min(1).max(1800).optional().default(120),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ script, confirm, timeoutSeconds }) => {
      try {
        if (!config.powershellEnabled) {
          return errorResult("PowerShell execution is disabled (POWERSHELL_ENABLED=false).");
        }
        const match = script.match(MUTATING_VERBS);
        if (match) {
          const guard = guardWrite(
            confirm,
            `run a PowerShell script containing potentially mutating command "${match[0]}". Full script:\n${script.slice(0, 1500)}`
          );
          if (guard) return guard;
        }
        const result = await runPowerShell(script, (timeoutSeconds ?? 120) * 1000);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  shell: result.shell,
                  exitCode: result.exitCode,
                  stdout: result.stdout.trim(),
                  stderr: result.stderr.trim(),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
