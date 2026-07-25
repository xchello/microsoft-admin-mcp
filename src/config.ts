import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * An environment is one customer/tenant. Multiple environments make it possible
 * to switch between customers quickly ("do this for customer X, then Y").
 *
 * Sources, in order:
 * 1. ENVIRONMENTS_FILE (JSON array), default ~/.microsoft-admin-mcp/environments.json
 *    This file lives in the USER PROFILE, outside any git repository, so tenant
 *    details and secrets never end up on GitHub.
 * 2. A "default" environment built from plain env vars (TENANT_ID, CLIENT_ID, ...)
 *
 * Secret values in the JSON file may reference environment variables with the
 * prefix "env:", e.g. "clientSecret": "env:CUSTOMER_X_SECRET".
 *
 * Environments can also be added/removed at runtime via the environment_add and
 * environment_remove tools; changes are persisted to the same local file.
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

export function environmentsFilePath(): string {
  return process.env.ENVIRONMENTS_FILE ?? join(homedir(), ".microsoft-admin-mcp", "environments.json");
}

/** Raw entries as stored on disk (secrets NOT resolved, so "env:X" stays "env:X"). */
let rawFileEnvironments: Environment[] = [];

function loadRawEnvironments(): void {
  const file = environmentsFilePath();
  rawFileEnvironments = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Environment[];
      rawFileEnvironments = parsed.filter((e) => e.name && e.tenantId);
    } catch (err) {
      console.error(`[microsoft-admin-mcp] Could not parse ${file}:`, (err as Error).message);
    }
  }
}

function buildEnvironments(): Environment[] {
  const envs = rawFileEnvironments.map((e) => ({ ...e, clientSecret: resolveSecret(e.clientSecret) }));
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

function persistEnvironments(): string {
  const file = environmentsFilePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(rawFileEnvironments, null, 2), "utf8");
  return file;
}

/** Add an environment at runtime and persist it locally. Returns the file path. */
export function addEnvironmentEntry(entry: Environment): string {
  if (!entry.name || !entry.tenantId) throw new Error("name and tenantId are required.");
  if (entry.name.toLowerCase() === "default") {
    throw new Error('The name "default" is reserved for the env-var based environment.');
  }
  if (config.environments.some((e) => e.name.toLowerCase() === entry.name.toLowerCase())) {
    throw new Error(`An environment named "${entry.name}" already exists. Remove it first or pick another name.`);
  }
  rawFileEnvironments.push(entry);
  const file = persistEnvironments();
  config.environments = buildEnvironments();
  return file;
}

/** Remove a persisted environment by name. Returns true when something was removed. */
export function removeEnvironmentEntry(name: string): boolean {
  const before = rawFileEnvironments.length;
  rawFileEnvironments = rawFileEnvironments.filter((e) => e.name.toLowerCase() !== name.toLowerCase());
  if (rawFileEnvironments.length === before) return false;
  persistEnvironments();
  config.environments = buildEnvironments();
  return true;
}

export function loadConfig(): Config {
  const env = process.env;
  loadRawEnvironments();
  return {
    readOnly: bool(env.READ_ONLY, false),
    defaultGraphVersion: env.GRAPH_VERSION === "beta" ? "beta" : "v1.0",
    powershellEnabled: bool(env.POWERSHELL_ENABLED, true),
    timeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 60_000),
    environments: buildEnvironments(),
  };
}

export const config = loadConfig();
