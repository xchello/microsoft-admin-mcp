import { config } from "./config.js";

/**
 * Write-safety model:
 * 1. READ_ONLY=true blocks every write, regardless of confirm.
 * 2. Write tools take a `confirm` parameter. Without confirm:true they return
 *    a preview describing exactly what would happen, and instruct the client
 *    to ask the human for approval and call again with confirm:true.
 */
export function guardWrite(confirm: boolean | undefined, description: string) {
  if (config.readOnly) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `BLOCKED: this server runs in READ_ONLY mode. The following write action was NOT executed: ${description}. Remove READ_ONLY=true from the server configuration to allow writes.`,
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
