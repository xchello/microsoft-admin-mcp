import { chmodSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, extname, relative, isAbsolute, dirname, sep } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "../http.js";
import { getActiveEnvironment } from "../auth.js";
import { guardWrite, readOnlyReason } from "../guard.js";
import { htmlToPdf } from "../render.js";
import { renderChartsRow, type ChartSpec } from "../charts.js";

type Row = Record<string, unknown>;
interface Column {
  key: string;
  label: string;
}

const BRAND_DEFAULT = "#0f6cbd"; // Microsoft-ish blue

/* ------------------------------------------------------- html/path safety
 * These helpers are shared with export_visualization (src/tools/visualize.ts).
 * They live here rather than in a module of their own so the reporting tools
 * keep a single source of truth for how tenant data is escaped and where a
 * generated file is allowed to land.
 */

/**
 * Escape every character that could break out of text content or an attribute.
 * Report and visualization HTML is rendered by a headless Chromium started with
 * --no-sandbox (see src/render.ts), so an unescaped tenant string (a device
 * name, a UPN, a group display name) would be script execution with the whole
 * report in scope. Identical to the esc() helper in src/charts.ts.
 */
export function escapeHtml(raw: string): string {
  return String(raw)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Accept only a plain 6-digit hex colour. Colours are interpolated into style
 * attributes and CSS custom properties, where escaping alone is not enough:
 * a value like `#fff" onload="alert(1)` would otherwise close the attribute.
 */
export function hexColor(value: string | undefined, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value ?? "") ? (value as string) : fallback;
}

/** The default landing zone for generated files: writes here need no confirm. */
export function reportsDir(): string {
  return join(homedir(), "microsoft-admin-mcp-reports");
}

/** The server's own state (environments.json, audit log, ...); never writable. */
function stateDir(): string {
  return join(homedir(), ".microsoft-admin-mcp");
}

/**
 * Reports and visualizations contain customer PII (UPNs, device names, group
 * names) for MULTIPLE customers side by side in one directory, so the directory
 * is owner-only and so is every file we generate. 0700/0600 rather than the
 * default 0755/0644.
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * `mode` on mkdirSync only applies to directories it actually creates, and umask
 * can widen it; an existing directory keeps whatever mode it had (0755 from an
 * older version of this server). Tighten unconditionally, but only for our own
 * reports directory - never for a directory the caller pointed us at.
 */
function ensureReportsDirExists(): string {
  const dir = reportsDir();
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, DIR_MODE);
    } catch {
      /* not ours to tighten; the per-file mode still protects the content */
    }
  }
  return dir;
}

/**
 * Make a generated file owner-only. writeFileSync's `mode` is ignored for a file
 * that already exists, and pdf/png files are created by the headless browser
 * (0644) entirely outside our control, so the mode is enforced afterwards.
 */
export function hardenFile(path: string): void {
  if (process.platform === "win32") return; // no POSIX modes to set
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    /* best effort: a failure here must not lose the report itself */
  }
}

/** lstat-based: existsSync follows links, so a dangling symlink looks absent. */
function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Windows paths are case-insensitive, so compare on a normalized key. */
function pathKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(pathKey(parent), pathKey(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function hasGitSegment(target: string): boolean {
  return pathKey(target).split(sep).includes(".git");
}

/**
 * Locations that are never a legitimate report destination. Refused outright
 * (not confirmable): writing here corrupts the server's own configuration or a
 * git repository's internals, which no report is ever meant to do.
 */
function refuseForbiddenLocation(target: string): void {
  if (isInside(target, stateDir())) {
    throw new Error(
      `Geweigerd: "${target}" ligt in de eigen configuratiemap van de server (${stateDir()}). ` +
        "Daar staan de omgevingen, tokens en logboeken; een rapport wegschrijven zou die vernietigen. " +
        `Kies een pad buiten die map, bijvoorbeeld in ${reportsDir()}.`
    );
  }
  if (hasGitSegment(target)) {
    throw new Error(
      `Geweigerd: "${target}" ligt in een .git-map. Rapporten mogen niet in de interne bestanden ` +
        `van een git-repository worden weggeschreven. Kies een ander pad, bijvoorbeeld in ${reportsDir()}.`
    );
  }
}

/**
 * Where the target REALLY lands, with every symlink in the path resolved. A
 * lexical path is not a location: a link inside the reports directory can point
 * anywhere, and writeFileSync/Chromium follow it.
 */
function realLocation(target: string): string {
  if (pathExists(target)) {
    try {
      return realpathSync(target);
    } catch {
      /* dangling link: fall through to resolving the parent */
    }
  }
  const parent = dirname(target);
  try {
    return join(realpathSync(parent), basename(target));
  } catch {
    return target; // parent does not exist yet; nothing can be hiding behind it
  }
}

/** The reports directory itself may sit behind a link (/home -> /var/home). */
function realReportsDir(): string {
  try {
    return realpathSync(reportsDir());
  } catch {
    return reportsDir();
  }
}

/**
 * Decide, on the RESOLVED location, whether the target is inside the reports
 * directory - and refuse the cases where the lexical answer and the real answer
 * disagree. A symlink placed in the reports directory used to be accepted as
 * "inside", which skipped both the overwrite confirm and the read-only check
 * while writeFileSync happily overwrote whatever the link pointed at.
 */
function classifyTarget(target: string): boolean {
  if (isSymlink(target)) {
    throw new Error(
      `Geweigerd: "${target}" is zelf een symbolische link. Een rapport wordt nooit via een link ` +
        "weggeschreven, omdat dan het doel van die link wordt overschreven in plaats van het rapport. " +
        "Geef een gewoon bestandspad op."
    );
  }
  const real = realLocation(target);
  refuseForbiddenLocation(target);
  if (real !== target) refuseForbiddenLocation(real);

  const lexicalInside = isInside(target, reportsDir());
  const reallyInside = isInside(real, realReportsDir());
  if (lexicalInside && !reallyInside) {
    throw new Error(
      `Geweigerd: "${target}" lijkt in de rapportmap (${reportsDir()}) te liggen, maar komt via een ` +
        `link daadwerkelijk uit op "${real}" buiten die map. Rapporten mogen de rapportmap niet ` +
        "langs een link verlaten. Geef een expliciet pad op als daar echt geschreven moet worden."
    );
  }
  return lexicalInside && reallyInside;
}

/** A resolved, safety-classified destination for a generated file. */
export interface OutputTarget {
  /** The absolute path that will be written. */
  path: string;
  /** Resolved (not merely lexical) containment in the reports directory. */
  insideReports: boolean;
  /** Set when the computed default name existed and a counter was appended. */
  suffixAdded?: number;
  /** Dutch explanation of that suffix, meant for the tool result. */
  pathNote?: string;
}

/**
 * How many `-2`, `-3`, ... variants of one default name we are willing to make
 * before telling the caller to pick a path. Deliberately bounded: silently
 * producing a hundred near-identical exports is its own kind of accident.
 */
const MAX_NAME_SUFFIX = 99;

/**
 * Never overwrite a file we named ourselves. Two exports with the same title on
 * the same day used to collide, and the second silently destroyed the first -
 * including the case where the two held DIFFERENT customers' data. The suffix is
 * a counter, so the same inputs keep producing the same name (no timestamp, no
 * randomness beyond the date already in the name).
 */
function uniqueInDirectory(dir: string, fileName: string): { path: string; suffix?: number } {
  const first = join(dir, fileName);
  if (!pathExists(first)) return { path: first };
  const ext = extname(fileName);
  const stem = ext ? fileName.slice(0, -ext.length) : fileName;
  for (let n = 2; n <= MAX_NAME_SUFFIX; n++) {
    const candidate = join(dir, `${stem}-${n}${ext}`);
    if (!pathExists(candidate)) return { path: candidate, suffix: n };
  }
  throw new Error(
    `Geweigerd: er bestaan al ${MAX_NAME_SUFFIX} bestanden met de naam "${stem}" in "${dir}". ` +
      "Ruim die map op of geef een expliciet outputPath op; bestaande rapporten worden niet overschreven."
  );
}

/**
 * Turn the caller's outputPath into a concrete, safety-classified destination.
 * A path without an extension is treated as a directory (unchanged behaviour).
 * The location check runs before any directory is created, so a refused path
 * leaves no trace.
 *
 * A name WE compute (no outputPath, or a directory as outputPath) is made
 * collision-free; an explicit file path is returned as given, so the existing
 * confirm-to-overwrite rule keeps deciding what happens to it.
 */
export function resolveOutputTarget(outputPath: string | undefined, fileName: string): OutputTarget {
  const withNote = (picked: { path: string; suffix?: number }): OutputTarget => ({
    path: picked.path,
    insideReports: classifyTarget(picked.path),
    ...(picked.suffix === undefined
      ? {}
      : {
          suffixAdded: picked.suffix,
          pathNote:
            `Er bestond al een bestand met de standaardnaam "${fileName}" in "${dirname(picked.path)}". ` +
            `Dat bestand is NIET overschreven; dit rapport is weggeschreven als "${basename(picked.path)}".`,
        }),
  });

  if (!outputPath) return withNote(uniqueInDirectory(ensureReportsDirExists(), fileName));

  const base = resolve(outputPath);
  refuseForbiddenLocation(base);
  if (!extname(base)) {
    mkdirSync(base, { recursive: true });
    // Resolve the directory once so a link'ed report directory is judged on its
    // real location rather than on the name the caller typed.
    let dir = base;
    try {
      dir = realpathSync(base);
    } catch {
      /* just created it; keep the lexical path */
    }
    refuseForbiddenLocation(dir);
    return withNote(uniqueInDirectory(dir, fileName));
  }
  // A file path inside our own reports folder must work even on the very first
  // run, when that folder does not exist yet. Elsewhere the caller's directory
  // layout is left alone: a missing parent stays an error rather than the tool
  // silently building a directory tree at an arbitrary location.
  if (isInside(base, reportsDir())) {
    ensureReportsDirExists();
    mkdirSync(dirname(base), { recursive: true, mode: DIR_MODE });
  }
  return withNote({ path: base });
}

/**
 * Ask before destroying something the user did not put in the reports folder.
 * Inside the default reports directory everything stays frictionless, and
 * creating a NEW file anywhere is allowed because it destroys nothing; only
 * overwriting an existing file elsewhere needs confirm:true.
 *
 * Read-only mode is deliberately asymmetric here: a report is not a tenant
 * change, and the human explicitly asked for it, so the reports directory stays
 * writable. Anywhere else is refused, because "read-only" has to mean the server
 * cannot drop files at arbitrary places on the machine.
 * Returns a tool result to return early, or undefined to proceed.
 */
export function guardOutputWrite(
  target: OutputTarget,
  confirm: boolean | undefined
): ReturnType<typeof guardWrite> {
  const blocked = readOnlyReason();
  if (blocked && !target.insideReports) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text:
            `Geweigerd: schrijven is uitgeschakeld (${blocked}). Het pad "${target.path}" ligt buiten de ` +
            `standaard rapportmap (${reportsDir()}), dus er is niets weggeschreven. Rapporteren mag in ` +
            "de rapportmap: laat outputPath weg of kies een pad daarbinnen.",
        },
      ],
    };
  }
  if (target.insideReports) return undefined;
  if (!pathExists(target.path)) return undefined;
  return guardWrite(
    confirm,
    `het bestaande bestand "${target.path}" overschrijven. Dit bestand ligt buiten de standaard ` +
      `rapportmap (${reportsDir()}), dus de huidige inhoud gaat definitief verloren.`
  );
}

/** Shared description for the `confirm` parameter of both reporting tools. */
export const CONFIRM_DESCRIPTION =
  "vereist bij het overschrijven van een bestaand bestand buiten de standaard rapportmap";

/**
 * Write the intermediate HTML for a browser render, run `render`, and always
 * remove that file again: it contains the full tenant table (UPNs, device
 * names) and used to be left behind in the OS temp directory forever.
 */
export function withTempHtml(prefix: string, html: string, render: (htmlPath: string) => void): void {
  const tmpHtml = join(tmpdir(), `${prefix}-${Date.now()}-${process.pid}.html`);
  try {
    // Owner-only: the temp directory is world-readable on most systems.
    writeFileSync(tmpHtml, html, { encoding: "utf8", mode: 0o600 });
    render(tmpHtml);
  } finally {
    rmSync(tmpHtml, { force: true });
  }
}

/** Explicit chart specs, shared shape with export_visualization. */
const chartSchema = z.object({
  type: z.enum(["donut", "bar", "hbar"]),
  title: z.string().optional(),
  unit: z.string().optional(),
  data: z
    .array(z.object({ label: z.string(), value: z.number(), color: z.string().optional() }))
    .min(1),
});

/** Derive a chart from the rows themselves, so the caller does not have to count. */
const autoChartSchema = z.object({
  column: z.string().describe("Key in the rows to count distinct values of."),
  type: z.enum(["donut", "bar", "hbar"]).optional().default("donut"),
  title: z.string().optional(),
});

type ChartInput = z.infer<typeof chartSchema>;
type AutoChartInput = z.infer<typeof autoChartSchema>;

/** Label used for rows where the counted column is missing, null or empty. */
const EMPTY_LABEL = "(leeg)";

/**
 * Count how often each distinct value of `column` occurs and turn that into one
 * chart spec, highest count first. Returns undefined when no row carries the
 * column at all: a typo in the column name should degrade into a warning, never
 * into a failed export.
 */
function buildAutoChart(rows: Row[], auto: AutoChartInput): ChartSpec | undefined {
  const present = rows.some((r) => Object.prototype.hasOwnProperty.call(r, auto.column));
  if (!present) return undefined;

  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = cellText(row[auto.column]).trim();
    const label = raw.length > 0 ? raw : EMPTY_LABEL;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const data = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label, value }));

  return {
    type: auto.type ?? "donut",
    title: auto.title ?? `Verdeling per ${auto.column}`,
    unit: "rijen",
    data,
  };
}

/** Explicit charts first, then the derived one. Empty array means: render nothing. */
function collectCharts(
  rows: Row[],
  charts: ChartInput[] | undefined,
  autoChart: AutoChartInput | undefined
): { specs: ChartSpec[]; warnings: string[] } {
  const specs: ChartSpec[] = (charts ?? []).map((c) => ({
    type: c.type,
    title: c.title,
    unit: c.unit,
    data: c.data,
  }));
  const warnings: string[] = [];
  if (autoChart) {
    const derived = buildAutoChart(rows, autoChart);
    if (derived) specs.push(derived);
    else
      warnings.push(
        `Kolom "${autoChart.column}" komt in geen enkele rij voor; automatische grafiek overgeslagen.`
      );
  }
  return { specs, warnings };
}

function inferColumns(rows: Row[]): Column[] {
  const keys = new Set<string>();
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) keys.add(k);
  return [...keys].map((k) => ({ key: k, label: k }));
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Shared with export_visualization, which uses its own fallback stem. */
export function fileSlug(s: string, fallback: string, max = 60): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, max) || fallback;
}

function slug(s: string): string {
  return fileSlug(s, "report");
}

/* ------------------------------------------------------------- attribution
 * WHO is this document about? Never the active environment.
 *
 * This server administers several customer tenants, and multi_tenant_query
 * restores the previously active environment before the export runs. Stamping a
 * document with getActiveEnvironment() therefore put an UNRELATED customer's
 * environment name and tenant id in a file that is handed to someone else -
 * disclosure plus misattribution, in the normal cross-customer flow. Attribution
 * is derived from the caller's intent or from the data, and only as a last resort
 * from ambient state, in which case the wording stops claiming ownership.
 */

export type AttributionSource = "parameter" | "rows" | "activeEnvironment" | "unknown";

export interface Attribution {
  /** Text shown to the reader; empty only for source "unknown". */
  label: string;
  source: AttributionSource;
  /** Which row column the label came from, for the tool result. */
  column?: string;
}

/** Column names that identify a customer, in order of preference. */
const CUSTOMER_COLUMNS = ["klant", "customer", "tenant", "environment"] as const;

/** Beyond this the label stops being readable in a KPI card and a footer. */
const MAX_ATTRIBUTION_VALUES = 4;

function findCustomerColumn(rows: Row[]): string | undefined {
  const keys = new Set<string>();
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) keys.add(k);
  for (const wanted of CUSTOMER_COLUMNS) {
    for (const k of keys) if (k.toLowerCase() === wanted) return k;
  }
  return undefined;
}

/** All rows, not just the first 50: a label must not omit a customer. */
function distinctValues(rows: Row[], key: string): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const value = cellText(r[key]).trim();
    if (value.length > 0) seen.add(value);
  }
  // Sorted, so the same data always yields the same label (and the same filename).
  return [...seen].sort((a, b) => a.localeCompare(b, "nl"));
}

function joinCapped(values: string[]): string {
  if (values.length <= MAX_ATTRIBUTION_VALUES) return values.join(", ");
  const shown = values.slice(0, MAX_ATTRIBUTION_VALUES).join(", ");
  return `${shown} +${values.length - MAX_ATTRIBUTION_VALUES} meer`;
}

export function resolveAttribution(explicit: string | undefined, rows: Row[]): Attribution {
  const given = explicit?.trim();
  if (given) return { label: given, source: "parameter" };

  const column = findCustomerColumn(rows);
  if (column) {
    const values = distinctValues(rows, column);
    if (values.length > 0) return { label: joinCapped(values), source: "rows", column };
  }

  // Last resort. Only the NAME, never the tenant id: a tenant id from ambient
  // state must never appear in a document that goes to a different customer.
  try {
    return { label: getActiveEnvironment().name, source: "activeEnvironment" };
  } catch {
    return { label: "", source: "unknown" };
  }
}

/** The KPI card: a customer claim only when the attribution actually supports one. */
function attributionCard(a: Attribution): { value: string; label: string } {
  if (a.source === "parameter" || a.source === "rows") return { value: a.label, label: "Klant" };
  if (a.source === "activeEnvironment") return { value: a.label, label: "Actieve omgeving" };
  return { value: "onbekend", label: "Herkomst" };
}

/** The footer sentence. Weak provenance is spelled out instead of asserted. */
function attributionFooter(a: Attribution, now: string): string {
  const generated = `Gegenereerd door microsoft-admin-mcp op ${now}`;
  if (a.source === "parameter" || a.source === "rows") return `${generated} voor ${a.label}.`;
  if (a.source === "activeEnvironment") {
    return (
      `${generated} vanuit de op dat moment actieve omgeving "${a.label}". De gegevens bevatten geen ` +
      "klantkenmerk, dus dit rapport is niet aantoonbaar toe te wijzen aan een specifieke klant."
    );
  }
  return (
    `${generated}. De herkomst van deze gegevens is niet vastgesteld: er is geen klantkenmerk in de ` +
    "gegevens en er is geen actieve omgeving."
  );
}

/**
 * The attribution belongs in the default filename, so two customers' exports of
 * the same report on the same day cannot land on one path. Omitted for the
 * ambient-state fallback: an internal environment name is exactly what should not
 * travel with a file handed to another customer.
 */
export function sanitizeFileSegment(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const segment = fileSlug(label, "", 40);
  return segment.length > 0 ? segment : undefined;
}

export function attributionFileSegment(a: Attribution): string | undefined {
  if (a.source !== "parameter" && a.source !== "rows") return undefined;
  return sanitizeFileSegment(a.label);
}

/** `<stem>-<attribution>-<YYYY-MM-DD>.<ext>`; the date has no time-of-day part. */
export function defaultFileName(stem: string, segment: string | undefined, ext: string): string {
  const parts = [stem, segment, new Date().toISOString().slice(0, 10)].filter(
    (p): p is string => p !== undefined && p.length > 0
  );
  return `${parts.join("-")}.${ext}`;
}

// ---------- CSV ----------
function toCsv(rows: Row[], columns: Column[]): string {
  const esc = (s: string) => (/[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [columns.map((c) => esc(c.label)).join(";")];
  for (const r of rows) lines.push(columns.map((c) => esc(cellText(r[c.key]))).join(";"));
  // UTF-8 BOM plus semicolon separator so Excel (EU locales) opens it correctly.
  return "\ufeff" + lines.join("\r\n");
}

// ---------- HTML ----------
function toHtml(
  title: string,
  subtitle: string | undefined,
  rows: Row[],
  columns: Column[],
  brand: string,
  attribution: Attribution,
  charts: ChartSpec[] = []
): string {
  const card = attributionCard(attribution);
  const now = new Date().toLocaleString("nl-NL", { dateStyle: "full", timeStyle: "short" });
  // Column labels and cell values are caller/tenant data: escape both fully.
  const header = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${columns.map((c) => `<td>${escapeHtml(cellText(r[c.key]))}</td>`).join("")}</tr>`)
    .join("\n");
  // Empty string when no charts were requested, so the markup stays byte-identical
  // to the pre-charts output for existing callers.
  const chartsHtml =
    charts.length > 0 ? `\n  <div class="charts">${renderChartsRow(charts)}</div>` : "";
  // Defensive: this value lands unquoted in a CSS custom property, so re-validate
  // it here as well instead of trusting every present and future call site.
  const accent = hexColor(brand, BRAND_DEFAULT);
  return `<!DOCTYPE html>
<html lang="nl"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  :root { --brand: ${accent}; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, sans-serif; margin: 0; background: #f5f7fa; color: #1a1a2e; }
  .hero { background: linear-gradient(120deg, var(--brand), color-mix(in srgb, var(--brand) 55%, #001b33)); color: #fff; padding: 36px 48px; }
  .hero h1 { margin: 0 0 6px; font-size: 26px; font-weight: 600; }
  .hero p { margin: 0; opacity: .85; font-size: 14px; }
  .cards { display: flex; gap: 16px; padding: 24px 48px 0; flex-wrap: wrap; }
  .card { background: #fff; border-radius: 10px; padding: 16px 22px; box-shadow: 0 1px 4px rgba(16,24,40,.08); min-width: 160px; }
  /* max-width/overflow-wrap keep a long attribution ("Klant A en Klant B") inside
     the card instead of pushing it off the printed page. */
  .card .num { font-size: 26px; font-weight: 700; color: var(--brand); max-width: 420px; overflow-wrap: anywhere; }
  .card .lbl { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #667085; }
  .charts { padding: 24px 48px 0; }
  /* Targets the wrappers renderChartsRow puts around each SVG. */
  .charts > div > div { background: #fff; border-radius: 10px; padding: 10px 12px; box-shadow: 0 1px 4px rgba(16,24,40,.08); }
  .wrap { padding: 24px 48px 48px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 4px rgba(16,24,40,.08); font-size: 13px; }
  th { background: var(--brand); color: #fff; text-align: left; padding: 10px 14px; font-weight: 600; }
  td { padding: 9px 14px; border-top: 1px solid #eef1f5; }
  tr:nth-child(even) td { background: #fafbfc; }
  footer { padding: 0 48px 32px; color: #98a2b3; font-size: 12px; }
  @media print { .hero { -webkit-print-color-adjust: exact; print-color-adjust: exact; } th { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head>
<body>
  <div class="hero"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle ?? "")}</p></div>
  <div class="cards">
    <div class="card"><div class="num">${rows.length}</div><div class="lbl">Rijen</div></div>
    <div class="card"><div class="num">${escapeHtml(card.value)}</div><div class="lbl">${escapeHtml(card.label)}</div></div>
    <div class="card"><div class="num">${escapeHtml(now.split(" om ")[0] ?? now)}</div><div class="lbl">Gegenereerd</div></div>
  </div>${chartsHtml}
  <div class="wrap"><table><thead><tr>${header}</tr></thead><tbody>
${body}
  </tbody></table></div>
  <footer>${escapeHtml(attributionFooter(attribution, now))}</footer>
</body></html>`;
}

// ---------- XLSX ----------
async function toXlsx(path: string, title: string, rows: Row[], columns: Column[], brand: string): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "microsoft-admin-mcp";
  const ws = wb.addWorksheet("Rapport", { views: [{ state: "frozen", ySplit: 2 }] });

  ws.mergeCells(1, 1, 1, Math.max(columns.length, 1));
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { size: 14, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + brand.replace("#", "") } };
  titleCell.alignment = { vertical: "middle" };
  ws.getRow(1).height = 26;

  const headerRow = ws.getRow(2);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + brand.replace("#", "") } };
    cell.border = { bottom: { style: "thin" } };
  });

  for (const r of rows) {
    ws.addRow(columns.map((c) => {
      const v = r[c.key];
      return typeof v === "object" && v !== null ? JSON.stringify(v) : (v as string | number | boolean | null);
    }));
  }

  columns.forEach((c, i) => {
    const maxLen = Math.max(c.label.length, ...rows.slice(0, 200).map((r) => cellText(r[c.key]).length));
    ws.getColumn(i + 1).width = Math.min(Math.max(maxLen + 2, 10), 60);
  });
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: columns.length } };

  await wb.xlsx.writeFile(path);
  // ExcelJS creates the file itself, so the owner-only mode is applied afterwards.
  hardenFile(path);
}

// ---------- DOCX ----------
async function toDocx(
  path: string,
  title: string,
  subtitle: string | undefined,
  rows: Row[],
  columns: Column[],
  brand: string,
  attribution: Attribution
): Promise<void> {
  const docx = await import("docx");
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel, ShadingType } = docx;
  const brandHex = brand.replace("#", "").toUpperCase();

  const headerCells = columns.map(
    (c) =>
      new TableCell({
        shading: { type: ShadingType.CLEAR, fill: brandHex },
        children: [new Paragraph({ children: [new TextRun({ text: c.label, bold: true, color: "FFFFFF" })] })],
      })
  );
  const dataRows = rows.map(
    (r) =>
      new TableRow({
        children: columns.map(
          (c) => new TableCell({ children: [new Paragraph({ children: [new TextRun(cellText(r[c.key]))] })] })
        ),
      })
  );

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: title, color: brandHex })] }),
          ...(subtitle ? [new Paragraph({ children: [new TextRun({ text: subtitle, italics: true })] })] : []),
          new Paragraph({ children: [] }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [new TableRow({ children: headerCells, tableHeader: true }), ...dataRows],
          }),
          new Paragraph({ children: [] }),
          new Paragraph({
            children: [
              new TextRun({
                text: attributionFooter(attribution, new Date().toLocaleString("nl-NL")),
                size: 16,
                color: "888888",
              }),
            ],
          }),
        ],
      },
    ],
  });
  writeFileSync(path, await Packer.toBuffer(doc), { mode: FILE_MODE });
  hardenFile(path);
}

export function registerReportTools(server: McpServer): void {
  server.registerTool(
    "export_report",
    {
      title: "Export report (csv, xlsx, html, pdf, docx)",
      description:
        "Turn tabular data into a polished report file. Collect the data first with other tools " +
        "(optionally across multiple environments; add a column like 'klant' to distinguish them), then " +
        "pass the rows here. Formats: csv (Excel-compatible), xlsx (styled workbook), html (styled page), " +
        "pdf (rendered via headless Edge/Chrome), docx (Word). Returns the absolute path of the file. " +
        "Pass 'attribution' (e.g. 'Klant A') to state who the report is about: it is used verbatim in the " +
        "KPI card, the footer and the default filename, and it is what keeps a report handed to one " +
        "customer from being stamped with another customer's environment. The default filename never " +
        "overwrites an existing report: a counter is appended and the result says so. " +
        "Optionally add inline SVG charts between the KPI cards and the table: 'charts' takes explicit " +
        "donut/bar/hbar specs with your own label/value pairs, and 'autoChart' derives one chart by " +
        "counting the distinct values of a column in the rows (no need to count yourself). " +
        "Charts are only embedded in html and pdf; csv, xlsx and docx are written without them.",
      inputSchema: {
        title: z.string().describe("Report title, e.g. 'Intune compliance klant X en Y'"),
        subtitle: z.string().optional(),
        format: z.enum(["csv", "xlsx", "html", "pdf", "docx"]),
        rows: z.array(z.record(z.unknown())).min(1).describe("The data rows (array of flat objects)."),
        columns: z
          .array(z.object({ key: z.string(), label: z.string() }))
          .optional()
          .describe("Column order and friendly labels. Inferred from the rows when omitted."),
        attribution: z
          .string()
          .optional()
          .describe(
            "Who this report is about, e.g. 'Klant A' or 'Klant A en Klant B'. Used verbatim in the " +
              "KPI card, the footer and the default filename. Strongly recommended for a report you " +
              "hand to a customer: when omitted the tool derives it from a klant/customer/tenant/" +
              "environment column in the rows, and only otherwise falls back to the active environment."
          ),
        outputPath: z
          .string()
          .optional()
          .describe("Target file or directory. Default: ~/microsoft-admin-mcp-reports/"),
        confirm: z.boolean().optional().describe(CONFIRM_DESCRIPTION),
        brandColor: z
          .string()
          .optional()
          .describe("Hex accent color as #rrggbb, default #0f6cbd. Anything else falls back to the default."),
        charts: z
          .array(chartSchema)
          .optional()
          .describe(
            "Explicit charts, rendered between the KPI cards and the table (html/pdf only)."
          ),
        autoChart: autoChartSchema
          .optional()
          .describe(
            "Derive one chart by counting the distinct values of a column in the rows " +
              "(html/pdf only). Unknown column -> a warning instead of an error."
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({
      title,
      subtitle,
      format,
      rows,
      columns,
      attribution: attributionInput,
      outputPath,
      confirm,
      brandColor,
      charts,
      autoChart,
    }) => {
      try {
        const cols = columns && columns.length > 0 ? columns : inferColumns(rows as Row[]);
        const brand = hexColor(brandColor, BRAND_DEFAULT);
        const { specs, warnings } = collectCharts(rows as Row[], charts, autoChart);
        const chartsRequested = (charts?.length ?? 0) > 0 || autoChart !== undefined;
        const embedsCharts = format === "html" || format === "pdf";

        // Resolved once, before anything is written: the same attribution stamps the
        // document and names the file, so path and content can never disagree.
        const attribution = resolveAttribution(attributionInput, rows as Row[]);

        const target = resolveOutputTarget(
          outputPath,
          defaultFileName(slug(title), attributionFileSegment(attribution), format)
        );
        // Never clobber a file outside the reports folder without being asked to.
        const guard = guardOutputWrite(target, confirm);
        if (guard) return guard;
        const path = target.path;

        switch (format) {
          case "csv":
            writeFileSync(path, toCsv(rows as Row[], cols), { encoding: "utf8", mode: FILE_MODE });
            break;
          case "html":
            writeFileSync(path, toHtml(title, subtitle, rows as Row[], cols, brand, attribution, specs), {
              encoding: "utf8",
              mode: FILE_MODE,
            });
            break;
          case "pdf":
            withTempHtml(
              "mcp-report",
              toHtml(title, subtitle, rows as Row[], cols, brand, attribution, specs),
              (htmlPath) => htmlToPdf(htmlPath, path)
            );
            break;
          case "xlsx":
            await toXlsx(path, title, rows as Row[], cols, brand);
            break;
          case "docx":
            await toDocx(path, title, subtitle, rows as Row[], cols, brand, attribution);
            break;
        }
        // The browser creates the pdf itself; csv/html get their mode at creation
        // but keep an older, looser one when the file already existed.
        hardenFile(path);
        return jsonResult({
          written: path,
          rows: rows.length,
          columns: cols.map((c) => c.label),
          format,
          attribution: attribution.label,
          attributionSource: attribution.source,
          ...(attribution.column ? { attributionColumn: attribution.column } : {}),
          ...(target.suffixAdded !== undefined
            ? { suffixAdded: true, pathNote: target.pathNote }
            : {}),
          // Chart keys are omitted entirely when no chart was asked for, so the
          // payload of an existing call is unchanged.
          ...(chartsRequested ? { charts: embedsCharts ? specs.length : 0 } : {}),
          ...(chartsRequested && !embedsCharts
            ? {
                note:
                  `Grafieken worden alleen ingesloten in html en pdf; het ${format}-bestand ` +
                  "is zonder grafieken weggeschreven.",
              }
            : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
