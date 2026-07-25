import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
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
}

type Store = Record<string, TenantEntry>;

const MAX_NOTE_LENGTH = 4000;

export function knowledgeFilePath(): string {
  return (
    process.env.TENANT_KNOWLEDGE_FILE ??
    join(homedir(), ".microsoft-admin-mcp", "tenant-knowledge.json")
  );
}

let cache: Store | undefined;

function load(): Store {
  if (cache) return cache;
  const file = knowledgeFilePath();
  cache = {};
  if (existsSync(file)) {
    try {
      // Strip a UTF-8 BOM if present; editors and PowerShell add one.
      const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Store;
      if (parsed && typeof parsed === "object") cache = parsed;
    } catch (err) {
      console.error(`[microsoft-admin-mcp] Could not parse ${file}:`, (err as Error).message);
    }
  }
  return cache;
}

function persist(): string {
  const file = knowledgeFilePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(load(), null, 2), "utf8");
  return file;
}

/** Tenants are keyed case-insensitively on their id/domain. */
function key(tenantId: string): string {
  return tenantId.trim().toLowerCase();
}

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
    return { note: duplicate, storedIn: knowledgeFilePath(), totalForTenant: target.notes.length };
  }

  const note: TenantNote = {
    id: `n${Date.now().toString(36)}${(target.notes.length + 1).toString(36)}`,
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
  if (!query || !query.trim()) return target.notes;
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
  const target = store[key(tenantId)];
  if (!target) return undefined;
  const index = target.notes.findIndex((n) => n.id === id);
  if (index === -1) return undefined;
  const [removed] = target.notes.splice(index, 1);
  persist();
  return removed;
}

export function noteCount(tenantId: string): number {
  return load()[key(tenantId)]?.notes.length ?? 0;
}

/** Overview across all tenants, for diagnostics. */
export function knowledgeSummary(): Array<{ tenantId: string; environmentNames: string[]; notes: number }> {
  return Object.values(load()).map((e) => ({
    tenantId: e.tenantId,
    environmentNames: e.environmentNames,
    notes: e.notes.length,
  }));
}
