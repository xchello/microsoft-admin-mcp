import { GRAPH_SCOPE, tokenClaims } from "./auth.js";

/**
 * Scope preflight: check the current Graph token actually carries the permission
 * an operation needs, so the user gets a clear message instead of an opaque 403
 * from Microsoft Graph halfway through a change.
 *
 * Delegated tokens carry permissions in "scp", app-only tokens in "roles".
 */

export function grantedScopes(): string[] | undefined {
  const claims = tokenClaims(GRAPH_SCOPE);
  if (!claims) return undefined; // no token acquired yet: cannot judge
  const scp = typeof claims.scopes === "string" ? claims.scopes.split(/\s+/) : [];
  const roles = Array.isArray(claims.roles) ? (claims.roles as string[]) : [];
  return [...scp, ...roles].filter(Boolean);
}

/** True when at least one of the required permissions is present. Undefined when unknown. */
export function hasAnyScope(required: string[]): boolean | undefined {
  const granted = grantedScopes();
  if (!granted) return undefined;
  const lower = granted.map((g) => g.toLowerCase());
  return required.some((r) => lower.includes(r.toLowerCase()));
}

/**
 * Returns an error message when the permission is definitely missing, otherwise undefined.
 * Unknown (no token yet) never blocks: the call itself will trigger authentication.
 */
export function missingScopeMessage(required: string[], what: string): string | undefined {
  const ok = hasAnyScope(required);
  if (ok === false) {
    return (
      `Permission missing for ${what}. Required (at least one): ${required.join(", ")}. ` +
      `The current sign-in does not have it, so nothing was executed. ` +
      `Grant the permission (delegated scope or app role) and sign in again with environment_login.`
    );
  }
  return undefined;
}

/** Human-readable capability overview for auth_status. */
export function capabilityOverview(): Record<string, boolean | string> {
  const granted = grantedScopes();
  if (!granted) return { note: "no Graph token acquired yet, capabilities unknown" };
  const has = (...s: string[]) => hasAnyScope(s) === true;
  return {
    readDevices: has("DeviceManagementManagedDevices.Read.All", "DeviceManagementManagedDevices.ReadWrite.All"),
    writeDevices: has("DeviceManagementManagedDevices.ReadWrite.All"),
    wipeOrRetireDevices: has("DeviceManagementManagedDevices.PrivilegedOperations.All"),
    readApps: has("DeviceManagementApps.Read.All", "DeviceManagementApps.ReadWrite.All"),
    writeApps: has("DeviceManagementApps.ReadWrite.All"),
    readConfiguration: has("DeviceManagementConfiguration.Read.All", "DeviceManagementConfiguration.ReadWrite.All"),
    writeConfiguration: has("DeviceManagementConfiguration.ReadWrite.All"),
    readDirectory: has("Directory.Read.All", "Directory.ReadWrite.All", "User.Read.All"),
    writeDirectory: has("Directory.ReadWrite.All", "User.ReadWrite.All"),
    readAuditLogs: has("AuditLog.Read.All"),
  };
}

/** Permissions needed per Intune device action. */
export const DEVICE_ACTION_SCOPES: Record<string, string[]> = {
  wipe: ["DeviceManagementManagedDevices.PrivilegedOperations.All"],
  retire: ["DeviceManagementManagedDevices.PrivilegedOperations.All"],
  cleanWindowsDevice: ["DeviceManagementManagedDevices.PrivilegedOperations.All"],
  resetPasscode: ["DeviceManagementManagedDevices.PrivilegedOperations.All"],
  remoteLock: ["DeviceManagementManagedDevices.PrivilegedOperations.All"],
};
const DEFAULT_DEVICE_ACTION_SCOPES = ["DeviceManagementManagedDevices.ReadWrite.All"];

export function scopesForDeviceAction(action: string): string[] {
  return DEVICE_ACTION_SCOPES[action] ?? DEFAULT_DEVICE_ACTION_SCOPES;
}
