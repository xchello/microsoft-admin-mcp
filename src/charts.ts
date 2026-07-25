/**
 * Inline SVG charts for HTML reports and infographics.
 *
 * Pure string building: no imports, no runtime dependencies, no CDN and no
 * non-deterministic input (no Date, no Math.random), so an identical spec always
 * produces a byte-identical SVG. Everything is inline-styled because the output
 * gets embedded into arbitrary HTML documents where no <style> block or CSS class
 * of ours can be relied upon.
 */

export interface ChartDatum {
  label: string;
  value: number;
  color?: string;
}

export interface ChartSpec {
  type: "donut" | "bar" | "hbar";
  title?: string;
  data: ChartDatum[];
  width?: number;
  height?: number;
  /** Optional unit suffix for value labels, e.g. "devices" */
  unit?: string;
}

/**
 * Eight hues that harmonise with the brand colour #0f6cbd (first entry) and stay
 * distinguishable for the common colour-vision deficiencies: the set is derived
 * from the Okabe-Ito safe palette, with its low-contrast yellow replaced by a
 * violet and a slate so all eight remain legible as fills on white.
 */
export const CHART_PALETTE: string[] = [
  "#0f6cbd", // brand blue
  "#e69f00", // amber
  "#009e73", // teal green
  "#cc79a7", // rose
  "#56b4e9", // sky blue
  "#d55e00", // vermillion
  "#7b52ab", // violet
  "#5b6b79", // slate
];

const FONT = "Segoe UI, Roboto, Helvetica, Arial, sans-serif";
const INK = "#242424";
const MUTED = "#616161";
const NEUTRAL = "#d8dde3"; // all-zero ring and empty bar tracks
const TRACK = "#eef1f4";
const PAD = 12;
const TAU = Math.PI * 2;
/** Tilt used for crowded bar labels (-35 degrees), pre-computed for the geometry. */
const ROT_SIN = Math.sin((35 * Math.PI) / 180);
const ROT_COS = Math.cos((35 * Math.PI) / 180);

/* ------------------------------------------------------------------ helpers */

/** Escape every character that could break out of text content or an attribute. */
function esc(raw: string): string {
  return String(raw)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Coordinate formatter: at most two decimals, and never NaN/Infinity/-0 so a bad
 * datum can never produce an SVG the browser silently refuses to draw.
 */
function n2(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** Clamp any non-finite, negative or missing value to 0. */
function clampValue(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function dim(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(4000, Math.max(120, Math.round(value)));
}

/** Human-readable value: two decimals max, no locale formatting (determinism). */
function fmtValue(value: number): string {
  return n2(clampValue(value));
}

/** Rough advance width for the sans-serif stack; good enough for fit decisions. */
function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.55;
}

/** Escape and, if needed, shorten a data string so it fits `maxPx`. */
function escTrunc(raw: string, maxPx: number, fontSize: number): string {
  const maxChars = Math.floor(maxPx / (fontSize * 0.55));
  if (maxChars <= 1) return raw.length > 0 ? "&#8230;" : "";
  if (raw.length <= maxChars) return esc(raw);
  // Numeric entity instead of a literal ellipsis: it survives a host document
  // that was served without a UTF-8 charset declaration.
  return esc(raw.slice(0, maxChars - 1)) + "&#8230;";
}

function colorAt(datum: ChartDatum, index: number): string {
  const raw = typeof datum.color === "string" && datum.color.length > 0
    ? datum.color
    : CHART_PALETTE[index % CHART_PALETTE.length];
  return esc(raw);
}

function unitSuffix(spec: ChartSpec): string {
  return typeof spec.unit === "string" && spec.unit.trim().length > 0 ? spec.unit.trim() : "";
}

function defaultTitle(type: ChartSpec["type"]): string {
  if (type === "donut") return "Ringdiagram";
  if (type === "hbar") return "Horizontaal staafdiagram";
  return "Staafdiagram";
}

/** Screen-reader summary; only emitted when the caller supplied a title. */
function describe(spec: ChartSpec, values: number[]): string {
  const unit = unitSuffix(spec);
  const parts = spec.data.slice(0, 24).map((datum, i) => {
    const value = fmtValue(values[i]);
    return `${datum.label}: ${value}${unit ? " " + unit : ""}`;
  });
  if (spec.data.length > 24) parts.push(`+${spec.data.length - 24} meer`);
  return parts.join(", ");
}

function svgRoot(width: number, height: number, spec: ChartSpec, values: number[], body: string): string {
  const explicit = typeof spec.title === "string" && spec.title.trim().length > 0;
  const label = explicit && spec.title ? spec.title : defaultTitle(spec.type);
  const head =
    `<title>${esc(label)}</title>` +
    (explicit ? `<desc>${esc(describe(spec, values))}</desc>` : "");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" width="${n2(width)}" height="${n2(height)}" ` +
    `viewBox="0 0 ${n2(width)} ${n2(height)}" font-family="${FONT}">${head}${body}</svg>`
  );
}

function titleBlock(spec: ChartSpec, width: number): { markup: string; top: number } {
  const explicit = typeof spec.title === "string" && spec.title.trim().length > 0;
  if (!explicit || !spec.title) return { markup: "", top: 8 };
  const markup =
    `<text x="${n2(PAD)}" y="16" font-size="13" font-weight="600" fill="${INK}">` +
    `${escTrunc(spec.title, width - 2 * PAD, 13)}</text>`;
  return { markup, top: 26 };
}

function emptyChart(spec: ChartSpec, width: number): string {
  const height = 76;
  const body =
    `<rect x="0.5" y="0.5" width="${n2(width - 1)}" height="${n2(height - 1)}" rx="6" ` +
    `fill="#fafbfc" stroke="${NEUTRAL}"/>` +
    `<text x="${n2(width / 2)}" y="${n2(height / 2 + 4)}" text-anchor="middle" font-size="12" ` +
    `fill="${MUTED}">geen data</text>`;
  return svgRoot(width, height, spec, [], body);
}

/* -------------------------------------------------------------------- donut */

/** Point on a circle with 0 rad at 12 o'clock, angles growing clockwise. */
function polar(cx: number, cy: number, r: number, angle: number): { x: number; y: number } {
  return { x: cx + r * Math.sin(angle), y: cy - r * Math.cos(angle) };
}

/**
 * Ring segment as a closed path: outer arc clockwise (sweep 1), then straight in
 * to the inner radius and back counter-clockwise (sweep 0). `large-arc` must flip
 * past a half turn, otherwise SVG draws the short way round.
 */
function ringSlicePath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  from: number,
  to: number
): string {
  const large = to - from > Math.PI ? 1 : 0;
  const o0 = polar(cx, cy, rOuter, from);
  const o1 = polar(cx, cy, rOuter, to);
  const i1 = polar(cx, cy, rInner, to);
  const i0 = polar(cx, cy, rInner, from);
  return (
    `M${n2(o0.x)} ${n2(o0.y)}` +
    `A${n2(rOuter)} ${n2(rOuter)} 0 ${large} 1 ${n2(o1.x)} ${n2(o1.y)}` +
    `L${n2(i1.x)} ${n2(i1.y)}` +
    `A${n2(rInner)} ${n2(rInner)} 0 ${large} 0 ${n2(i0.x)} ${n2(i0.y)}Z`
  );
}

/**
 * A 360 degree slice cannot be an arc: start and end point coincide, so the path
 * collapses and nothing is painted. Draw the full ring as a stroked circle on the
 * mid radius instead. Same shape is used for the all-zero (neutral) ring.
 */
function fullRing(cx: number, cy: number, rOuter: number, rInner: number, fill: string): string {
  const mid = (rOuter + rInner) / 2;
  const band = rOuter - rInner;
  return (
    `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(mid)}" fill="none" ` +
    `stroke="${fill}" stroke-width="${n2(band)}"/>`
  );
}

function renderDonut(spec: ChartSpec, width: number, height: number, values: number[]): string {
  const { markup: titleMarkup, top } = titleBlock(spec, width);
  const unit = unitSuffix(spec);
  const total = values.reduce((sum, v) => sum + v, 0);

  const areaHeight = Math.max(60, height - top - PAD);
  const radius = Math.max(22, Math.min(areaHeight / 2 - 2, (width * 0.42) / 2));
  const inner = radius * 0.6;
  const cx = PAD + radius;
  const cy = top + areaHeight / 2;

  let slices = "";
  if (total <= 0) {
    slices = fullRing(cx, cy, radius, inner, NEUTRAL);
  } else {
    let angle = 0;
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (value <= 0) continue; // a zero slice would be an invisible degenerate path
      const sweep = (value / total) * TAU;
      const fill = colorAt(spec.data[i], i);
      if (sweep >= TAU - 1e-9) {
        slices += fullRing(cx, cy, radius, inner, fill);
      } else {
        slices +=
          `<path d="${ringSlicePath(cx, cy, radius, inner, angle, angle + sweep)}" fill="${fill}" ` +
          `stroke="#ffffff" stroke-width="1"/>`;
      }
      angle += sweep;
    }
  }

  // Centre readout: total, with the unit on a second line when there is one.
  const totalText = fmtValue(total);
  const totalSize = totalText.length > 6 ? 13 : totalText.length > 4 ? 16 : 19;
  const centre = unit
    ? `<text x="${n2(cx)}" y="${n2(cy)}" text-anchor="middle" font-size="${totalSize}" ` +
      `font-weight="700" fill="${INK}">${esc(totalText)}</text>` +
      `<text x="${n2(cx)}" y="${n2(cy + 13)}" text-anchor="middle" font-size="9" fill="${MUTED}">` +
      `${escTrunc(unit, inner * 1.9, 9)}</text>`
    : `<text x="${n2(cx)}" y="${n2(cy + totalSize / 3)}" text-anchor="middle" ` +
      `font-size="${totalSize}" font-weight="700" fill="${INK}">${esc(totalText)}</text>`;

  // Legend on the right: swatch + label, with "value (xx%)" right-aligned so the
  // two columns cannot run into each other.
  const legendX = cx + radius + 14;
  const legendWidth = Math.max(40, width - legendX - PAD);
  const count = spec.data.length;
  const rowHeight = Math.max(10, Math.min(16, areaHeight / Math.max(1, count)));
  const maxRows = Math.max(1, Math.floor(areaHeight / rowHeight));
  const shown = count > maxRows ? Math.max(1, maxRows - 1) : count;
  const fontSize = Math.max(8, Math.min(11, rowHeight - 4));
  const blockHeight = (count > shown ? shown + 1 : shown) * rowHeight;
  const firstY = Math.max(top + 6, cy - blockHeight / 2) + rowHeight / 2;

  let legend = "";
  for (let i = 0; i < shown; i += 1) {
    const datum = spec.data[i];
    const value = values[i];
    const percent = total > 0 ? Math.round((value / total) * 100) : 0;
    const valueText = `${fmtValue(value)} (${percent}%)`;
    const y = firstY + i * rowHeight;
    const swatch = fontSize * 0.8;
    const labelX = legendX + swatch + 6;
    const labelRoom = Math.max(12, legendWidth - swatch - 6 - textWidth(valueText, fontSize) - 6);
    legend +=
      `<rect x="${n2(legendX)}" y="${n2(y - swatch)}" width="${n2(swatch)}" height="${n2(swatch)}" ` +
      `rx="2" fill="${total > 0 && value > 0 ? colorAt(datum, i) : NEUTRAL}"/>` +
      `<text x="${n2(labelX)}" y="${n2(y)}" font-size="${n2(fontSize)}" fill="${INK}">` +
      `${escTrunc(datum.label, labelRoom, fontSize)}</text>` +
      `<text x="${n2(legendX + legendWidth)}" y="${n2(y)}" text-anchor="end" ` +
      `font-size="${n2(fontSize)}" fill="${MUTED}">${esc(valueText)}</text>`;
  }
  if (count > shown) {
    legend +=
      `<text x="${n2(legendX)}" y="${n2(firstY + shown * rowHeight)}" font-size="${n2(fontSize)}" ` +
      `fill="${MUTED}">+${count - shown} meer</text>`;
  }

  return svgRoot(width, height, spec, values, titleMarkup + slices + centre + legend);
}

/* ---------------------------------------------------------------------- bar */

function renderBar(spec: ChartSpec, width: number, height: number, values: number[]): string {
  const { markup: titleMarkup, top } = titleBlock(spec, width);
  const unit = unitSuffix(spec);
  const count = values.length;
  const crowded = count > 6; // tilt labels instead of letting them collide

  const labelBand = crowded ? 46 : 18;
  const plotTop = top + 14; // headroom for the value labels above the bars
  const baseline = Math.max(plotTop + 10, height - PAD - labelBand);
  const plotHeight = baseline - plotTop;

  // Tilted labels lean down-left out of their slot, so the plot needs extra room
  // on the left for the first bar's label.
  const plotLeft = crowded ? PAD + 22 : PAD;
  const slot = (width - PAD - plotLeft) / count;
  const barWidth = Math.max(2, Math.min(46, slot * 0.62));
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  const scale = max > 0 ? plotHeight / max : 0;

  const valueSize = crowded ? 9 : 10;
  const labelSize = crowded ? 9 : 10;

  let body =
    `<line x1="${n2(PAD)}" y1="${n2(baseline)}" x2="${n2(width - PAD)}" y2="${n2(baseline)}" ` +
    `stroke="${NEUTRAL}" stroke-width="1"/>`;

  for (let i = 0; i < count; i += 1) {
    const value = values[i];
    const datum = spec.data[i];
    const centreX = plotLeft + slot * (i + 0.5);
    const barX = centreX - barWidth / 2;
    // Give any positive value at least a sliver of height so it stays visible.
    const barHeight = value > 0 ? Math.max(1.5, value * scale) : 0;
    const barY = baseline - barHeight;

    if (barHeight > 0) {
      body +=
        `<rect x="${n2(barX)}" y="${n2(barY)}" width="${n2(barWidth)}" height="${n2(barHeight)}" ` +
        `rx="2" fill="${colorAt(datum, i)}"/>`;
    }

    // Drop the unit when the combined label would not fit the bar's slot.
    const withUnit = unit ? `${fmtValue(value)} ${unit}` : fmtValue(value);
    const valueText = textWidth(withUnit, valueSize) <= slot ? withUnit : fmtValue(value);
    body +=
      `<text x="${n2(centreX)}" y="${n2(barY - 4)}" text-anchor="middle" font-size="${valueSize}" ` +
      `fill="${MUTED}">${esc(valueText)}</text>`;

    if (crowded) {
      const anchorY = baseline + 12;
      // A label rotated by -35 degrees ends at the anchor and runs down-left, so its
      // length is bounded both by the label band's height and by the space left of
      // the bar. Clamping to both keeps every label fully inside the viewBox.
      const room = Math.min(
        (labelBand - 12) / ROT_SIN,
        (centreX - 2) / ROT_COS
      );
      body +=
        `<text x="${n2(centreX)}" y="${n2(anchorY)}" text-anchor="end" font-size="${labelSize}" ` +
        `fill="${INK}" transform="rotate(-35 ${n2(centreX)} ${n2(anchorY)})">` +
        `${escTrunc(datum.label, room, labelSize)}</text>`;
    } else {
      body +=
        `<text x="${n2(centreX)}" y="${n2(baseline + 13)}" text-anchor="middle" ` +
        `font-size="${labelSize}" fill="${INK}">${escTrunc(datum.label, slot - 2, labelSize)}</text>`;
    }
  }

  return svgRoot(width, height, spec, values, titleMarkup + body);
}

/* --------------------------------------------------------------------- hbar */

function renderHbar(spec: ChartSpec, width: number, height: number, values: number[]): string {
  const { markup: titleMarkup, top } = titleBlock(spec, width);
  const unit = unitSuffix(spec);
  const count = values.length;

  const areaHeight = Math.max(20, height - top - PAD);
  const rowHeight = areaHeight / count;
  const barHeight = Math.max(2, Math.min(22, rowHeight * 0.6));
  const fontSize = Math.max(8, Math.min(11, rowHeight * 0.5));

  const labelWidth = Math.min(Math.max(60, width * 0.34), width * 0.45);
  const valueTexts = values.map((v) => (unit ? `${fmtValue(v)} ${unit}` : fmtValue(v)));
  const valueRoom = valueTexts.reduce((m, t) => Math.max(m, textWidth(t, fontSize)), 0);
  const barX = labelWidth;
  const barRoom = Math.max(10, width - PAD - barX - valueRoom - 6);

  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  const scale = max > 0 ? barRoom / max : 0;

  let body = "";
  for (let i = 0; i < count; i += 1) {
    const value = values[i];
    const datum = spec.data[i];
    const centreY = top + rowHeight * (i + 0.5);
    const y = centreY - barHeight / 2;
    const length = value > 0 ? Math.max(1.5, value * scale) : 0;

    body +=
      `<rect x="${n2(barX)}" y="${n2(y)}" width="${n2(barRoom)}" height="${n2(barHeight)}" rx="2" ` +
      `fill="${TRACK}"/>`;
    if (length > 0) {
      body +=
        `<rect x="${n2(barX)}" y="${n2(y)}" width="${n2(length)}" height="${n2(barHeight)}" rx="2" ` +
        `fill="${colorAt(datum, i)}"/>`;
    }
    body +=
      `<text x="${n2(barX - 8)}" y="${n2(centreY + fontSize * 0.35)}" text-anchor="end" ` +
      `font-size="${n2(fontSize)}" fill="${INK}">` +
      `${escTrunc(datum.label, labelWidth - PAD - 8, fontSize)}</text>` +
      `<text x="${n2(barX + length + 5)}" y="${n2(centreY + fontSize * 0.35)}" ` +
      `font-size="${n2(fontSize)}" fill="${MUTED}">${esc(valueTexts[i])}</text>`;
  }

  return svgRoot(width, height, spec, values, titleMarkup + body);
}

/* ------------------------------------------------------------------ exports */

/** Render one chart spec as a standalone, self-contained SVG string. */
export function renderChartSvg(spec: ChartSpec): string {
  const width = dim(spec.width, 380);
  const height = dim(spec.height, 260);
  const data: ChartDatum[] = Array.isArray(spec.data) ? spec.data : [];
  if (data.length === 0) return emptyChart({ ...spec, data }, width);

  const safeSpec: ChartSpec = { ...spec, data };
  const values = data.map((datum) => clampValue(datum.value));
  if (spec.type === "bar") return renderBar(safeSpec, width, height, values);
  if (spec.type === "hbar") return renderHbar(safeSpec, width, height, values);
  return renderDonut(safeSpec, width, height, values);
}

/**
 * Lay several charts out side by side, wrapping on narrow pages. Inline flex only:
 * no <style> tag and no classes, so the row behaves the same in any host document.
 */
export function renderChartsRow(specs: ChartSpec[]): string {
  const list: ChartSpec[] = Array.isArray(specs) ? specs : [];
  const items = list
    .map((spec) => `<div style="flex:0 1 auto;max-width:100%;">${renderChartSvg(spec)}</div>`)
    .join("");
  return (
    `<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;` +
    `justify-content:flex-start;width:100%;">${items}</div>`
  );
}
