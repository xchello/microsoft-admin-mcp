import {
  AzureCliCredential,
  ChainedTokenCredential,
  ClientCertificateCredential,
  ClientSecretCredential,
  DeviceCodeCredential,
  InteractiveBrowserCredential,
  type TokenCredential,
} from "@azure/identity";
import { config, GRAPH_CLI_CLIENT_ID, type Environment } from "./config.js";

export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
export const ARM_SCOPE = "https://management.azure.com/.default";

/** IMPORTANT for stdio MCP servers: stdout is reserved for the protocol.
 *  All human-facing messages (device codes, logs) must go to stderr. */
export function log(...args: unknown[]): void {
  console.error("[microsoft-admin-mcp]", ...args);
}

// ---------- Environment (multi-tenant) state ----------

let activeEnvName = config.environments[0]?.name ?? "default";

export function listEnvironments(): Array<Record<string, unknown>> {
  return config.environments.map((e) => ({
    name: e.name,
    tenantId: e.tenantId,
    authMode: e.authMode ?? "auto",
    description: e.description,
    active: e.name === activeEnvName,
    hasAppCredentials: Boolean(e.clientSecret || e.certificatePath),
  }));
}

export function getActiveEnvironment(): Environment {
  const env = config.environments.find((e) => e.name === activeEnvName);
  if (!env) throw new Error(`No environment named "${activeEnvName}" is configured.`);
  return env;
}

export function setActiveEnvironment(name: string): Environment {
  const env = config.environments.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!env) {
    throw new Error(
      `Unknown environment "${name}". Configured: ${config.environments.map((e) => e.name).join(", ")}`
    );
  }
  activeEnvName = env.name;
  return env;
}

// ---------- Credentials and tokens, per environment ----------

const credentials = new Map<string, { credential: TokenCredential; mode: string }>();

function buildCredential(env: Environment): { credential: TokenCredential; mode: string } {
  const tenantId = env.tenantId;
  const clientId = env.clientId ?? GRAPH_CLI_CLIENT_ID;

  const makeDeviceCode = () =>
    new DeviceCodeCredential({
      tenantId,
      clientId,
      userPromptCallback: (info) => log(`[${env.name}] SIGN IN REQUIRED:`, info.message),
    });

  const makeInteractive = () =>
    new InteractiveBrowserCredential({ tenantId, clientId, redirectUri: "http://localhost:8400" });

  const makeApp = (): TokenCredential => {
    if (env.certificatePath) return new ClientCertificateCredential(tenantId, clientId, env.certificatePath);
    if (env.clientSecret) return new ClientSecretCredential(tenantId, clientId, env.clientSecret);
    throw new Error(
      `Environment "${env.name}": authMode "app" requires clientSecret or certificatePath.`
    );
  };

  switch (env.authMode ?? "auto") {
    case "cli":
      return {
        credential: new AzureCliCredential({ tenantId: tenantId === "common" ? undefined : tenantId }),
        mode: "cli",
      };
    case "interactive":
      return { credential: makeInteractive(), mode: "interactive" };
    case "devicecode":
      return { credential: makeDeviceCode(), mode: "devicecode" };
    case "app":
      return { credential: makeApp(), mode: "app (client credentials)" };
    case "auto":
    default:
      if (env.clientSecret || env.certificatePath) {
        return { credential: makeApp(), mode: "app (client credentials, auto)" };
      }
      return {
        credential: new ChainedTokenCredential(
          new AzureCliCredential({ tenantId: tenantId === "common" ? undefined : tenantId }),
          makeDeviceCode()
        ),
        mode: "auto (az cli, then device code)",
      };
  }
}

interface CachedToken {
  token: string;
  expiresOnTimestamp: number;
}
const tokenCache = new Map<string, CachedToken>();

export async function getToken(scope: string): Promise<string> {
  const env = getActiveEnvironment();
  const cacheKey = `${env.name}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  // Refresh when less than 3 minutes of validity remain.
  if (cached && cached.expiresOnTimestamp - Date.now() > 3 * 60_000) return cached.token;

  let entry = credentials.get(env.name);
  if (!entry) {
    entry = buildCredential(env);
    credentials.set(env.name, entry);
  }
  const result = await entry.credential.getToken(scope);
  if (!result) throw new Error(`Failed to acquire token for scope ${scope} (environment ${env.name})`);
  tokenCache.set(cacheKey, { token: result.token, expiresOnTimestamp: result.expiresOnTimestamp });
  return result.token;
}

export function authStatus(): Record<string, unknown> {
  const env = getActiveEnvironment();
  const scopes: Record<string, string> = {};
  for (const [key, t] of tokenCache) {
    if (key.startsWith(`${env.name}|`)) {
      scopes[key.split("|")[1]] = `valid until ${new Date(t.expiresOnTimestamp).toISOString()}`;
    }
  }
  return {
    activeEnvironment: env.name,
    tenantId: env.tenantId,
    configuredAuthMode: env.authMode ?? "auto",
    resolvedAuthMode: credentials.get(env.name)?.mode ?? "not yet authenticated",
    clientId: env.clientId ?? `${GRAPH_CLI_CLIENT_ID} (Microsoft Graph Command Line Tools, default)`,
    readOnly: config.readOnly,
    cachedTokens: scopes,
    allEnvironments: listEnvironments(),
  };
}

/** Decode the (unvalidated) token payload for diagnostics: upn/appid/roles. */
export function tokenClaims(scope: string): Record<string, unknown> | undefined {
  const env = getActiveEnvironment();
  const cached = tokenCache.get(`${env.name}|${scope}`);
  if (!cached) return undefined;
  try {
    const payload = cached.token.split(".")[1];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return {
      upn: claims.upn ?? claims.preferred_username,
      appDisplayName: claims.app_displayname,
      appId: claims.appid,
      tenant: claims.tid,
      scopes: claims.scp,
      roles: claims.roles,
      expires: claims.exp ? new Date(claims.exp * 1000).toISOString() : undefined,
    };
  } catch {
    return undefined;
  }
}
