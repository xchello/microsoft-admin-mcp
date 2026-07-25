import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { guardWrite } from "../guard.js";
import { errorResult } from "../http.js";
import { analyzeScript } from "../powershell-analysis.js";

/** Maximum characters of stdout and of stderr that are returned to the caller. */
const OUTPUT_CAP = 60_000;

/**
 * -EncodedCommand carries base64 of UTF-16LE, i.e. ~2.67 argument characters per
 * script character. Windows caps a whole command line at 32,767 characters, so
 * from roughly 12,200 script characters the spawn fails with an opaque error.
 * Anything above this threshold goes through a temporary .ps1 file instead.
 */
const MAX_ENCODED_SCRIPT_CHARS = 8_000;

/** How long a shell may take to honour SIGTERM before it gets SIGKILL. */
const KILL_GRACE_MS = 3_000;
/** After SIGKILL we stop waiting for the pipes, so a wedged shell cannot hang us. */
const HARD_EXIT_MS = 2_000;

const BASE_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the returned text is shorter than what the script actually produced. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Bytes produced before capping, so the caller can see how much was dropped. */
  stdoutBytes: number;
  stderrBytes: number;
  shell: string;
  invocation: "EncodedCommand" | "TempFile";
}

/** Append to `text` without ever exceeding OUTPUT_CAP, reporting whether it cut. */
function appendCapped(text: string, chunk: string): { text: string; truncated: boolean } {
  const room = OUTPUT_CAP - text.length;
  if (room <= 0) return { text, truncated: true };
  if (chunk.length <= room) return { text: text + chunk, truncated: false };
  return { text: text + chunk.slice(0, room), truncated: true };
}

function spawnOnce(
  shell: string,
  args: string[],
  timeoutMs: number,
  invocation: RunResult["invocation"]
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(shell, args, { windowsHide: true });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;

    // Removing every listener and timer on the way out guarantees that a late
    // 'error' or 'close' event cannot reject an already settled promise, which
    // would surface as an unhandled rejection and kill the server process.
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (hardTimer) clearTimeout(hardTimer);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      // Swallow anything the dying child still says.
      child.on("error", () => {});
    };

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(err);
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      // Escalate: a wedged pwsh ignores SIGTERM and would otherwise keep running
      // with our pipes attached.
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      hardTimer = setTimeout(
        () =>
          fail(
            new Error(
              `PowerShell timed out after ${timeoutMs} ms and did not exit after SIGTERM/SIGKILL`
            )
          ),
        KILL_GRACE_MS + HARD_EXIT_MS
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      const next = appendCapped(stdout, chunk);
      stdout = next.text;
      if (next.truncated) stdoutTruncated = true;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      const next = appendCapped(stderr, chunk);
      stderr = next.text;
      if (next.truncated) stderrTruncated = true;
    });
    child.on("error", (err) => fail(err));
    child.on("close", (code) => {
      if (timedOut) {
        fail(new Error(`PowerShell timed out after ${timeoutMs} ms and was terminated`));
        return;
      }
      finish({
        exitCode: code,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        stdoutBytes,
        stderrBytes,
        shell,
        invocation,
      });
    });
  });
}

async function runPowerShell(script: string, timeoutMs: number): Promise<RunResult> {
  const shells =
    process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh", "powershell"];

  const useTempFile = script.length > MAX_ENCODED_SCRIPT_CHARS;
  let tempDir: string | undefined;
  try {
    let args: string[];
    let invocation: RunResult["invocation"];
    if (useTempFile) {
      tempDir = mkdtempSync(join(tmpdir(), "mcp-ps-"));
      const scriptPath = join(tempDir, "script.ps1");
      // UTF-8 *with* BOM: without it Windows PowerShell 5.1 reads the file as the
      // ANSI code page and mangles every non-ASCII character.
      writeFileSync(scriptPath, `\uFEFF${script}`, { encoding: "utf8", mode: 0o600 });
      args = [...BASE_ARGS, "-File", scriptPath];
      invocation = "TempFile";
    } else {
      args = [...BASE_ARGS, "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
      invocation = "EncodedCommand";
    }

    let lastError: Error | undefined;
    for (const shell of shells) {
      try {
        return await spawnOnce(shell, args, timeoutMs, invocation);
      } catch (err) {
        lastError = err as Error;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // try next shell
        throw err;
      }
    }
    throw lastError ?? new Error("No PowerShell executable found (tried pwsh and powershell).");
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export function registerPowerShellTools(server: McpServer): void {
  server.registerTool(
    "powershell_run",
    {
      title: "Run PowerShell",
      description:
        "Execute a PowerShell script on this machine (pwsh preferred, Windows PowerShell fallback). " +
        "Read-only commands run directly. Scripts that can change something require confirm:true after " +
        "user approval. Classification is default-deny: a script only counts as read-only when every " +
        "command in it is recognisably read-only (Get-*, Test-*, Format-Table, ...). Unknown commands, " +
        "destructive aliases (del, rm, iex), redirection (>), writing .NET calls and oversized scripts " +
        "all require confirmation. An affirmative -WhatIf on every risky command counts as a dry run; " +
        "-WhatIf:$false does not. Invoke-RestMethod/Invoke-WebRequest need confirmation with a write " +
        "method or -OutFile. stdout and stderr are capped at 60,000 characters each; the result states " +
        "explicitly whether output was truncated.",
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
        const analysis = analyzeScript(script);
        if (analysis.mutating) {
          const guard = guardWrite(
            confirm,
            `run a PowerShell script that ${analysis.because}. Full script:\n${script.slice(0, 1500)}`
          );
          if (guard) return guard;
        }
        const result = await runPowerShell(script, (timeoutSeconds ?? 120) * 1000);
        const truncated = result.stdoutTruncated || result.stderrTruncated;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  shell: result.shell,
                  invocation: result.invocation,
                  classification: analysis.mutating ? "write" : "read",
                  classificationReason: analysis.because,
                  exitCode: result.exitCode,
                  stdout: result.stdout.trim(),
                  stderr: result.stderr.trim(),
                  // Never let the model read a cut-off result as the whole story.
                  stdoutTruncated: result.stdoutTruncated,
                  stderrTruncated: result.stderrTruncated,
                  stdoutBytes: result.stdoutBytes,
                  stderrBytes: result.stderrBytes,
                  outputCapChars: OUTPUT_CAP,
                  ...(truncated
                    ? {
                        truncationNote:
                          `Output was cut at ${OUTPUT_CAP} characters per stream. ` +
                          "The result is INCOMPLETE; narrow the script (filter, Select-Object, " +
                          "Measure-Object) instead of treating this as the full output.",
                      }
                    : {}),
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
