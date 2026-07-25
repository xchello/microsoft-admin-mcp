import { config } from "./config.js";
import { getActiveEnvironment } from "./auth.js";

/**
 * Write-safety model:
 * 1. READ_ONLY=true (globally) or "readOnly": true on the active environment blocks
 *    every write, regardless of confirm. Per-environment is useful for customer
 *    tenants where you only want to report.
 * 2. Write tools take a `confirm` parameter. Without confirm:true they return
 *    a preview describing exactly what would happen, and instruct the client
 *    to ask the human for approval and call again with confirm:true.
 */

/** Is writing blocked, and why? */
export function readOnlyReason(): string | undefined {
  if (config.readOnly) return "READ_ONLY=true is set for the whole server";
  try {
    const env = getActiveEnvironment();
    if (env.readOnly) return `environment "${env.name}" is marked read-only in environments.json`;
  } catch {
    /* no environment configured; nothing extra to block */
  }
  return undefined;
}

export function guardWrite(confirm: boolean | undefined, description: string) {
  const blocked = readOnlyReason();
  if (blocked) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `BLOCKED: writing is disabled (${blocked}). The following write action was NOT executed: ${description}. Remove the read-only setting to allow writes.`,
        },
      ],
    };
  }
  if (!confirm) {
    return {
      content: [
        {
          type: "text" as const,
          text: `CONFIRMATION REQUIRED. Nothing was changed yet.\n\nPlanned action: ${description}\n\nAsk the user to explicitly approve this action. Only after approval, call this tool again with confirm: true.`,
        },
      ],
    };
  }
  return undefined; // proceed
}
