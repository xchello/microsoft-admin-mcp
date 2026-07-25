import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * An environment is one customer/tenant. Multiple environments make it possible
 * to switch between customers quickly ("do this for customer X, then Y").
 *
 * Sources, in order:
 * 1. ENVIRONMENTS_FILE (JSON array), default ~/.microsoft-admin-mcp/environments.json
 * 2. A "default" environment built from plain env vars (TENANT_ID, CLIENT_ID, ...)
 *
 * Secret values in the JSON file may reference environment variables with the
 * prefix "env:", e.g. "clientSecret": "env:CUSTOMER_X_SECRET".
 */
export interface Environment {
  name: string;
  tenantId: string;
  clientId?: string;
  clientSecret?: string;
  certificatePath?: string;
  authMode?: "auto" | "cli" | "interactive" | "devicecode" | "app";
  description?: string;
}

export interface Config {
  readOnly: boolean;
  defaultGraphVersion: "v1.0" | "beta";
  powershellEnabled: boolean;
  timeoutMs: number;
  environments: Environment[];
}

/** Well-known public client id of "Microsoft Graph Command Line Tools".
 *  Sensible default for delegated (interactive/devicecode) auth so the server
 *  works before any app registration exists. */
export const GRAPH_CLI_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function resolveSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("env:")) return process.env[value.slice(4)];
  return value;
}

function loadEnvironments(): Environment[] {
  const envs: Environment[] = [];
  const file =
    process.env.ENVIRONMENTS_FILE ?? join(homedir(), ".microsoft-admin-mcp", "environments.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Environment[];
      for (const e of parsed) {
        if (!e.name || !e.tenantId) continue;
        envs.push({
          ...e,
          clientSecret: resolveSecret(e.clientSecret),
        });
      }
    } catch (err) {
      console.error(`[microsoft-admin-mcp] Could not parse ${file}:`, (err as Error).message);
    }
  }
  // Default environment from plain env vars, if not shadowed by the file.
  if (!envs.some((e) => e.name === "default") && (process.env.TENANT_ID || envs.length === 0)) {
    envs.unshift({
      name: "default",
      tenantId: process.env.TENANT_ID ?? "common",
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      certificatePath: process.env.CERTIFICATE_PATH,
      authMode: (process.env.AUTH_MODE as Environment["authMode"]) ?? "auto",
      description: "Built from TENANT_ID/CLIENT_ID environment variables",
    });
  }
  return envs;
}

export function loadConfig(): Config {
  const env = process.env;
  return {
    readOnly: bool(env.READ_ONLY, false),
    defaultGraphVersion: env.GRAPH_VERSION === "beta" ? "beta" : "v1.0",
    powershellEnabled: bool(env.POWERSHELL_ENABLED, true),
    timeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 60_000),
    environments: loadEnvironments(),
  };
}

export const config = loadConfig();
