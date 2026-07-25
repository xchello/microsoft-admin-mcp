import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "../http.js";
import { getActiveEnvironment } from "../auth.js";

type Row = Record<string, unknown>;
interface Column {
  key: string;
  label: string;
}

const BRAND_DEFAULT = "#0f6cbd"; // Microsoft-ish blue

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

function defaultOutputDir(): string {
  const dir = join(homedir(), "microsoft-admin-mcp-reports");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report";
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
function toHtml(title: string, subtitle: string | undefined, rows: Row[], columns: Column[], brand: string): string {
  const env = getActiveEnvironment();
  const now = new Date().toLocaleString("nl-NL", { dateStyle: "full", timeStyle: "short" });
  const header = columns.map((c) => `<th>${c.label}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${columns.map((c) => `<td>${cellText(r[c.key]).replace(/</g, "&lt;")}</td>`).join("")}</tr>`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="nl"><head><meta charset="utf-8"><title>${title}</title>
<style>
  :root { --brand: ${brand}; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, sans-serif; margin: 0; background: #f5f7fa; color: #1a1a2e; }
  .hero { background: linear-gradient(120deg, var(--brand), color-mix(in srgb, var(--brand) 55%, #001b33)); color: #fff; padding: 36px 48px; }
  .hero h1 { margin: 0 0 6px; font-size: 26px; font-weight: 600; }
  .hero p { margin: 0; opacity: .85; font-size: 14px; }
  .cards { display: flex; gap: 16px; padding: 24px 48px 0; flex-wrap: wrap; }
  .card { background: #fff; border-radius: 10px; padding: 16px 22px; box-shadow: 0 1px 4px rgba(16,24,40,.08); min-width: 160px; }
  .card .num { font-size: 26px; font-weight: 700; color: var(--brand); }
  .card .lbl { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #667085; }
  .wrap { padding: 24px 48px 48px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 4px rgba(16,24,40,.08); font-size: 13px; }
  th { background: var(--brand); color: #fff; text-align: left; padding: 10px 14px; font-weight: 600; }
  td { padding: 9px 14px; border-top: 1px solid #eef1f5; }
  tr:nth-child(even) td { background: #fafbfc; }
  footer { padding: 0 48px 32px; color: #98a2b3; font-size: 12px; }
  @media print { .hero { -webkit-print-color-adjust: exact; print-color-adjust: exact; } th { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head>
<body>
  <div class="hero"><h1>${title}</h1><p>${subtitle ?? ""}</p></div>
  <div class="cards">
    <div class="card"><div class="num">${rows.length}</div><div class="lbl">Rijen</div></div>
    <div class="card"><div class="num">${env.name}</div><div class="lbl">Omgeving</div></div>
    <div class="card"><div class="num">${now.split(" om ")[0] ?? now}</div><div class="lbl">Gegenereerd</div></div>
  </div>
  <div class="wrap"><table><thead><tr>${header}</tr></thead><tbody>
${body}
  </tbody></table></div>
  <footer>Gegenereerd door microsoft-admin-mcp op ${now} voor omgeving "${env.name}" (tenant ${env.tenantId}).</footer>
</body></html>`;
}

// ---------- PDF via headless Edge/Chrome ----------
function findBrowser(): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ]
        : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((c) => existsSync(c));
}

function htmlToPdf(htmlPath: string, pdfPath: string): void {
  const browser = findBrowser();
  if (!browser) {
    throw new Error(
      "No Edge/Chrome found for PDF generation. Use format 'html' instead, or install Microsoft Edge/Google Chrome."
    );
  }
  const res = spawnSync(
    browser,
    ["--headless", "--disable-gpu", `--print-to-pdf=${pdfPath}`, "--no-pdf-header-footer", htmlPath],
    { timeout: 60_000 }
  );
  if (res.status !== 0 || !existsSync(pdfPath)) {
    throw new Error(`PDF generation failed: ${res.stderr?.toString().slice(0, 500)}`);
  }
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
}

// ---------- DOCX ----------
async function toDocx(path: string, title: string, subtitle: string | undefined, rows: Row[], columns: Column[], brand: string): Promise<void> {
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
                text: `Gegenereerd door microsoft-admin-mcp op ${new Date().toLocaleString("nl-NL")} (omgeving ${getActiveEnvironment().name})`,
                size: 16,
                color: "888888",
              }),
            ],
          }),
        ],
      },
    ],
  });
  writeFileSync(path, await Packer.toBuffer(doc));
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
        "pdf (rendered via headless Edge/Chrome), docx (Word). Returns the absolute path of the file.",
      inputSchema: {
        title: z.string().describe("Report title, e.g. 'Intune compliance klant X en Y'"),
        subtitle: z.string().optional(),
        format: z.enum(["csv", "xlsx", "html", "pdf", "docx"]),
        rows: z.array(z.record(z.unknown())).min(1).describe("The data rows (array of flat objects)."),
        columns: z
          .array(z.object({ key: z.string(), label: z.string() }))
          .optional()
          .describe("Column order and friendly labels. Inferred from the rows when omitted."),
        outputPath: z
          .string()
          .optional()
          .describe("Target file or directory. Default: ~/microsoft-admin-mcp-reports/"),
        brandColor: z.string().optional().describe("Hex accent color, default #0f6cbd."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, subtitle, format, rows, columns, outputPath, brandColor }) => {
      try {
        const cols = columns && columns.length > 0 ? columns : inferColumns(rows as Row[]);
        const brand = /^#[0-9a-fA-F]{6}$/.test(brandColor ?? "") ? (brandColor as string) : BRAND_DEFAULT;

        let target = outputPath ? resolve(outputPath) : defaultOutputDir();
        if (!extname(target)) {
          mkdirSync(target, { recursive: true });
          target = join(target, `${slug(title)}-${new Date().toISOString().slice(0, 10)}.${format}`);
        }

        switch (format) {
          case "csv":
            writeFileSync(target, toCsv(rows as Row[], cols), "utf8");
            break;
          case "html":
            writeFileSync(target, toHtml(title, subtitle, rows as Row[], cols, brand), "utf8");
            break;
          case "pdf": {
            const tmpHtml = join(tmpdir(), `mcp-report-${Date.now()}.html`);
            writeFileSync(tmpHtml, toHtml(title, subtitle, rows as Row[], cols, brand), "utf8");
            htmlToPdf(tmpHtml, target);
            break;
          }
          case "xlsx":
            await toXlsx(target, title, rows as Row[], cols, brand);
            break;
          case "docx":
            await toDocx(target, title, subtitle, rows as Row[], cols, brand);
            break;
        }
        return jsonResult({
          written: target,
          rows: rows.length,
          columns: cols.map((c) => c.label),
          format,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
