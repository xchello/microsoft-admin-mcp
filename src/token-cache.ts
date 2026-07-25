import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthenticationRecord } from "@azure/identity";

/**
 * Persistent sign-in across restarts.
 *
 * Two pieces are needed to avoid a browser prompt after every restart of the host
 * application:
 *  1. A persistent MSAL token cache on disk (encrypted by the OS: DPAPI on Windows,
 *     Keychain on macOS, libsecret on Linux). This requires the optional package
 *     @azure/identity-cache-persistence. When it is unavailable we degrade
 *     gracefully to an in-memory cache instead of failing.
 *  2. The AuthenticationRecord of the account that signed in, so the credential
 *     knows which cached account to reuse. The record contains identifiers only,
 *     no tokens and no secrets, so it is safe to store as plain JSON.
 */

const CACHE_NAME = "microsoft-admin-mcp";

/**
 * The record file holds admin UPNs, tenant ids and homeAccountIds: identifiers, but
 * customer data all the same. Owner-only, like the MSAL cache next to it.
 */
const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;

export function authRecordFilePath(): string {
  return (
    process.env.AUTH_RECORD_FILE ?? join(homedir(), ".microsoft-admin-mcp", "auth-records.json")
  );
}

let persistenceAvailable: boolean | undefined;

/** Is the optional persistence package installed on this machine? */
export function hasPersistence(): boolean {
  if (persistenceAvailable !== undefined) return persistenceAvailable;
  try {
    const require = createRequire(import.meta.url);
    require.resolve("@azure/identity-cache-persistence");
    persistenceAvailable = true;
  } catch {
    persistenceAvailable = false;
  }
  return persistenceAvailable;
}

export function persistenceStatus(): string {
  if (process.env.DISABLE_TOKEN_PERSISTENCE) return "uitgeschakeld via DISABLE_TOKEN_PERSISTENCE";
  return hasPersistence()
    ? `actief (versleutelde cache van het besturingssysteem, records in ${authRecordFilePath()})`
    : "niet beschikbaar: optionele package @azure/identity-cache-persistence ontbreekt, je logt na een herstart opnieuw in";
}

/** Credential options that enable the persistent cache when possible. */
export function persistenceOptions(): Record<string, unknown> {
  if (process.env.DISABLE_TOKEN_PERSISTENCE || !hasPersistence()) return {};
  return {
    tokenCachePersistenceOptions: {
      enabled: true,
      name: CACHE_NAME,
      // Never fall back to an unencrypted file: better to prompt than to store tokens in plain text.
      unsafeAllowUnencryptedStorage: false,
    },
  };
}

type RecordStore = Record<string, AuthenticationRecord>;

/** 0700 on the state directory, also when an older version created it as 0755. */
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
 * Temp file plus rename, so a crash or a full disk cannot leave a truncated record
 * file behind (which is exactly what made every tenant sign in again). The 0600 temp
 * file also tightens the mode of a file an older version created as 0644.
 */
function atomicWritePrivate(file: string, data: string): void {
  ensureStateDir(file);
  const temp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, data, { encoding: "utf8", mode: STATE_FILE_MODE });
    try {
      chmodSync(temp, STATE_FILE_MODE);
    } catch {
      /* platform without POSIX modes */
    }
    renameSync(temp, file);
  } catch (err) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
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
 * Read the record file. A parse error used to be swallowed and turned into {}, after
 * which the next login wrote a single record over the file: every other tenant lost
 * its sign-in silently. Now the broken file is preserved and the user is told.
 */
function loadStore(): RecordStore {
  const file = authRecordFilePath();
  if (!existsSync(file)) return {};
  let text: string;
  try {
    text = readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (err) {
    console.error(`[microsoft-admin-mcp] Kan ${file} niet lezen:`, (err as Error).message);
    return {};
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const saved = quarantineCorruptFile(file);
    console.error(
      `[microsoft-admin-mcp] LET OP: ${file} bevat geen geldige JSON (${(err as Error).message}). ` +
        (saved
          ? `Het originele bestand is ONGEWIJZIGD bewaard als ${saved}. Je logt voor de betrokken omgevingen opnieuw in.`
          : `Het bestand kon niet veiliggesteld worden; er wordt niets overschreven.`)
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const store: RecordStore = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value && typeof value === "object") store[name] = value as AuthenticationRecord;
  }
  return store;
}

export function loadAuthRecord(environmentName: string): AuthenticationRecord | undefined {
  return loadStore()[environmentName];
}

/** Attempts of the read-merge-write cycle before we give up and warn. */
const WRITE_ATTEMPTS = 4;

export function saveAuthRecord(environmentName: string, record: AuthenticationRecord): void {
  try {
    const file = authRecordFilePath();
    ensureStateDir(file);
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      // Re-read immediately before writing: another instance may have added a record
      // since this process last looked, and it must not be dropped.
      const store = loadStore();
      store[environmentName] = record;
      atomicWritePrivate(file, JSON.stringify(store, null, 2));
      // Read back: two instances signing in at the same moment can each write a merge
      // of what THEY saw, so the loser has to merge again instead of losing a sign-in.
      const after = loadStore();
      if (Object.keys(store).every((name) => name in after)) return;
    }
    console.error(
      `[microsoft-admin-mcp] LET OP: ${authRecordFilePath()} wordt door meerdere processen tegelijk geschreven; ` +
        `mogelijk moet één omgeving opnieuw inloggen.`
    );
  } catch (err) {
    console.error("[microsoft-admin-mcp] Could not store authentication record:", (err as Error).message);
  }
}

export function forgetAuthRecord(environmentName: string): void {
  try {
    const file = authRecordFilePath();
    if (!existsSync(file)) return;
    const store = loadStore();
    if (!(environmentName in store)) return;
    delete store[environmentName];
    atomicWritePrivate(file, JSON.stringify(store, null, 2));
  } catch {
    /* best effort */
  }
}
