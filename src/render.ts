import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** Locate a locally installed Edge/Chrome/Chromium for headless rendering. */
export function findBrowser(): string | undefined {
  const fromEnv = process.env.BROWSER_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ]
        : [
            "/usr/bin/microsoft-edge",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/opt/pw-browsers/chromium",
          ];
  return candidates.find((c) => existsSync(c));
}

function runBrowser(args: string[]): void {
  const browser = findBrowser();
  if (!browser) {
    throw new Error(
      "No Edge/Chrome found for rendering. Install Microsoft Edge or Google Chrome, " +
        "set BROWSER_PATH, or use format 'html' instead."
    );
  }
  const res = spawnSync(browser, ["--headless", "--disable-gpu", "--no-sandbox", ...args], {
    timeout: 90_000,
  });
  if (res.error) throw res.error;
}

/** Print an HTML file to PDF. */
export function htmlToPdf(htmlPath: string, pdfPath: string): void {
  runBrowser([`--print-to-pdf=${pdfPath}`, "--no-pdf-header-footer", htmlPath]);
  if (!existsSync(pdfPath)) throw new Error("PDF generation failed (no output file).");
}

/** Screenshot an HTML file to PNG. virtualTimeMs gives JS (e.g. Mermaid) time to render. */
export function htmlToPng(
  htmlPath: string,
  pngPath: string,
  width = 1400,
  height = 900,
  virtualTimeMs = 6000
): void {
  runBrowser([
    `--screenshot=${pngPath}`,
    `--window-size=${width},${height}`,
    "--hide-scrollbars",
    `--virtual-time-budget=${virtualTimeMs}`,
    htmlPath,
  ]);
  if (!existsSync(pngPath)) throw new Error("PNG generation failed (no output file).");
}
