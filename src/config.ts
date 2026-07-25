import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  /** Per-environment safety switch: true blocks every write for this tenant only. */
  readOnly?: boolean;
  /**
   * ISO timestamp of the last time THIS SERVER wrote this entry. Used when merging
   * with the file: without it the in-memory copy always won and a hand-corrected
   * tenantId was silently reverted on the next write.
   */
  updatedAt?: string;
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

/**
 * This file contains plaintext client secrets, so it must not be world-readable.
 * Older versions created it with the default 0644 inside a 0755 directory; the modes
 * below are therefore also applied to files that already exist (see atomicWrite).
 */
const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;

/**
 * A removal tombstone is kept this long. Long enough that no other instance can
 * still be holding the removed entry in memory, short enough that the file does not
 * grow forever.
 */
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

/**
 * Numeric env vars must never produce NaN or 0: setTimeout(NaN) and setTimeout(0)
 * both fire immediately, so a value like "60s" used to abort every Graph request
 * after ~1 ms with an opaque error instead of timing out after a minute.
 */
function positiveNumber(v: string | undefined, fallback: number, label: string): number {
  if (v === undefined || v.trim() === "") return fallback;
  const parsed = Number(v);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.error(
    `[microsoft-admin-mcp] ${label}="${v}" is geen geldig positief getal; ${fallback} wordt gebruikt.`
  );
  return fallback;
}

/** Turn "env:VARNAME" into the value of that environment variable. */
function resolveSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("env:")) return process.env[value.slice(4)];
  return value;
}

export function environmentsFilePath(): string {
  return process.env.ENVIRONMENTS_FILE ?? join(homedir(), ".microsoft-admin-mcp", "environments.json");
}

/** 0700 on the state directory, also for a directory an older version created as 0755. */
function ensureStateDir(file: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  try {
    chmodSync(dir, STATE_DIR_MODE);
  } catch {
    /* Windows has no POSIX modes: never fail on this */
  }
}

/**
 * Write through a temp file plus rename so a crash can never leave a half-written
 * (unparseable) config behind. The temp file is created 0600 and renamed on top of
 * the target, which also tightens the mode of a file an older version created 0644.
 */
function atomicWritePrivate(file: string, data: string): void {
  ensureStateDir(file);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode: STATE_FILE_MODE });
    try {
      chmodSync(tmp, STATE_FILE_MODE);
    } catch {
      /* platform without POSIX modes */
    }
    renameSync(tmp, file);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
}

/** Raw entries as stored on disk (secrets NOT resolved, so "env:X" stays "env:X"). */
let rawFileEnvironments: Environment[] = [];
/**
 * Removal tombstones: lowercase name -> ISO removal time. These are PERSISTED in the
 * same file (as `{ "removedName": ..., "removedAt": ... }` markers), because a
 * process-local set let two instances undo each other: instance 1 removed B, then
 * instance 2 (which still had B in memory) wrote B straight back.
 */
let tombstones = new Map<string, string>();
/**
 * Names this process created or changed since the last read/write of the file. Only
 * for these does the in-memory copy win the merge; for everything else the file wins,
 * so a hand edit is not reverted.
 */
const dirtyNames = new Set<string>();

/** Set when the file on disk is unusable and must not be overwritten. */
let persistBlockedReason: string | undefined;
/** Path of the last preserved (quarantined) corrupt file, for diagnostics. */
let lastCorruptBackup: string | undefined;

interface RemovedMarker {
  removedName: string;
  removedAt: string;
}

interface FileState {
  environments: Environment[];
  tombstones: Map<string, string>;
  /**
   * Entries we do not understand (a hand-typed entry still missing its tenantId, a
   * field from a newer version). They are ignored for logic but written back
   * unchanged: dropping what the user typed is exactly the kind of silent data loss
   * this file is being fixed for.
   */
  unknown: unknown[];
  status: "ok" | "missing" | "corrupt";
  error?: string;
}

function emptyFileState(status: FileState["status"], error?: string): FileState {
  return { environments: [], tombstones: new Map(), unknown: [], status, error };
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function isRemovedMarker(value: unknown): value is RemovedMarker {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.removedName === "string" && rec.removedName.trim() !== "";
}

function isEnvironmentEntry(value: unknown): value is Environment {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.name === "string" &&
    rec.name.trim() !== "" &&
    typeof rec.tenantId === "string" &&
    rec.tenantId.trim() !== ""
  );
}

/**
 * Parse the raw file. Never throws and never writes: the caller decides what to do
 * with a corrupt file. A file that only contains whitespace counts as "missing"
 * because there is nothing in it worth preserving.
 */
function readEnvironmentsFile(file: string): FileState {
  if (!existsSync(file)) return emptyFileState("missing");
  let text: string;
  try {
    // Strip a UTF-8 BOM if present; editors and PowerShell add one and JSON.parse rejects it.
    text = readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (err) {
    return emptyFileState("corrupt", (err as Error).message);
  }
  if (text.trim() === "") return emptyFileState("missing");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return emptyFileState("corrupt", (err as Error).message);
  }
  // A JSON object (or string, or number) where an array belongs is just as much a
  // sign of a broken file as a syntax error, and must not be overwritten either.
  if (!Array.isArray(parsed)) return emptyFileState("corrupt", "de inhoud is geen JSON-array");

  const environments: Environment[] = [];
  const marks = new Map<string, string>();
  const unknown: unknown[] = [];
  for (const item of parsed) {
    if (isEnvironmentEntry(item)) {
      environments.push(item);
    } else if (isRemovedMarker(item)) {
      marks.set(nameKey(item.removedName), typeof item.removedAt === "string" ? item.removedAt : "");
    } else {
      unknown.push(item);
    }
  }
  // A name that is present as a real entry AND as a tombstone can only come from a
  // hand edit (the server never writes both): the entry the user typed back wins.
  for (const env of environments) marks.delete(nameKey(env.name));
  return { environments, tombstones: marks, unknown, status: "ok" };
}

/** Move a corrupt file aside, keeping its exact bytes. Returns the new path. */
function quarantineCorruptFile(file: string): string | undefined {
  const base = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let target = base;
  let counter = 1;
  while (existsSync(target)) target = `${base}-${counter++}`;
  try {
    renameSync(file, target);
    return target;
  } catch {
    return undefined;
  }
}

/**
 * Read the file and, when it turns out to be corrupt, preserve it BEFORE anything
 * writes. Previously the parse error was swallowed, the server reported a single
 * synthesized "default" environment and the next persist renamed a merge of
 * empty-with-empty over the original: every stored tenant gone, without a backup.
 */
function readEnvironmentsFileProtected(file: string): FileState {
  const state = readEnvironmentsFile(file);
  if (state.status !== "corrupt") {
    persistBlockedReason = undefined;
    if (state.unknown.length > 0) {
      console.error(
        `[microsoft-admin-mcp] ${state.unknown.length} regel(s) in ${file} zijn genegeerd omdat name of tenantId ontbreekt; ` +
          `ze blijven ongewijzigd in het bestand staan.`
      );
    }
    return state;
  }
  const saved = quarantineCorruptFile(file);
  if (saved) {
    lastCorruptBackup = saved;
    persistBlockedReason = undefined;
    console.error(
      `[microsoft-admin-mcp] LET OP: ${file} bevat geen geldige JSON (${state.error ?? "onbekende fout"}). ` +
        `Het originele bestand is ONGEWIJZIGD bewaard als ${saved}. Er zijn 0 opgeslagen omgevingen geladen: ` +
        `herstel de JSON in het bewaarde bestand en zet het terug, of voeg de omgevingen opnieuw toe.`
    );
  } else {
    // Could not move it aside (permissions, locked file). Then we refuse to write
    // rather than destroying the only copy of the customer's tenants.
    persistBlockedReason =
      `${file} bevat geen geldige JSON (${state.error ?? "onbekende fout"}) en kon niet veiliggesteld worden. ` +
      `Het bestand wordt NIET overschreven zodat je gegevens niet verloren gaan. Herstel of verplaats het bestand handmatig.`;
    console.error(`[microsoft-admin-mcp] LET OP: ${persistBlockedReason}`);
  }
  return emptyFileState("corrupt", state.error);
}

function loadRawEnvironments(): void {
  const state = readEnvironmentsFileProtected(environmentsFilePath());
  rawFileEnvironments = state.environments;
  tombstones = state.tombstones;
  dirtyNames.clear();
}

/** State of the local environment store, for diagnostics and error messages. */
export function environmentsStoreStatus(): {
  file: string;
  writable: boolean;
  corruptBackup?: string;
  reason?: string;
} {
  return {
    file: environmentsFilePath(),
    writable: persistBlockedReason === undefined,
    corruptBackup: lastCorruptBackup,
    reason: persistBlockedReason,
  };
}

function buildEnvironments(): Environment[] {
  // "env:VARNAME" indirection applies to every credential field, not just the secret:
  // a certificatePath of "env:CUSTOMER_CERT" used to be taken literally and failed
  // with ENOENT on a path that looked nothing like a path.
  const envs = rawFileEnvironments.map((e) => ({
    ...e,
    clientId: resolveSecret(e.clientId),
    clientSecret: resolveSecret(e.clientSecret),
    certificatePath: resolveSecret(e.certificatePath),
  }));
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

/** "" sorts before any ISO timestamp, so a missing updatedAt counts as oldest. */
function stamp(value: string | undefined): string {
  return typeof value === "string" ? value : "";
}

/**
 * Write the environment file without losing other people's work.
 *
 * The file is user-editable and a second server instance may write it too, so the
 * in-memory array is not the truth: it is only this process's INTENT. We therefore
 * re-read the file right before writing and merge by name:
 *  - entries we changed in this process win (they carry a fresh updatedAt);
 *  - entries we did NOT touch are taken from the file, so a hand edit survives;
 *  - a newer updatedAt always wins, whoever wrote it;
 *  - removals are recorded as persisted tombstones, so a deliberate removal is not
 *    resurrected by another instance that still had the entry in memory.
 * The write itself goes through a temp file plus rename.
 */
function persistEnvironments(): string {
  const file = environmentsFilePath();
  const disk = readEnvironmentsFileProtected(file);
  if (persistBlockedReason) throw new Error(persistBlockedReason);

  const byName = new Map<string, Environment>();
  for (const entry of disk.environments) {
    const key = nameKey(entry.name);
    if (!byName.has(key)) byName.set(key, entry);
  }
  for (const mine of rawFileEnvironments) {
    const key = nameKey(mine.name);
    const onDisk = byName.get(key);
    if (!onDisk) {
      byName.set(key, mine);
      continue;
    }
    if (dirtyNames.has(key)) {
      // Our own change, unless the file holds something even newer.
      byName.set(key, stamp(onDisk.updatedAt) > stamp(mine.updatedAt) ? onDisk : mine);
    } else if (stamp(mine.updatedAt) > stamp(onDisk.updatedAt)) {
      byName.set(key, mine);
    }
    // else: keep the file's version — it may be a hand correction.
  }

  const merged = new Map<string, string>([...disk.tombstones, ...tombstones]);
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  for (const [key, removedAt] of [...merged]) {
    const time = Date.parse(removedAt);
    if (Number.isFinite(time) && time < cutoff) {
      merged.delete(key);
      continue;
    }
    const entry = byName.get(key);
    if (!entry) continue;
    // A deliberate re-add, or an entry written after the removal, beats the tombstone.
    if (dirtyNames.has(key) || stamp(entry.updatedAt) > removedAt) {
      merged.delete(key);
      continue;
    }
    byName.delete(key);
  }

  const environments = [...byName.values()];
  const markers: RemovedMarker[] = [...merged].map(([key, removedAt]) => ({
    removedName: key,
    removedAt,
  }));
  // Entries we could not interpret are written back verbatim, minus any that were
  // deliberately removed by name.
  const preserved = disk.unknown.filter((item) => {
    if (!item || typeof item !== "object") return true;
    const name = (item as { name?: unknown }).name;
    return !(typeof name === "string" && merged.has(nameKey(name)));
  });
  atomicWritePrivate(file, JSON.stringify([...environments, ...preserved, ...markers], null, 2));

  // Adopt the merged view so the next build/persist sees external changes too, and
  // forget our "dirty" claims: from here on the file is authoritative again.
  rawFileEnvironments = environments;
  tombstones = merged;
  dirtyNames.clear();
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
  const key = nameKey(entry.name);
  rawFileEnvironments.push({ ...entry, updatedAt: new Date().toISOString() });
  dirtyNames.add(key);
  tombstones.delete(key);
  const file = persistEnvironments();
  config.environments = buildEnvironments();
  return file;
}

/** Remove a persisted environment by name. Returns true when something was removed. */
export function removeEnvironmentEntry(name: string): boolean {
  const key = nameKey(name);
  const before = rawFileEnvironments.length;
  rawFileEnvironments = rawFileEnvironments.filter((e) => nameKey(e.name) !== key);
  if (rawFileEnvironments.length === before) return false;
  tombstones.set(key, new Date().toISOString());
  dirtyNames.delete(key);
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
    timeoutMs: positiveNumber(env.REQUEST_TIMEOUT_MS, 60_000, "REQUEST_TIMEOUT_MS"),
    environments: buildEnvironments(),
  };
}

export const config = loadConfig();
