import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "../http.js";
import { htmlToPdf, htmlToPng } from "../render.js";

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
    .describe("Hex tint for this panel, e.g. '#dbeafe' (blue) or '#dcfce7' (green)."),
  layout: z.enum(["flow", "grid"]).optional().default("grid")
    .describe("'flow' draws arrows between the items, 'grid' shows cards side by side."),
  items: z.array(itemSchema).min(1),
  footer: z.string().optional().describe("Small line under the panel, e.g. 'Design Output: ...'"),
});

type Item = z.infer<typeof itemSchema>;
type Panel = z.infer<typeof panelSchema>;

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
  footer.viz-foot { text-align: center; color: #8a93a6; font-size: 11px; margin-top: 20px; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
`;

function renderItems(items: Item[], layout: "flow" | "grid"): string {
  const cards = items.map(
    (it) =>
      `<div class="card"><div class="ico">${it.icon ?? "▪️"}</div><div class="lbl">${it.label}</div>${
        it.sublabel ? `<div class="slb">${it.sublabel}</div>` : ""
      }</div>`
  );
  const joined = layout === "flow" ? cards.join('<div class="arrow">→</div>') : cards.join("");
  return `<div class="items ${layout}">${joined}</div>`;
}

function renderInfographic(
  title: string,
  subtitle: string | undefined,
  panels: Panel[],
  banner: { title: string; items: Item[]; note?: string } | undefined,
  footer: string | undefined
): string {
  const panelHtml = panels
    .map(
      (p) => `<div class="panel" style="background:${p.accent ?? "#f2f6fb"}">
  <h2>${p.title}</h2>
  ${p.subtitle ? `<p class="sub">${p.subtitle}</p>` : ""}
  ${renderItems(p.items, p.layout ?? "grid")}
  ${p.footer ? `<div class="pfoot">${p.footer}</div>` : ""}
</div>`
    )
    .join("\n");
  const bannerHtml = banner
    ? `<div class="banner"><h2>${banner.title}</h2>${renderItems(banner.items, "grid")}${
        banner.note ? `<div class="note">${banner.note}</div>` : ""
      }</div>`
    : "";
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"><title>${title}</title><style>${BASE_CSS}</style></head>
<body>
  <h1 class="viz-title">${title}</h1>
  ${subtitle ? `<p style="text-align:center;margin:-18px 0 24px;color:#475069">${subtitle}</p>` : ""}
  <div class="panels">${panelHtml}</div>
  ${bannerHtml}
  ${footer ? `<footer class="viz-foot">${footer}</footer>` : ""}
</body></html>`;
}

function renderMermaid(title: string, source: string): string {
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"><title>${title}</title><style>${BASE_CSS}
  .mmd { display: flex; justify-content: center; }</style></head>
<body>
  <h1 class="viz-title">${title}</h1>
  <div class="mmd"><pre class="mermaid">${source.replace(/</g, "&lt;")}</pre></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.4.1/mermaid.min.js"></script>
  <script>mermaid.initialize({ startOnLoad: true, theme: "base", themeVariables: {
    primaryColor: "#dbeafe", primaryBorderColor: "#16213e", primaryTextColor: "#16213e",
    lineColor: "#16213e", fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: "15px"
  }});</script>
</body></html>`;
}

function defaultOutputDir(): string {
  const dir = join(homedir(), "microsoft-admin-mcp-reports");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "visual";
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
        mermaid: z.string().optional().describe("Required for mode 'mermaid': the Mermaid source."),
        outputPath: z.string().optional().describe("File or directory. Default: ~/microsoft-admin-mcp-reports/"),
        width: z.number().int().min(600).max(3000).optional().default(1400),
        height: z.number().int().min(400).max(6000).optional().default(900),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, subtitle, mode, format, panels, banner, footer, mermaid, outputPath, width, height }) => {
      try {
        const fmt = format ?? "png";
        let html: string;
        if (mode === "infographic") {
          if (!panels?.length) throw new Error("Mode 'infographic' requires at least one panel.");
          html = renderInfographic(title, subtitle, panels, banner, footer);
        } else {
          if (!mermaid) throw new Error("Mode 'mermaid' requires the mermaid parameter.");
          html = renderMermaid(title, mermaid);
        }

        let target = outputPath ? resolve(outputPath) : defaultOutputDir();
        if (!extname(target)) {
          mkdirSync(target, { recursive: true });
          target = join(target, `${slug(title)}-${new Date().toISOString().slice(0, 10)}.${fmt}`);
        }

        if (fmt === "html") {
          writeFileSync(target, html, "utf8");
        } else {
          const tmpHtml = join(tmpdir(), `mcp-viz-${Date.now()}.html`);
          writeFileSync(tmpHtml, html, "utf8");
          if (fmt === "pdf") htmlToPdf(tmpHtml, target);
          else htmlToPng(tmpHtml, target, width ?? 1400, height ?? 900);
        }
        return jsonResult({ written: target, mode, format: fmt });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
