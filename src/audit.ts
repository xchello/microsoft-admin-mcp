import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Append-only audit log of every write action, stored locally as JSON Lines in
 * ~/.microsoft-admin-mcp/audit-log.jsonl (outside any git repository).
 *
 * Purpose: when you administer customer tenants, you need a record of what was
 * changed, where, when and with what outcome. Secrets are redacted and long
 * values truncated before anything is written.
 */

export interface AuditEntry {
  ts: string;
  environment: string;
  tenantId: string;
  tool: string;
  outcome: "ok" | "error" | "awaiting_confirmation" | "blocked_read_only";
  args: unknown;
  detail?: string;
  durationMs?: number;
}

/**
 * Key names that must never have their value written to disk. This is matched
 * UNANCHORED against the key with separators stripped ("api_key" -> "apikey",
 * "Connection-String" -> "connectionstring"), because the previous anchored
 * version ("...$") only caught keys ENDING in a secret word and therefore wrote
 * secretText, clientSecretValue and Authorization to the log in cleartext.
 */
const SECRET_KEY_SUBSTRING =
  /(secret|password|passwd|pwd|passphrase|token|credential|apikey|accesskey|accountkey|accesspass|bearer|authorization|connectionstring|privatekey|accesssignature|sas(token|uri|url|key|signature))/;
/**
 * Whole-key matches kept deliberately narrow: unanchored "pat" would hit "path"
 * and unanchored "sas"/"key" would hit ordinary words, so those only match at
 * the end of the key (encryptionKey, personalAccessPat) or as the entire key.
 * "keys" is included because an Azure listKeys response is { keys: [{ keyName, value }] }:
 * without it the storage account key landed in the log under a harmless-looking "value".
 */
const SECRET_KEY_SUFFIX = /(keys?|pats?|sas|sig|otp|pin|seed)$/;

/**
 * Keys that identify WHAT was touched rather than expose a credential. They stay
 * visible even inside a secret container, because an audit trail that says a
 * passwordCredential was created but not WHICH one is useless during an incident.
 * A certificate thumbprint belongs here too: it is a public identifier, and masking it
 * only made it impossible to tell which certificate was used.
 */
const IDENTIFYING_KEYS = new Set([
  "displayname",
  "name",
  "id",
  "keyid",
  "keyname",
  "customkeyidentifier",
  "thumbprint",
  "certificatepath",
  "path",
  "hint",
  "type",
  "kind",
  "usage",
  "isprimary",
  "permissions",
  "resourcegroup",
  "accountname",
  "createddatetime",
  "startdatetime",
  "enddatetime",
  "expirationdatetime",
  "expireson",
]);

const MAX_STRING = 600;
/** The log records customer admin actions: owner-only file inside an owner-only dir. */
const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
/** Read at most this many bytes from the tail of the log: a months-old log must stay fast. */
const TAIL_BYTES = 512 * 1024;
/** Rotate once the live log passes this size, keeping exactly one previous generation. */
const ROTATE_BYTES = 5 * 1024 * 1024;

export function auditFilePath(): string {
  return process.env.AUDIT_LOG_FILE ?? join(homedir(), ".microsoft-admin-mcp", "audit-log.jsonl");
}

/** Path of the single previous generation, e.g. audit-log.jsonl -> audit-log.1.jsonl. */
function rotatedFilePath(file: string): string {
  return file.endsWith(".jsonl") ? `${file.slice(0, -".jsonl".length)}.1.jsonl` : `${file}.1`;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SECRET_KEY_SUBSTRING.test(normalized) || SECRET_KEY_SUFFIX.test(normalized);
}

/** Identifying keys survive inside a secret container (see IDENTIFYING_KEYS). */
function isIdentifyingKey(key: string): boolean {
  return IDENTIFYING_KEYS.has(normalizeKey(key));
}

/** Shannon entropy in bits per character; random base64 lands well above English text. */
function entropyPerChar(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Conservative test for "this long run of characters is a credential, not prose".
 * Deliberately strict, because masking ordinary text (a resource path, a display name,
 * a certificate thumbprint) destroys exactly the auditability this log exists for:
 *  - mixed case plus a digit, so CamelCase identifiers and lowercase slugs are out;
 *  - not hex/GUID-shaped, so thumbprints and object ids stay readable;
 *  - a slash is only accepted with base64 padding, so URL and resource paths stay;
 *  - no long single-case run: real words give runs of 8+ letters
 *    ("WindowsUpdateForBusinessRingPilotGroup2026" has 12), random base64 gives 1-4.
 *    This is the rule that separates a key from a long PascalCase policy name, which
 *    entropy alone does not (4.48 versus 5.76 bits, too close to threshold safely);
 *  - and the character distribution has to look random.
 */
const MAX_SINGLE_CASE_RUN = 6;

function longestRun(candidate: string, pattern: RegExp): number {
  return (candidate.match(pattern) ?? [""]).reduce((max, run) => Math.max(max, run.length), 0);
}

function looksLikeHighEntropySecret(candidate: string): boolean {
  if (candidate.length < 40) return false;
  if (/^[0-9a-f-]+$/i.test(candidate)) return false; // hex digest, GUID
  if (!/[a-z]/.test(candidate) || !/[A-Z]/.test(candidate) || !/[0-9]/.test(candidate)) return false;
  if (candidate.includes("/") && !candidate.endsWith("=")) return false;
  if (longestRun(candidate, /[a-z]+/g) > MAX_SINGLE_CASE_RUN) return false;
  if (longestRun(candidate, /[A-Z]+/g) > MAX_SINGLE_CASE_RUN) return false;
  return entropyPerChar(candidate) >= 4.3;
}

/** Mask an MSAL-style opaque access token ("1.AVoA…AgAB…"), which is not a JWT. */
function looksLikeOpaqueToken(candidate: string): boolean {
  return /[0-9]/.test(candidate.slice(3)) && /[A-Z]/.test(candidate.slice(3)) && candidate.length >= 16;
}

/**
 * Value-level scrubber for free-form text. Key-based redaction cannot help when a
 * credential appears inside a message or inside a tool RESULT (Graph's addPassword
 * returns a brand-new client secret as a value, not under a telling key), so any
 * text that LOOKS like a token is masked as well.
 *
 * Exported because src/index.ts applies it to result text before auditing.
 */
export function scrubText(text: string): string {
  return (
    text
      // PEM blocks (certificate private keys pasted into arguments or output)
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        "[redacted-private-key]"
      )
      // A whole connection string: the endpoint part is harmless, the key part is not,
      // and the pair together is a ready-to-use credential.
      .replace(
        /\b(?:DefaultEndpointsProtocol|Endpoint|Server|Data Source)=[^\s"']*?(?:AccountKey|SharedAccessKey|SharedAccessSignature|Password)=[^\s"']*/gi,
        "[redacted-connection-string]"
      )
      // Loose key=value credentials, e.g. inside a partial connection string.
      .replace(
        /\b(AccountKey|SharedAccessKey|SharedAccessSignature|AccountSecret|Password|Pwd)=([^;\s"']+)/gi,
        "$1=[redacted]"
      )
      // A SAS in any URL: the signature is the credential, the rest of the URL is useful
      // context, so only sig=/signature= is dropped.
      .replace(/([?&](?:sig|signature)=)[^&\s"'<>]+/gi, "$1[redacted]")
      // JWT: three base64url segments, header starting with the classic {"alg" -> eyJ
      .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, "[redacted-jwt]")
      // Authorization header value in any casing, with or without a JWT behind it
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
      // Basic auth carries username:password in plain base64; only Bearer was handled.
      .replace(/\bBasic\s+[A-Za-z0-9+/=_-]{8,}/gi, "Basic [redacted]")
      // MSAL v1/v2 opaque access token: "1.AVoA…". Not a JWT, so the rule above misses it.
      .replace(/\b[0-9]\.A[A-Za-z0-9._~+/=-]{10,}/g, (match) =>
        looksLikeOpaqueToken(match) ? "[redacted-token]" : match
      )
      // Entra client secret body: a short prefix, a tilde, then a dense random tail.
      .replace(/\b[A-Za-z0-9]{2,8}~[A-Za-z0-9._~-]{12,}/g, (match) =>
        /[a-z]/.test(match) && /[A-Z]/.test(match) && /[0-9]/.test(match) ? "[redacted-secret]" : match
      )
      // Last resort: any long, dense, random-looking run (a storage key, an app secret
      // pasted into a message). Guarded by looksLikeHighEntropySecret so ordinary text,
      // paths, GUIDs and thumbprints survive.
      .replace(/(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{40,}(?![A-Za-z0-9+/=_-])/g, (match) =>
        looksLikeHighEntropySecret(match) ? "[redacted-secret]" : match
      )
  );
}

/**
 * Remove secret-looking values and truncate long strings so the log stays safe and
 * readable.
 *
 * `inSecret` marks everything below a secret-looking KEY. It propagates downwards so
 * a container like passwordProfile still shows its structure
 * (forceChangePasswordNextSignIn: true is useful when reconstructing an incident)
 * while every string and number inside it is masked.
 */
export function redact(value: unknown, depth = 0, inSecret = false): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") {
    if (inSecret) return "[redacted]";
    const scrubbed = scrubText(value);
    return scrubbed.length > MAX_STRING
      ? `${scrubbed.slice(0, MAX_STRING)}… [${scrubbed.length} chars]`
      : scrubbed;
  }
  if (typeof value === "number") return inSecret ? "[redacted]" : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1, inSecret));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A secret key always masks; an identifying key always survives, even below a
      // secret container; anything else inherits the container's verdict.
      const secret = isSecretKey(k) ? true : isIdentifyingKey(k) ? false : inSecret;
      out[k] = redact(v, depth + 1, secret);
    }
    return out;
  }
  return value;
}

/**
 * Rotate before appending so the live log never grows without bound. One previous
 * generation is kept; anything older is dropped on purpose, because this log lives
 * in a user profile and must not silently fill a disk.
 */
function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return; // no file yet
  }
  if (size < ROTATE_BYTES) return;
  const previous = rotatedFilePath(file);
  // rename() overwrites on POSIX but not on Windows, so remove the old generation first.
  if (existsSync(previous)) unlinkSync(previous);
  renameSync(file, previous);
}

/** Paths whose mode was already tightened in this process, so we chmod once. */
const tightened = new Set<string>();

/**
 * Keep the log owner-only. New files get the mode at creation; a log an older version
 * created as 0644 is tightened once per process. chmod is best effort: Windows ignores
 * POSIX modes and must not turn auditing into an error.
 */
function ensurePrivate(file: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  if (tightened.has(file)) return;
  tightened.add(file);
  try {
    chmodSync(dir, STATE_DIR_MODE);
  } catch {
    /* platform without POSIX modes */
  }
  try {
    if (existsSync(file)) chmodSync(file, STATE_FILE_MODE);
  } catch {
    /* platform without POSIX modes */
  }
}

/** Never let auditing break a tool call: failures are reported on stderr only. */
export function recordAudit(entry: AuditEntry): void {
  try {
    const file = auditFilePath();
    ensurePrivate(file);
    rotateIfNeeded(file);
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: STATE_FILE_MODE });
    try {
      chmodSync(file, STATE_FILE_MODE);
    } catch {
      /* platform without POSIX modes */
    }
  } catch (err) {
    console.error("[microsoft-admin-mcp] Could not write audit log:", (err as Error).message);
  }
}

/**
 * Read at most `budget` bytes from the END of a file. When the file is bigger than
 * the budget the first line read is almost certainly a fragment (and may even start
 * mid-UTF-8-sequence), so the caller is told to drop it.
 */
function readTail(file: string, budget: number): { text: string; partialFirstLine: boolean } {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return { text: "", partialFirstLine: false };
  }
  if (size === 0) return { text: "", partialFirstLine: false };
  const length = Math.min(size, budget);
  const start = size - length;
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(file, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buffer.subarray(0, read).toString("utf8"), partialFirstLine: start > 0 };
  } finally {
    closeSync(fd);
  }
}

function parseLines(text: string, dropFirstLine: boolean): AuditEntry[] {
  const lines = text.split("\n");
  if (dropFirstLine) lines.shift();
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      /* skip malformed line (truncated tail fragment, or a crash mid-write) */
    }
  }
  return entries;
}

/**
 * Newest-first view of the audit log.
 *
 * Only the tail of the log is parsed (TAIL_BYTES, topped up from the previous
 * generation when the live file is small), so `totalEntries` counts the matching
 * entries WITHIN that window rather than the whole history. That is the trade-off
 * that keeps this instant on a months-old log.
 */
export function readAudit(opts: {
  limit?: number;
  tool?: string;
  environment?: string;
  since?: string;
}): { file: string; totalEntries: number; entries: AuditEntry[] } {
  const file = auditFilePath();
  if (!existsSync(file)) return { file, totalEntries: 0, entries: [] };

  const live = readTail(file, TAIL_BYTES);
  let entries = parseLines(live.text, live.partialFirstLine);

  // Just after a rotation the live file is nearly empty; spend the rest of the
  // budget on the previous generation so audit_log does not look wiped.
  const spent = Buffer.byteLength(live.text, "utf8");
  if (spent < TAIL_BYTES) {
    const previous = rotatedFilePath(file);
    if (existsSync(previous)) {
      const older = readTail(previous, TAIL_BYTES - spent);
      entries = [...parseLines(older.text, older.partialFirstLine), ...entries];
    }
  }

  if (opts.tool) entries = entries.filter((e) => e.tool === opts.tool);
  if (opts.environment) {
    entries = entries.filter((e) => e.environment?.toLowerCase() === opts.environment!.toLowerCase());
  }
  if (opts.since) entries = entries.filter((e) => e.ts >= opts.since!);
  const limit = opts.limit ?? 25;
  return { file, totalEntries: entries.length, entries: entries.slice(-limit).reverse() };
}
