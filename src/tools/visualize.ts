import { writeFileSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "../http.js";
import { htmlToPdf, htmlToPng } from "../render.js";
import { renderChartsRow, type ChartSpec } from "../charts.js";
// Shared with export_report so both tools escape and place files identically.
import {
  CONFIRM_DESCRIPTION,
  defaultFileName,
  escapeHtml,
  fileSlug,
  guardOutputWrite,
  hardenFile,
  hexColor,
  resolveOutputTarget,
  sanitizeFileSegment,
  withTempHtml,
} from "./report.js";

/**
 * Infographic-style visualizations in the layout language of modern IT diagrams:
 * a bold centered title, rounded tinted panels per topic, icon cards, optional
 * flow arrows between cards, a full-width banner for the shared conclusion, and
 * footer notes. Also supports raw Mermaid diagrams on a styled canvas.
 */

const itemSchema = z.object({
  icon: z.string().optional().describe("Emoji icon, e.g. '🔧' or '🛡️'"),
  label: z.string(),
  sublabel: z.string().optional(),
});

const panelSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  accent: z
    .string()
    .optional()
    .describe(
      "Hex tint for this panel as #rrggbb, e.g. '#dbeafe' (blue) or '#dcfce7' (green). " +
        "Anything else falls back to the default tint."
    ),
  layout: z.enum(["flow", "grid"]).optional().default("grid")
    .describe("'flow' draws arrows between the items, 'grid' shows cards side by side."),
  items: z.array(itemSchema).min(1),
  footer: z.string().optional().describe("Small line under the panel, e.g. 'Design Output: ...'"),
});

/** Inline SVG charts, same shape as the 'charts' parameter of export_report. */
const chartSchema = z.object({
  type: z.enum(["donut", "bar", "hbar"]),
  title: z.string().optional(),
  unit: z.string().optional(),
  data: z
    .array(z.object({ label: z.string(), value: z.number(), color: z.string().optional() }))
    .min(1),
});

type Item = z.infer<typeof itemSchema>;
type Panel = z.infer<typeof panelSchema>;
type ChartInput = z.infer<typeof chartSchema>;

function toChartSpecs(charts: ChartInput[] | undefined): ChartSpec[] {
  return (charts ?? []).map((c) => ({ type: c.type, title: c.title, unit: c.unit, data: c.data }));
}

/** Empty string when nothing was requested, so chart-less output stays unchanged. */
function chartsBlock(charts: ChartSpec[]): string {
  if (charts.length === 0) return "";
  return `<div class="charts-row">${renderChartsRow(charts)}</div>`;
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, sans-serif; margin: 0; background: #fff; color: #16213e; padding: 34px 40px; }
  h1.viz-title { text-align: center; font-size: 27px; margin: 0 0 28px; font-weight: 700; }
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 22px; }
  .panel { border: 2px solid #16213e; border-radius: 14px; padding: 20px 22px; }
  .panel h2 { margin: 0 0 2px; font-size: 17px; letter-spacing: .02em; }
  .panel .sub { margin: 0 0 16px; font-size: 12.5px; color: #475069; }
  .items { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
  .items.grid { align-items: stretch; }
  .items.flow { flex-wrap: nowrap; }
  .items.flow .card { min-width: 0; }
  .card { background: #fff; border: 1.5px solid #cbd2e0; border-radius: 10px; padding: 12px 14px; min-width: 118px; text-align: center; box-shadow: 0 2px 5px rgba(22,33,62,.08); flex: 1; }
  .card .ico { font-size: 27px; line-height: 1.15; }
  .card .lbl { font-weight: 600; font-size: 13px; margin-top: 6px; }
  .card .slb { font-size: 11px; color: #5b6478; margin-top: 2px; }
  .arrow { font-size: 22px; color: #16213e; font-weight: 700; flex: 0; }
  .panel .pfoot { margin-top: 14px; font-size: 12px; font-weight: 600; border-top: 1.5px dashed #94a1b8; padding-top: 10px; }
  .banner { margin-top: 22px; border: 2px solid #16213e; border-radius: 14px; background: #eef1f6; padding: 18px 22px; text-align: center; }
  .banner h2 { margin: 0 0 14px; font-size: 16px; }
  .banner .items { justify-content: center; }
  .banner .card { max-width: 220px; }
  .banner .note { margin-top: 12px; font-size: 12px; color: #475069; }
  .charts-row { margin-top: 22px; }
  /* Targets the wrappers renderChartsRow puts around each SVG. */
  .charts-row > div > div { border: 2px solid #16213e; border-radius: 14px; background: #fff; padding: 12px 14px; }
  footer.viz-foot { text-align: center; color: #8a93a6; font-size: 11px; margin-top: 20px; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
`;

/** Default panel tint, also used when an accent is not a plain #rrggbb value. */
const PANEL_TINT_DEFAULT = "#f2f6fb";

function renderItems(items: Item[], layout: "flow" | "grid"): string {
  // Icon, label and sublabel routinely carry tenant data (device and user names).
  const cards = items.map(
    (it) =>
      `<div class="card"><div class="ico">${escapeHtml(it.icon ?? "▪️")}</div><div class="lbl">${escapeHtml(
        it.label
      )}</div>${it.sublabel ? `<div class="slb">${escapeHtml(it.sublabel)}</div>` : ""}</div>`
  );
  const joined = layout === "flow" ? cards.join('<div class="arrow">→</div>') : cards.join("");
  return `<div class="items ${layout}">${joined}</div>`;
}

function renderInfographic(
  title: string,
  subtitle: string | undefined,
  panels: Panel[],
  banner: { title: string; items: Item[]; note?: string } | undefined,
  footer: string | undefined,
  charts: ChartSpec[] = []
): string {
  const panelHtml = panels
    .map(
      // The accent lands inside a style attribute, where escaping is not enough:
      // only a validated #rrggbb value can never close the attribute.
      (p) => `<div class="panel" style="background:${hexColor(p.accent, PANEL_TINT_DEFAULT)}">
  <h2>${escapeHtml(p.title)}</h2>
  ${p.subtitle ? `<p class="sub">${escapeHtml(p.subtitle)}</p>` : ""}
  ${renderItems(p.items, p.layout ?? "grid")}
  ${p.footer ? `<div class="pfoot">${escapeHtml(p.footer)}</div>` : ""}
</div>`
    )
    .join("\n");
  const bannerHtml = banner
    ? `<div class="banner"><h2>${escapeHtml(banner.title)}</h2>${renderItems(banner.items, "grid")}${
        banner.note ? `<div class="note">${escapeHtml(banner.note)}</div>` : ""
      }</div>`
    : "";
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"><title>${escapeHtml(
    title
  )}</title><style>${BASE_CSS}</style></head>
<body>
  <h1 class="viz-title">${escapeHtml(title)}</h1>
  ${subtitle ? `<p style="text-align:center;margin:-18px 0 24px;color:#475069">${escapeHtml(subtitle)}</p>` : ""}
  <div class="panels">${panelHtml}</div>
  ${chartsBlock(charts)}
  ${bannerHtml}
  ${footer ? `<footer class="viz-foot">${escapeHtml(footer)}</footer>` : ""}
</body></html>`;
}

function renderMermaid(title: string, source: string, charts: ChartSpec[] = []): string {
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"><title>${escapeHtml(
    title
  )}</title><style>${BASE_CSS}
  .mmd { display: flex; justify-content: center; }</style></head>
<body>
  <h1 class="viz-title">${escapeHtml(title)}</h1>
  <div class="mmd"><pre class="mermaid">${escapeHtml(source)}</pre></div>
  ${chartsBlock(charts)}
  <script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.4.1/mermaid.min.js"></script>
  <script>mermaid.initialize({ startOnLoad: true, theme: "base", themeVariables: {
    primaryColor: "#dbeafe", primaryBorderColor: "#16213e", primaryTextColor: "#16213e",
    lineColor: "#16213e", fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: "15px"
  }});</script>
</body></html>`;
}

/**
 * Attribution for a visualization comes ONLY from the caller: there are no data
 * rows to derive it from, and the active environment is never consulted, because
 * a visualization exported while another customer's environment happened to be
 * active would otherwise carry that customer's name into the deliverable.
 * When supplied it is used verbatim, in the footer line and in the default filename.
 */
function footerLine(footer: string | undefined, attribution: string | undefined): string | undefined {
  const parts = [footer?.trim(), attribution?.trim()].filter(
    (p): p is string => p !== undefined && p.length > 0
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function registerVisualizeTools(server: McpServer): void {
  server.registerTool(
    "export_visualization",
    {
      title: "Export visualization (infographic or diagram)",
      description:
        "Create a graphically polished visualization and write it to html, png or pdf. " +
        "Mode 'infographic': structured panels with emoji icon cards, optional flow arrows " +
        "(layout:'flow'), an optional full-width banner for the shared conclusion, and panel footers. " +
        "Ideal for architecture overviews, process flows and comparisons. " +
        "Mode 'mermaid': render any Mermaid diagram (flowchart, sequence, gantt) on a styled canvas " +
        "(png/pdf for mermaid require internet access for the Mermaid library). " +
        "Optional 'charts': inline SVG donut/bar/hbar charts from your own label/value pairs, " +
        "drawn between the panels and the banner in mode 'infographic' and underneath the diagram " +
        "in mode 'mermaid'. They need no internet access and work in html, png and pdf; " +
        "raise 'height' when adding charts so the png captures the full page. " +
        "Tip: use soft tints per panel such as #dbeafe (blue), #dcfce7 (green), #fef9c3 (yellow), #fee2e2 (red).",
      inputSchema: {
        title: z.string(),
        subtitle: z.string().optional(),
        mode: z.enum(["infographic", "mermaid"]),
        format: z.enum(["html", "png", "pdf"]).optional().default("png"),
        panels: z.array(panelSchema).optional().describe("Required for mode 'infographic'."),
        banner: z
          .object({ title: z.string(), items: z.array(itemSchema).min(1), note: z.string().optional() })
          .optional()
          .describe("Optional full-width banner below the panels (shared lesson/goal)."),
        footer: z.string().optional(),
        attribution: z
          .string()
          .optional()
          .describe(
            "Who this visualization is for, e.g. 'Klant A'. Used verbatim in the footer line and in " +
              "the default filename. Recommended for anything handed to a customer."
          ),
        charts: z
          .array(chartSchema)
          .optional()
          .describe(
            "Optional inline SVG charts: after the panels ('infographic') or under the diagram ('mermaid')."
          ),
        mermaid: z.string().optional().describe("Required for mode 'mermaid': the Mermaid source."),
        outputPath: z.string().optional().describe("File or directory. Default: ~/microsoft-admin-mcp-reports/"),
        confirm: z.boolean().optional().describe(CONFIRM_DESCRIPTION),
        width: z.number().int().min(600).max(3000).optional().default(1400),
        height: z.number().int().min(400).max(6000).optional().default(900),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({
      title,
      subtitle,
      mode,
      format,
      panels,
      banner,
      footer,
      attribution,
      charts,
      mermaid,
      outputPath,
      confirm,
      width,
      height,
    }) => {
      try {
        const fmt = format ?? "png";
        const chartSpecs = toChartSpecs(charts);
        let html: string;
        if (mode === "infographic") {
          if (!panels?.length) throw new Error("Mode 'infographic' requires at least one panel.");
          html = renderInfographic(
            title,
            subtitle,
            panels,
            banner,
            footerLine(footer, attribution),
            chartSpecs
          );
        } else {
          if (!mermaid) throw new Error("Mode 'mermaid' requires the mermaid parameter.");
          html = renderMermaid(title, mermaid, chartSpecs);
        }

        const target = resolveOutputTarget(
          outputPath,
          defaultFileName(fileSlug(title, "visual"), sanitizeFileSegment(attribution), fmt)
        );
        // Never clobber a file outside the reports folder without being asked to.
        const guard = guardOutputWrite(target, confirm);
        if (guard) return guard;
        const path = target.path;

        if (fmt === "html") {
          writeFileSync(path, html, { encoding: "utf8", mode: 0o600 });
        } else {
          withTempHtml("mcp-viz", html, (htmlPath) => {
            if (fmt === "pdf") htmlToPdf(htmlPath, path);
            else htmlToPng(htmlPath, path, width ?? 1400, height ?? 900);
          });
        }
        // png/pdf are created by the headless browser (0644) and html may already
        // have existed, so the owner-only mode is enforced here: a visualization
        // carries the same tenant data as a report.
        hardenFile(path);
        return jsonResult({
          written: path,
          mode,
          format: fmt,
          ...(attribution?.trim() ? { attribution: attribution.trim() } : {}),
          ...(target.suffixAdded !== undefined
            ? { suffixAdded: true, pathNote: target.pathNote }
            : {}),
          ...(chartSpecs.length > 0 ? { charts: chartSpecs.length } : {}),
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
