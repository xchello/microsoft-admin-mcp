import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Tenant knowledge base: facts the user tells us about a specific tenant, so the
 * server gets smarter per customer over time. Examples: "HPOMEN30L can never have
 * BitLocker because it runs Windows 11 Home", "this customer has no Intune Plan 2",
 * "always target the pilot group first here".
 *
 * Stored LOCALLY in the user profile (~/.microsoft-admin-mcp/tenant-knowledge.json),
 * outside every git repository, so customer knowledge never reaches GitHub.
 */

export interface TenantNote {
  id: string;
  topic: string;
  note: string;
  tags: string[];
  createdAt: string;
}

interface TenantEntry {
  tenantId: string;
  environmentNames: string[];
  notes: TenantNote[];
  /**
   * Ids removed for THIS tenant, persisted so a removal survives another instance and
   * cannot be undone by its next write. Scoped per tenant on purpose: ids are derived
   * from a millisecond timestamp, so a single global list could let one tenant's
   * removal drop another tenant's note.
   */
  removedNoteIds?: string[];
}

type Store = Record<string, TenantEntry>;

const MAX_NOTE_LENGTH = 4000;
/** Keep the tombstone list bounded; older ids can no longer be resurrected by anyone. */
const MAX_REMOVED_IDS = 500;
/** Tenant knowledge is customer-confidential: owner-only file inside an owner-only dir. */
const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;

export function knowledgeFilePath(): string {
  return (
    process.env.TENANT_KNOWLEDGE_FILE ??
    join(homedir(), ".microsoft-admin-mcp", "tenant-knowledge.json")
  );
}

let cache: Store | undefined;
/**
 * Fingerprint (mtime + size) of the file the cache was built from. The cache used to
 * live forever, so a hand edit or a second instance was never noticed: removed notes
 * kept being reported and were resurrected by the next write.
 */
let cacheFingerprint = "";

function fingerprint(file: string): string {
  try {
    const info = statSync(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "absent";
  }
}

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

/** Temp file plus rename; the 0600 temp file also tightens an older 0644 target. */
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

function sanitizeEntry(value: unknown): TenantEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.tenantId !== "string" || rec.tenantId.trim() === "") return undefined;
  const notes = Array.isArray(rec.notes) ? rec.notes : [];
  const valid: TenantNote[] = [];
  for (const item of notes) {
    if (!item || typeof item !== "object") continue;
    const note = item as Record<string, unknown>;
    if (typeof note.id !== "string" || typeof note.note !== "string") continue;
    valid.push({
      id: note.id,
      topic: typeof note.topic === "string" ? note.topic : "algemeen",
      note: note.note,
      tags: Array.isArray(note.tags) ? note.tags.filter((t): t is string => typeof t === "string") : [],
      createdAt: typeof note.createdAt === "string" ? note.createdAt : new Date().toISOString(),
    });
  }
  return {
    tenantId: rec.tenantId,
    environmentNames: Array.isArray(rec.environmentNames)
      ? rec.environmentNames.filter((n): n is string => typeof n === "string")
      : [],
    notes: valid,
    removedNoteIds: Array.isArray(rec.removedNoteIds)
      ? rec.removedNoteIds.filter((n): n is string => typeof n === "string")
      : undefined,
  };
}

/**
 * Read the file. Returns undefined when it is corrupt, in which case the bytes are
 * preserved as <file>.corrupt-<timestamp> first: overwriting a knowledge file the user
 * cannot get back is worse than starting empty.
 */
function readStore(file: string): Store | undefined {
  if (!existsSync(file)) return {};
  let text: string;
  try {
    // Strip a UTF-8 BOM if present; editors and PowerShell add one.
    text = readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (err) {
    console.error(`[microsoft-admin-mcp] Kan ${file} niet lezen:`, (err as Error).message);
    return undefined;
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
          ? `Het originele bestand is ONGEWIJZIGD bewaard als ${saved}; de tenantkennis start leeg.`
          : `Het bestand kon niet veiliggesteld worden en wordt daarom niet overschreven.`)
    );
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const store: Store = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = sanitizeEntry(value);
    if (entry) store[key] = entry;
  }
  return store;
}

/**
 * Return the store, re-reading the file whenever its mtime or size changed. Callers
 * mutate the returned object and then call persist() immediately, so a re-read can
 * only drop changes that were never meant to be durable.
 */
function load(): Store {
  const file = knowledgeFilePath();
  const current = fingerprint(file);
  if (cache && current === cacheFingerprint) return cache;
  const fresh = readStore(file);
  // A corrupt file was quarantined; continuing with an empty store is safe because
  // the original bytes are still on disk under the .corrupt- name.
  cache = fresh ?? {};
  cacheFingerprint = fingerprint(file);
  return cache;
}

/** Tenants are keyed case-insensitively on their id/domain. */
function key(tenantId: string): string {
  return tenantId.trim().toLowerCase();
}

function tombstonesOf(entry: TenantEntry | undefined): Set<string> {
  return new Set(entry?.removedNoteIds ?? []);
}

/**
 * Write atomically and merge with what is on disk, so a second server instance or a
 * hand edit of the file cannot be silently clobbered. Notes are merged per tenant by
 * note id; our in-memory version wins for ids we know about, notes another writer
 * added survive, and notes removed here (or there) stay removed.
 */
function persist(): string {
  const file = knowledgeFilePath();
  const mine = load();
  const onDisk = readStore(file) ?? {};

  const merged: Store = {};
  for (const [diskKey, diskEntry] of Object.entries(onDisk)) {
    merged[diskKey] = { ...diskEntry, notes: [...diskEntry.notes] };
  }
  for (const [tenantKey, entry] of Object.entries(mine)) {
    const existing = merged[tenantKey];
    const removed = new Set<string>([
      ...tombstonesOf(existing),
      ...tombstonesOf(entry),
      ...(processRemovals.get(tenantKey) ?? []),
    ]);
    if (!existing) {
      merged[tenantKey] = {
        tenantId: entry.tenantId,
        environmentNames: [...entry.environmentNames],
        notes: entry.notes.filter((n) => !removed.has(n.id)),
        ...(removed.size > 0 ? { removedNoteIds: [...removed].slice(-MAX_REMOVED_IDS) } : {}),
      };
      continue;
    }
    const ids = new Set(entry.notes.map((n) => n.id));
    // Keep notes another writer added, drop nothing we deliberately removed here.
    const foreign = existing.notes.filter((n) => !ids.has(n.id) && !removed.has(n.id));
    merged[tenantKey] = {
      tenantId: entry.tenantId,
      environmentNames: [...new Set([...existing.environmentNames, ...entry.environmentNames])],
      notes: [...foreign, ...entry.notes.filter((n) => !removed.has(n.id))],
      ...(removed.size > 0 ? { removedNoteIds: [...removed].slice(-MAX_REMOVED_IDS) } : {}),
    };
  }

  atomicWritePrivate(file, JSON.stringify(merged, null, 2));
  cache = merged;
  cacheFingerprint = fingerprint(file);
  return file;
}

/**
 * Removals made in this process, per tenant key, until they are on disk. Kept next to
 * the persisted tombstones so a removal is never lost between the splice and the write.
 */
const processRemovals = new Map<string, Set<string>>();

function entry(tenantId: string, environmentName?: string): TenantEntry {
  const store = load();
  const k = key(tenantId);
  if (!store[k]) {
    store[k] = { tenantId, environmentNames: [], notes: [] };
  }
  if (environmentName && !store[k].environmentNames.includes(environmentName)) {
    store[k].environmentNames.push(environmentName);
  }
  return store[k];
}

/**
 * Ids stay short and readable but must be unique for the lifetime of the file: the old
 * timestamp+count scheme could repeat an id after a removal, and a repeated id would
 * now be swallowed by that tenant's removal tombstone.
 */
function newNoteId(count: number): string {
  return `n${Date.now().toString(36)}${count.toString(36)}${randomBytes(3).toString("hex")}`;
}

export function addNote(args: {
  tenantId: string;
  environmentName?: string;
  topic: string;
  note: string;
  tags?: string[];
}): { note: TenantNote; storedIn: string; totalForTenant: number } {
  const text = args.note.trim();
  if (!text) throw new Error("note may not be empty.");
  if (text.length > MAX_NOTE_LENGTH) {
    throw new Error(`note is too long (${text.length} chars, max ${MAX_NOTE_LENGTH}).`);
  }
  const target = entry(args.tenantId, args.environmentName);
  const topic = (args.topic || "algemeen").trim();

  const duplicate = target.notes.find(
    (n) => n.topic.toLowerCase() === topic.toLowerCase() && n.note.trim() === text
  );
  if (duplicate) {
    // Still persist: entry() may have linked a new environment name to this tenant,
    // and with an mtime-invalidated cache that link would otherwise be lost.
    const storedIn = persist();
    return { note: duplicate, storedIn, totalForTenant: target.notes.length };
  }

  const note: TenantNote = {
    id: newNoteId(target.notes.length + 1),
    topic,
    note: text,
    tags: (args.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
    createdAt: new Date().toISOString(),
  };
  target.notes.push(note);
  const storedIn = persist();
  return { note, storedIn, totalForTenant: target.notes.length };
}

export function listNotes(tenantId: string, query?: string): TenantNote[] {
  const store = load();
  const target = store[key(tenantId)];
  if (!target) return [];
  // A copy: the returned array must not be a live handle on the cache, otherwise a
  // caller sorting or splicing the result would silently change the stored state.
  if (!query || !query.trim()) return [...target.notes];
  const q = query.trim().toLowerCase();
  return target.notes.filter(
    (n) =>
      n.topic.toLowerCase().includes(q) ||
      n.note.toLowerCase().includes(q) ||
      n.tags.some((t) => t.includes(q))
  );
}

export function removeNote(tenantId: string, id: string): TenantNote | undefined {
  const store = load();
  const k = key(tenantId);
  const target = store[k];
  if (!target) return undefined;
  const index = target.notes.findIndex((n) => n.id === id);
  if (index === -1) return undefined;
  const [removed] = target.notes.splice(index, 1);
  const own = processRemovals.get(k) ?? new Set<string>();
  own.add(removed.id);
  processRemovals.set(k, own);
  target.removedNoteIds = [...new Set([...(target.removedNoteIds ?? []), removed.id])].slice(
    -MAX_REMOVED_IDS
  );
  persist();
  return removed;
}

export function noteCount(tenantId: string): number {
  // Own-property lookup plus optional chaining all the way down: a tenantId of
  // "__proto__" or "constructor" otherwise hits the prototype chain and throws inside
  // the context-header code, which sits outside every tool's error handling.
  const store = load();
  const k = key(tenantId);
  if (!Object.prototype.hasOwnProperty.call(store, k)) return 0;
  return store[k]?.notes?.length ?? 0;
}

/** Overview across all tenants, for diagnostics. */
export function knowledgeSummary(): Array<{ tenantId: string; environmentNames: string[]; notes: number }> {
  return Object.values(load()).map((e) => ({
    tenantId: e.tenantId,
    environmentNames: e.environmentNames,
    notes: e.notes.length,
  }));
}
