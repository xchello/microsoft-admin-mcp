#!/usr/bin/env node
/**
 * Automated smoke test suite for microsoft-admin-mcp.
 *
 * Plain Node, no test framework, no extra dependencies.
 *
 * SAFETY: every server instance runs against a FRESH temporary directory. HOME and
 * all state-path environment variables (ENVIRONMENTS_FILE, TENANT_KNOWLEDGE_FILE,
 * AUDIT_LOG_FILE, AUTH_RECORD_FILE, KNOWLEDGE_CACHE_DIR) point inside it, so the
 * real user profile is never read or written. The whole tree is removed on exit.
 *
 * No Microsoft credentials exist in CI, so AUTH_MODE=app is forced without a secret:
 * every authentication attempt then fails instantly and locally instead of opening a
 * browser or polling a device-code endpoint. Tests assert graceful structured
 * failures, never hangs.
 *
 * Environment flags:
 *   SMOKE_NETWORK=1  also run the tests that need internet access.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const DIST_INDEX = join(REPO, "dist", "index.js");
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

const NETWORK = process.env.SMOKE_NETWORK === "1";
const SUITE_BUDGET_MS = 170_000;

// ---------------------------------------------------------------- reporting

const results = [];

function record(status, name, reason) {
  results.push({ status, name, reason });
  if (status === "pass") console.log(`PASS ${name}`);
  else if (status === "fail") console.log(`FAIL ${name} - ${reason}`);
  else console.log(`SKIP ${name} - ${reason}`);
}

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").slice(0, 300);
}

class SkipSignal extends Error {}

function skipNow(reason) {
  throw new SkipSignal(reason);
}

async function test(name, fn) {
  try {
    await fn();
    record("pass", name);
  } catch (err) {
    if (err instanceof SkipSignal) record("skip", name, oneLine(err.message));
    else record("fail", name, oneLine(err && err.message ? err.message : err));
  }
}

// ---------------------------------------------------------------- assertions

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack, needle, what) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${what}: ${JSON.stringify(needle)} not found in ${oneLine(haystack)}`);
  }
}

function assertNotIncludes(haystack, needle, what) {
  if (String(haystack).includes(needle)) {
    throw new Error(`${what}: ${JSON.stringify(needle)} unexpectedly present`);
  }
}

function assertStartsWith(value, prefix, what) {
  if (!String(value).startsWith(prefix)) {
    throw new Error(`${what}: expected prefix ${JSON.stringify(prefix)}, got ${oneLine(value)}`);
  }
}

function assertNonEmptyFile(path, what) {
  assert(existsSync(path), `${what}: file does not exist (${path})`);
  const size = statSync(path).size;
  assert(size > 0, `${what}: file is empty (${path})`);
  return size;
}

// ---------------------------------------------------------------- isolation

const TMP_ROOT = realpathSync(tmpdir());
const ROOT = realpathSync(mkdtempSync(join(TMP_ROOT, "mcp-smoke-")));

function caseDir(label) {
  const dir = join(ROOT, label);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Every path the server may write to is redirected into `dir`. */
function isolatedEnv(dir, extra = {}) {
  const base = { ...process.env };
  // Anything that could pull in the real user's tenant or relax safety.
  for (const key of [
    "TENANT_ID",
    "CLIENT_ID",
    "CLIENT_SECRET",
    "CERTIFICATE_PATH",
    "READ_ONLY",
    "GRAPH_VERSION",
    "POWERSHELL_ENABLED",
  ]) {
    delete base[key];
  }
  return {
    ...base,
    HOME: dir,
    USERPROFILE: dir,
    ENVIRONMENTS_FILE: join(dir, "environments.json"),
    TENANT_KNOWLEDGE_FILE: join(dir, "tenant-knowledge.json"),
    AUDIT_LOG_FILE: join(dir, "audit-log.jsonl"),
    AUTH_RECORD_FILE: join(dir, "auth-records.json"),
    KNOWLEDGE_CACHE_DIR: join(dir, "knowledge-cache"),
    // No credentials in CI: "app" without a secret fails instantly and locally.
    AUTH_MODE: "app",
    DISABLE_TOKEN_PERSISTENCE: "1",
    REQUEST_TIMEOUT_MS: "8000",
    ...extra,
  };
}

const liveServers = new Set();

function cleanup() {
  for (const server of liveServers) {
    try {
      server.child?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  liveServers.clear();
  // Belt and braces: only ever delete our own mkdtemp directory.
  if (ROOT.startsWith(TMP_ROOT) && /mcp-smoke-[^/\\]+$/.test(ROOT)) {
    try {
      rmSync(ROOT, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

process.on("exit", cleanup);

// ---------------------------------------------------------------- MCP client

class Server {
  constructor(label, dir, env) {
    this.label = label;
    this.dir = dir;
    this.env = env;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.exited = false;
  }

  _launch() {
    this.child = spawn(process.execPath, [DIST_INDEX], {
      cwd: REPO,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    liveServers.add(this);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    const die = (reason) => {
      this.exited = true;
      const err = new Error(`server "${this.label}" ${reason}; stderr: ${oneLine(this.stderr)}`);
      for (const entry of this.pending.values()) entry.reject(err);
      this.pending.clear();
    };
    this.child.on("exit", (code, signal) => die(`exited (code ${code}, signal ${signal})`));
    this.child.on("error", (err) => die(`failed to spawn: ${err.message}`));
    // A broken pipe after we killed the child must not crash the suite.
    this.child.stdin.on("error", () => {});
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // not protocol traffic
      }
      const entry = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (!entry) continue;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  request(method, params, timeoutMs = 15_000) {
    if (this.exited) return Promise.reject(new Error(`server "${this.label}" is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`);
    });
  }

  notify(method, params) {
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} })}\n`);
    } catch {
      /* server already gone */
    }
  }

  call(name, args, timeoutMs = 15_000) {
    return this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
  }

  async stop() {
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    if (!this.exited) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            this.child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve();
        }, 1500);
        this.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    try {
      this.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    liveServers.delete(this);
  }
}

async function startServer(label, { extraEnv = {}, prepare } = {}) {
  const dir = caseDir(label);
  const env = isolatedEnv(dir, extraEnv);
  if (prepare) prepare(dir, env);
  const server = new Server(label, dir, env);
  server._launch();
  server.initResult = await server.request(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "microsoft-admin-mcp-smoke", version: "1.0.0" },
    },
    20_000
  );
  server.notify("notifications/initialized");
  return server;
}

/** Runs `fn` with a fresh server and always shuts it down. */
async function withServer(label, options, fn) {
  let server;
  try {
    server = await startServer(label, options);
  } catch (err) {
    record("fail", `group ${label}`, `server failed to start: ${oneLine(err.message)}`);
    return;
  }
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------- result shape

function contents(result) {
  assert(result && Array.isArray(result.content), "tool result has no content array");
  return result.content.map((item) => String(item?.text ?? ""));
}

function header(result) {
  const items = contents(result);
  assert(items.length >= 1, "tool result has no content items");
  return items[0];
}

/** content[0] is the context line, content[1] is the JSON payload. */
function bodyText(result) {
  const items = contents(result);
  assertEq(items.length >= 2, true, `expected at least 2 content items, got ${items.length}`);
  return items[1];
}

function payload(result) {
  const text = bodyText(result);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`content[1] is not JSON: ${oneLine(text)}`);
  }
}

const HEADER_PREFIX = "[microsoft-admin-mcp]";

const APP_ENV = (name, tenantId, extra = {}) => ({
  name,
  tenantId,
  // "app" without a secret: authentication fails instantly and locally.
  authMode: "app",
  login: false,
  ...extra,
});

// ================================================================ test groups

async function groupCore() {
  await withServer("core", {}, async (s) => {
    await test("handshake: serverInfo name and version match package.json", async () => {
      const init = s.initResult;
      assertEq(init?.serverInfo?.name, "microsoft-admin-mcp", "serverInfo.name");
      assertEq(init?.serverInfo?.version, PKG.version, "serverInfo.version");
      assert(typeof init?.protocolVersion === "string", "no protocolVersion in initialize result");
    });

    const required = [
      "environment_list",
      "environment_use",
      "environment_add",
      "environment_remove",
      "environment_login",
      "auth_status",
      "graph_request",
      "azure_request",
      "entra_list_users",
      "intune_list_devices",
      "intune_device_action",
      "intune_compliance_overview",
      "intune_list_apps",
      "intune_app_assignments",
      "intune_device_compliance_detail",
      "intune_list_policies",
      "powershell_run",
      "psgallery_module_info",
      "mslearn_search",
      "mslearn_fetch",
      "export_report",
      "export_visualization",
      "intune_troubleshooting_guide",
      "tenant_note_add",
      "tenant_notes",
      "tenant_note_remove",
      "audit_log",
      "server_diagnostics",
      "multi_tenant_query",
    ];

    await test("tools/list: all required tools present with a non-empty description", async () => {
      const listed = await s.request("tools/list", {});
      const tools = listed?.tools;
      assert(Array.isArray(tools), "tools/list returned no tools array");
      console.log(`  tools/list total tool count: ${tools.length}`);
      const byName = new Map(tools.map((t) => [t.name, t]));
      const missing = required.filter((name) => !byName.has(name));
      assertEq(missing.length, 0, `missing tools: ${missing.join(", ")}`);
      const undescribed = tools
        .filter((t) => typeof t.description !== "string" || t.description.trim().length === 0)
        .map((t) => t.name);
      assertEq(undescribed.length, 0, `tools without a description: ${undescribed.join(", ")}`);
      assert(tools.length >= required.length, `expected >= ${required.length} tools, got ${tools.length}`);
    });

    await test("prompts/list: contains generate-powershell", async () => {
      const listed = await s.request("prompts/list", {});
      const prompts = listed?.prompts;
      assert(Array.isArray(prompts), "prompts/list returned no prompts array");
      assert(
        prompts.some((p) => p.name === "generate-powershell"),
        `generate-powershell not in [${prompts.map((p) => p.name).join(", ")}]`
      );
    });

    // A tenant-scoped environment that can never authenticate, so tenant-scoped
    // calls fail instantly instead of prompting for a sign-in.
    await test("context header: present on several different tools", async () => {
      const added = await s.call("environment_add", APP_ENV("smoke", "smoke.onmicrosoft.com"));
      assertStartsWith(header(added), HEADER_PREFIX, "environment_add header");
      assertEq(payload(added).added, "smoke", "environment_add payload.added");

      for (const [name, args] of [
        ["environment_list", {}],
        ["server_diagnostics", {}],
        ["auth_status", {}],
        ["tenant_notes", {}],
        ["audit_log", { limit: 5 }],
      ]) {
        const res = await s.call(name, args);
        assertStartsWith(header(res), HEADER_PREFIX, `${name} content[0]`);
        assertEq(contents(res).length >= 2, true, `${name} should have a payload item too`);
      }
    });

    await test("context header: tenant read is LEESACTIE, non-GET graph_request is SCHRIJFACTIE", async () => {
      const read = await s.call("graph_request", { path: "/users", method: "GET", maxItems: 1 });
      const readHeader = header(read);
      assertStartsWith(readHeader, HEADER_PREFIX, "graph_request GET header");
      assertIncludes(readHeader, 'omgeving "smoke"', "graph_request GET header scope");
      assertIncludes(readHeader, "LEESACTIE", "graph_request GET header action");
      assertNotIncludes(readHeader, "SCHRIJFACTIE", "graph_request GET header action");

      const write = await s.call("graph_request", {
        path: "/users/00000000-0000-0000-0000-000000000000",
        method: "DELETE",
      });
      const writeHeader = header(write);
      assertStartsWith(writeHeader, HEADER_PREFIX, "graph_request DELETE header");
      assertIncludes(writeHeader, "SCHRIJFACTIE", "graph_request DELETE header action");
      assertIncludes(writeHeader, "DELETE", "graph_request DELETE header method");
      assertStartsWith(bodyText(write), "CONFIRMATION REQUIRED", "graph_request DELETE body");

      // Local read tools are scoped "lokaal" and always LEESACTIE.
      const local = await s.call("environment_list", {});
      assertIncludes(header(local), "LEESACTIE", "environment_list header action");
    });

    // ------------------------------------------------ reporting
    const reportDir = join(s.dir, "reports");
    mkdirSync(reportDir, { recursive: true });
    const rows = [
      { device: "PC-1", os: "Windows", compliance: "compliant" },
      { device: "PC-2", os: "Windows", compliance: "noncompliant" },
      { device: "MAC-1", os: "macOS", compliance: "compliant" },
    ];
    const columns = [
      { key: "device", label: "Apparaat" },
      { key: "os", label: "Besturingssysteem" },
      { key: "compliance", label: "Compliance" },
    ];

    for (const format of ["csv", "xlsx"]) {
      await test(`export_report: ${format} written to an explicit path`, async () => {
        const target = join(reportDir, `smoke.${format}`);
        const res = await s.call(
          "export_report",
          { title: "Smoke rapport", format, rows, columns, outputPath: target },
          30_000
        );
        assert(res.isError !== true, `export_report ${format} failed: ${oneLine(bodyText(res))}`);
        const data = payload(res);
        assertEq(data.written, target, `export_report ${format} written path`);
        assertEq(data.rows, rows.length, `export_report ${format} row count`);
        assertNonEmptyFile(target, `export_report ${format}`);
      });
    }

    await test("export_report: html with autoChart embeds an inline SVG", async () => {
      const target = join(reportDir, "smoke-chart.html");
      const res = await s.call(
        "export_report",
        {
          title: "Smoke rapport met grafiek",
          format: "html",
          rows,
          columns,
          outputPath: target,
          autoChart: { column: "compliance", type: "donut" },
        },
        30_000
      );
      assert(res.isError !== true, `export_report html failed: ${oneLine(bodyText(res))}`);
      const data = payload(res);
      assertEq(data.charts, 1, "export_report html chart count");
      assertNonEmptyFile(target, "export_report html");
      const html = readFileSync(target, "utf8");
      assertIncludes(html, "<svg", "export_report html output");
      assertNotIncludes(html, "NaN", "export_report html output");
    });

    await test("export_report: autoChart on an unknown column warns instead of failing", async () => {
      const target = join(reportDir, "smoke-warn.html");
      const res = await s.call(
        "export_report",
        {
          title: "Smoke rapport zonder kolom",
          format: "html",
          rows,
          columns,
          outputPath: target,
          autoChart: { column: "bestaatniet" },
        },
        30_000
      );
      assert(res.isError !== true, `export_report should not error: ${oneLine(bodyText(res))}`);
      const data = payload(res);
      assert(Array.isArray(data.warnings) && data.warnings.length === 1, `expected 1 warning, got ${JSON.stringify(data.warnings)}`);
      assertIncludes(data.warnings[0], "bestaatniet", "warning text");
      assertEq(data.charts, 0, "chart count for unknown column");
      assertNonEmptyFile(target, "export_report html (warning case)");
    });

    await test("export_visualization: html infographic with 1 panel and 1 chart contains an SVG", async () => {
      const target = join(reportDir, "smoke-viz.html");
      const res = await s.call(
        "export_visualization",
        {
          title: "Smoke visualisatie",
          mode: "infographic",
          format: "html",
          panels: [
            {
              title: "Panel 1",
              layout: "grid",
              items: [{ icon: "\u{1F527}", label: "Enrollment", sublabel: "Autopilot" }],
            },
          ],
          charts: [
            {
              type: "donut",
              title: "Compliance",
              data: [
                { label: "compliant", value: 2 },
                { label: "noncompliant", value: 1 },
              ],
            },
          ],
          outputPath: target,
        },
        30_000
      );
      assert(res.isError !== true, `export_visualization failed: ${oneLine(bodyText(res))}`);
      assertEq(payload(res).charts, 1, "export_visualization chart count");
      assertNonEmptyFile(target, "export_visualization html");
      const html = readFileSync(target, "utf8");
      assertIncludes(html, "<svg", "export_visualization html output");
      assertIncludes(html, "Panel 1", "export_visualization html output");
    });

    const browser = await findBrowserPath();

    await test("export_report: pdf rendered with a headless browser", async () => {
      if (!browser) skipNow("no Edge/Chrome/Chromium available on this machine");
      const target = join(reportDir, "smoke.pdf");
      const res = await s.call(
        "export_report",
        { title: "Smoke pdf", format: "pdf", rows, columns, outputPath: target },
        60_000
      );
      assert(res.isError !== true, `export_report pdf failed: ${oneLine(bodyText(res))}`);
      assertNonEmptyFile(target, "export_report pdf");
      assertStartsWith(readFileSync(target).subarray(0, 4).toString("latin1"), "%PDF", "pdf magic bytes");
    });

    await test("export_visualization: png rendered with a headless browser", async () => {
      if (!browser) skipNow("no Edge/Chrome/Chromium available on this machine");
      const target = join(reportDir, "smoke.png");
      const res = await s.call(
        "export_visualization",
        {
          title: "Smoke png",
          mode: "infographic",
          format: "png",
          width: 800,
          height: 600,
          panels: [{ title: "Panel", items: [{ label: "Card" }] }],
          outputPath: target,
        },
        60_000
      );
      assert(res.isError !== true, `export_visualization png failed: ${oneLine(bodyText(res))}`);
      assertNonEmptyFile(target, "export_visualization png");
      const magic = readFileSync(target).subarray(1, 4).toString("latin1");
      assertEq(magic, "PNG", "png magic bytes");
    });

    // ------------------------------------------------ diagnostics / isolation
    await test("server_diagnostics: all storage paths live inside the isolated temp dir", async () => {
      const res = await s.call("server_diagnostics", {});
      assert(res.isError !== true, `server_diagnostics failed: ${oneLine(bodyText(res))}`);
      const data = payload(res);
      const storage = data.storage ?? {};
      for (const key of ["environments", "tenantKnowledge", "auditLog"]) {
        const value = storage[key];
        assert(typeof value === "string" && value.length > 0, `storage.${key} missing`);
        assertStartsWith(value, s.dir, `storage.${key} must be inside the temp dir`);
      }
      assert(data.capabilities && typeof data.capabilities.nodeVersion === "string", "capabilities missing");
    });

    // ------------------------------------------------ network-only tests
    await test("psgallery_module_info: latest module version (network)", async () => {
      if (!NETWORK) skipNow("set SMOKE_NETWORK=1 to run tests that need internet");
      const res = await s.call("psgallery_module_info", { moduleName: "Microsoft.Graph" }, 30_000);
      assert(res.isError !== true, `psgallery_module_info failed: ${oneLine(bodyText(res))}`);
      const data = payload(res);
      assertEq(data.found, true, "psgallery_module_info found");
      assert(/^\d+\.\d+/.test(String(data.latestVersion)), `unexpected version ${data.latestVersion}`);
    });

    await test("mslearn_search: returns documentation hits (network)", async () => {
      if (!NETWORK) skipNow("set SMOKE_NETWORK=1 to run tests that need internet");
      const res = await s.call(
        "mslearn_search",
        { query: "Intune managedDevices Graph API", top: 3 },
        30_000
      );
      assert(res.isError !== true, `mslearn_search failed: ${oneLine(bodyText(res))}`);
      const data = payload(res);
      assert(Array.isArray(data.results) && data.results.length > 0, "mslearn_search returned no results");
    });

    await test("intune_troubleshooting_guide: refresh caches into the isolated dir (network)", async () => {
      if (!NETWORK) skipNow("set SMOKE_NETWORK=1 to run tests that need internet");
      const res = await s.call("intune_troubleshooting_guide", { item: "method", refresh: true }, 60_000);
      assert(res.isError !== true, `intune_troubleshooting_guide failed: ${oneLine(bodyText(res))}`);
      const text = bodyText(res);
      assertIncludes(text, "[verversing:", "refresh note");
      assertIncludes(text, s.dir, "cache dir must be inside the temp dir");
      assert(text.length > 500, "guide content looks empty");
    });
  });
}

async function groupEnvironmentsAndAudit() {
  await withServer("env", {}, async (s) => {
    const envFile = s.env.ENVIRONMENTS_FILE;
    const auditFile = s.env.AUDIT_LOG_FILE;

    await test("environment lifecycle: add with login:false persists to the isolated file", async () => {
      const res = await s.call("environment_add", APP_ENV("klant-a", "a.onmicrosoft.com", { description: "Klant A" }));
      assert(res.isError !== true, `environment_add failed: ${oneLine(bodyText(res))}`);
      const data = payload(res);
      assertEq(data.added, "klant-a", "added");
      assertEq(data.storedIn, envFile, "storedIn must be the isolated ENVIRONMENTS_FILE");
      assertEq(data.signedInAs, "login skipped (login:false)", "signedInAs");
      assert(existsSync(envFile), "environments file was not created");
      const stored = JSON.parse(readFileSync(envFile, "utf8"));
      assert(
        stored.some((e) => e.name === "klant-a" && e.tenantId === "a.onmicrosoft.com"),
        `klant-a not persisted: ${oneLine(JSON.stringify(stored))}`
      );

      const second = await s.call("environment_add", APP_ENV("klant-b", "b.onmicrosoft.com"));
      assert(second.isError !== true, `second environment_add failed: ${oneLine(bodyText(second))}`);
    });

    await test("environment lifecycle: list shows both environments and the isolated store", async () => {
      const res = await s.call("environment_list", {});
      const data = payload(res);
      assertEq(data.storedIn, envFile, "environment_list storedIn");
      const names = (data.environments ?? []).map((e) => e.name);
      for (const name of ["klant-a", "klant-b"]) {
        assert(names.includes(name), `${name} missing from [${names.join(", ")}]`);
      }
    });

    await test("environment lifecycle: use switches the active environment", async () => {
      const res = await s.call("environment_use", { name: "klant-a" });
      assert(res.isError !== true, `environment_use failed: ${oneLine(bodyText(res))}`);
      assertEq(payload(res).activeEnvironment, "klant-a", "activeEnvironment");
      const listed = payload(await s.call("environment_list", {}));
      const active = (listed.environments ?? []).filter((e) => e.active).map((e) => e.name);
      assertEq(active.join(","), "klant-a", "exactly klant-a should be active");
    });

    await test("environment lifecycle: remove without confirm requires confirmation and changes nothing", async () => {
      const before = readFileSync(envFile, "utf8");
      const res = await s.call("environment_remove", { name: "klant-b" });
      assertStartsWith(bodyText(res), "CONFIRMATION REQUIRED", "environment_remove without confirm");
      assertEq(readFileSync(envFile, "utf8"), before, "environments file must be unchanged");
    });

    await test("environment lifecycle: remove with confirm:true removes the environment", async () => {
      const res = await s.call("environment_remove", { name: "klant-b", confirm: true });
      assert(res.isError !== true, `environment_remove failed: ${oneLine(bodyText(res))}`);
      assertEq(payload(res).removed, "klant-b", "removed");
      const stored = JSON.parse(readFileSync(envFile, "utf8"));
      assert(!stored.some((e) => e.name === "klant-b"), "klant-b is still in the file");
      assert(stored.some((e) => e.name === "klant-a"), "klant-a should still be there");
    });

    await test("per-environment read-only: DELETE with confirm:true is BLOCKED, not executed", async () => {
      const added = await s.call("environment_add", APP_ENV("klant-ro", "ro.onmicrosoft.com", { readOnly: true }));
      assert(added.isError !== true, `environment_add readOnly failed: ${oneLine(bodyText(added))}`);
      assertEq(payload(added).readOnly, true, "readOnly flag");
      assertEq(payload(added).activeEnvironment, "klant-ro", "read-only env must be active");

      const res = await s.call("graph_request", {
        path: "/users/00000000-0000-0000-0000-000000000000",
        method: "DELETE",
        confirm: true,
      });
      const text = bodyText(res);
      assertStartsWith(text, "BLOCKED:", "read-only graph_request DELETE");
      assertEq(res.isError, true, "blocked write should be flagged as an error result");
      assertIncludes(text, "read-only", "blocked reason");
      assertIncludes(text, "was NOT executed", "blocked message must state nothing happened");
      assertIncludes(header(res), "SCHRIJFACTIE", "blocked call header");
    });

    await test("normal environment: same DELETE without confirm requires confirmation", async () => {
      const used = await s.call("environment_use", { name: "klant-a" });
      assertEq(payload(used).activeEnvironment, "klant-a", "switch back to a writable environment");
      const res = await s.call("graph_request", {
        path: "/users/00000000-0000-0000-0000-000000000000",
        method: "DELETE",
      });
      const text = bodyText(res);
      assertStartsWith(text, "CONFIRMATION REQUIRED", "normal env DELETE without confirm");
      assertNotIncludes(text, "BLOCKED", "must not be blocked on a writable environment");
    });

    await test("audit log: records blocked_read_only and awaiting_confirmation outcomes", async () => {
      const res = await s.call("audit_log", { limit: 200 });
      assert(res.isError !== true, `audit_log failed: ${oneLine(bodyText(res))}`);
      const data = payload(res);
      assertEq(data.file, auditFile, "audit_log file must be the isolated AUDIT_LOG_FILE");
      const entries = data.newestFirst ?? [];
      assert(entries.length > 0, "audit log is empty");
      const outcomes = new Set(entries.map((e) => e.outcome));
      for (const expected of ["blocked_read_only", "awaiting_confirmation"]) {
        // Make a failure self-documenting: show the entries that describe a blocked
        // write but were classified under a different outcome.
        const misfiled = entries
          .filter((e) => String(e.detail ?? "").startsWith("BLOCKED:"))
          .map((e) => `${e.tool}=>${e.outcome}`);
        assert(
          outcomes.has(expected),
          `outcome ${expected} missing from [${[...outcomes].join(", ")}]` +
            (misfiled.length > 0 ? `; entries with a BLOCKED: detail were logged as ${misfiled.join(", ")}` : "")
        );
      }
      assert(
        entries.every((e) => typeof e.ts === "string" && typeof e.tool === "string"),
        "audit entries must carry ts and tool"
      );
    });

    await test("audit log: clientSecret is redacted but the entry is still recorded", async () => {
      const SECRET = "supersecret-should-not-appear";
      const res = await s.call(
        "environment_add",
        APP_ENV("klant-secret", "secret.onmicrosoft.com", { clientSecret: SECRET })
      );
      assert(res.isError !== true, `environment_add with secret failed: ${oneLine(bodyText(res))}`);
      assertNotIncludes(bodyText(res), SECRET, "tool response must not echo the secret");

      assert(existsSync(auditFile), "audit log file missing");
      const raw = readFileSync(auditFile, "utf8");
      assertNotIncludes(raw, SECRET, "audit log file must not contain the secret");
      const lines = raw.split("\n").filter((l) => l.trim());
      const entry = lines
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return undefined;
          }
        })
        .find((e) => e && e.tool === "environment_add" && e.args && e.args.name === "klant-secret");
      assert(entry, "no audit entry for the environment_add with a secret");
      assertEq(entry.args.clientSecret, "[redacted]", "clientSecret in the audit entry");
    });
  });
}

async function groupTenantKnowledge() {
  await withServer("knowledge", {}, async (s) => {
    const knowledgeFile = s.env.TENANT_KNOWLEDGE_FILE;
    const TENANT = "kennis.onmicrosoft.com";
    const NOTE = "Dit toestel draait Windows 11 Home, BitLocker is technisch onmogelijk.";
    let noteId;

    await test("tenant knowledge: note is stored for the active tenant", async () => {
      const added = await s.call("environment_add", APP_ENV("klant-k", TENANT));
      assert(added.isError !== true, `environment_add failed: ${oneLine(bodyText(added))}`);

      const res = await s.call("tenant_note_add", {
        topic: "HPOMEN30L",
        note: NOTE,
        tags: ["bitlocker", "compliance"],
      });
      assert(res.isError !== true, `tenant_note_add failed: ${oneLine(bodyText(res))}`);
      const data = payload(res);
      assertEq(data.tenant, TENANT, "note tenant");
      assertEq(data.totalNotesForTenant, 1, "notes for tenant");
      assertEq(data.storedIn, knowledgeFile, "storedIn must be the isolated TENANT_KNOWLEDGE_FILE");
      assert(typeof data.stored?.id === "string" && data.stored.id.length > 0, "no note id returned");
      noteId = data.stored.id;
      assert(existsSync(knowledgeFile), "knowledge file was not created");
    });

    await test("tenant knowledge: search term finds the note", async () => {
      const res = await s.call("tenant_notes", { query: "bitlocker" });
      assert(res.isError !== true, `tenant_notes failed: ${oneLine(bodyText(res))}`);
      const data = payload(res);
      assertEq(data.count, 1, "matching note count");
      assertEq(data.notes[0].id, noteId, "matched note id");
      assertIncludes(data.notes[0].note, "BitLocker", "matched note text");
      const miss = payload(await s.call("tenant_notes", { query: "iets-dat-niet-bestaat" }));
      assertEq(miss.count, 0, "count for a non-matching search term");
    });

    await test("tenant knowledge: identical note twice does not create a duplicate", async () => {
      const res = await s.call("tenant_note_add", { topic: "HPOMEN30L", note: NOTE, tags: ["bitlocker"] });
      assert(res.isError !== true, `tenant_note_add failed: ${oneLine(bodyText(res))}`);
      const data = payload(res);
      assertEq(data.totalNotesForTenant, 1, "notes for tenant after re-adding");
      assertEq(data.stored.id, noteId, "the existing note should be returned");
      const all = payload(await s.call("tenant_notes", {}));
      assertEq(all.count, 1, "total notes for tenant");
    });

    await test("tenant knowledge: allTenants overview lists the tenant", async () => {
      const res = await s.call("tenant_notes", { allTenants: true });
      assert(res.isError !== true, `tenant_notes allTenants failed: ${oneLine(bodyText(res))}`);
      const data = payload(res);
      assertEq(data.storedIn, knowledgeFile, "allTenants storedIn");
      const found = (data.tenants ?? []).find((t) => String(t.tenantId).toLowerCase() === TENANT);
      assert(found, `tenant ${TENANT} missing from ${oneLine(JSON.stringify(data.tenants))}`);
      assertEq(found.notes, 1, "note count in the overview");
      assert(
        Array.isArray(found.environmentNames) && found.environmentNames.includes("klant-k"),
        "environment name should be linked to the tenant"
      );
    });

    await test("tenant knowledge: remove needs confirm, then removes the note", async () => {
      const guarded = await s.call("tenant_note_remove", { id: noteId });
      assertStartsWith(bodyText(guarded), "CONFIRMATION REQUIRED", "tenant_note_remove without confirm");
      assertEq(payload(await s.call("tenant_notes", {})).count, 1, "note must still exist");

      const removed = await s.call("tenant_note_remove", { id: noteId, confirm: true });
      assert(removed.isError !== true, `tenant_note_remove failed: ${oneLine(bodyText(removed))}`);
      const data = payload(removed);
      assertEq(data.removed?.id, noteId, "removed note id");
      assertEq(data.remaining, 0, "remaining notes");
      assertEq(payload(await s.call("tenant_notes", {})).count, 0, "notes after removal");
    });
  });
}

async function groupBom() {
  const bomEnv = [
    { name: "bom-klant", tenantId: "bom.onmicrosoft.com", authMode: "app", description: "Written with a UTF-8 BOM" },
  ];
  await withServer(
    "bom",
    {
      prepare: (dir, env) => {
        writeFileSync(env.ENVIRONMENTS_FILE, `﻿${JSON.stringify(bomEnv, null, 2)}`, "utf8");
      },
    },
    async (s) => {
      await test("BOM tolerance: environments.json written with a UTF-8 BOM still loads", async () => {
        const bytes = readFileSync(s.env.ENVIRONMENTS_FILE);
        assertEq(
          bytes.subarray(0, 3).toString("hex"),
          "efbbbf",
          "the fixture itself must start with a UTF-8 BOM"
        );
        const res = await s.call("environment_list", {});
        assert(res.isError !== true, `environment_list failed: ${oneLine(bodyText(res))}`);
        const data = payload(res);
        const found = (data.environments ?? []).find((e) => e.name === "bom-klant");
        assert(found, `bom-klant not loaded; got [${(data.environments ?? []).map((e) => e.name).join(", ")}]`);
        assertEq(found.tenantId, "bom.onmicrosoft.com", "bom-klant tenantId");
        assertEq(found.active, true, "bom-klant should be the active environment");
      });
    }
  );
}

async function groupMultiTenant() {
  await withServer("multitenant", {}, async (s) => {
    await test("multi_tenant_query: two unauthenticated tenants degrade into per-tenant errors", async () => {
      for (const name of ["klant-1", "klant-2"]) {
        const added = await s.call("environment_add", APP_ENV(name, `${name}.onmicrosoft.com`));
        assert(added.isError !== true, `environment_add ${name} failed: ${oneLine(bodyText(added))}`);
      }
      const used = await s.call("environment_use", { name: "klant-1" });
      assertEq(payload(used).activeEnvironment, "klant-1", "active environment before the query");

      const res = await s.call(
        "multi_tenant_query",
        { dataset: "devices", environments: ["klant-1", "klant-2"] },
        30_000
      );
      assert(res.isError !== true, `multi_tenant_query itself must not be an error: ${oneLine(bodyText(res))}`);
      const data = payload(res);
      assertEq(data.rowCount, 0, "rowCount");
      assert(Array.isArray(data.rows) && data.rows.length === 0, "rows must be empty");
      const perTenant = data.perTenant ?? [];
      assertEq(perTenant.length, 2, "perTenant length");
      for (const name of ["klant-1", "klant-2"]) {
        const entry = perTenant.find((t) => t.environment === name);
        assert(entry, `${name} missing from perTenant`);
        assert(
          typeof entry.error === "string" && entry.error.length > 0,
          `${name} should carry an error string, got ${JSON.stringify(entry.error)}`
        );
        assertEq(entry.rowCount, 0, `${name} rowCount`);
      }
      assert(Array.isArray(data.columnsSuggestion) && data.columnsSuggestion.length > 0, "columnsSuggestion missing");
    });

    await test("multi_tenant_query: the previously active environment is restored", async () => {
      const listed = payload(await s.call("environment_list", {}));
      const active = (listed.environments ?? []).filter((e) => e.active).map((e) => e.name);
      assertEq(active.join(","), "klant-1", "active environment after the query");
      const status = payload(await s.call("auth_status", {}));
      assertEq(status.activeEnvironment, "klant-1", "auth_status activeEnvironment");
    });
  });
}

async function groupUnits() {
  const distUrl = (file) => new URL(`../dist/${file}`, import.meta.url).href;

  await test("unit: analyzeScript classifies mutating vs read-only PowerShell", async () => {
    const { analyzeScript } = await import(distUrl("powershell-analysis.js"));
    const cases = [
      ["Get-MgUser -All", false],
      ["Remove-MgUser -UserId x", true],
      ["Set-Something -WhatIf", false],
      ["Invoke-RestMethod -Uri x", false],
      ["Invoke-RestMethod -Uri x -Method POST", true],
      ["New-Object System.Text.StringBuilder", false],
      ["# Remove-MgUser -UserId x\nGet-MgUser -All", false],
    ];
    for (const [script, expected] of cases) {
      const analysis = analyzeScript(script);
      assertEq(analysis.mutating, expected, `analyzeScript(${JSON.stringify(script)}).mutating`);
      assert(
        typeof analysis.because === "string" && analysis.because.length > 0,
        `analyzeScript(${JSON.stringify(script)}) must explain itself`
      );
      assert(Array.isArray(analysis.matches), "matches must be an array");
    }
  });

  await test("unit: renderChartSvg emits safe, NaN-free SVG with escaped labels", async () => {
    const { renderChartSvg } = await import(distUrl("charts.js"));
    for (const type of ["donut", "bar", "hbar"]) {
      const svg = renderChartSvg({
        type,
        title: "Titel <b> & 'x'",
        data: [
          { label: "a<b>&c", value: 3 },
          { label: "normaal", value: 1 },
          // Hostile numbers must never leak into coordinates.
          { label: "kapot", value: Number.NaN },
        ],
      });
      assertStartsWith(svg, "<svg", `${type}: output must start with <svg`);
      assertNotIncludes(svg, "NaN", `${type}: output must not contain NaN`);
      assertIncludes(svg, "&lt;", `${type}: '<' must be escaped`);
      assertIncludes(svg, "&gt;", `${type}: '>' must be escaped`);
      assertIncludes(svg, "&amp;", `${type}: '&' must be escaped`);
      assertNotIncludes(svg, "a<b>", `${type}: raw label markup must not survive`);
    }
  });

  await test("unit: redact hides secret-looking keys and truncates long strings", async () => {
    const { redact } = await import(distUrl("audit.js"));
    const redacted = redact({
      name: "klant-a",
      clientSecret: "supersecret-should-not-appear",
      nested: { password: "p", apiKey: "k", keep: "visible" },
    });
    assertEq(redacted.clientSecret, "[redacted]", "clientSecret");
    assertEq(redacted.nested.password, "[redacted]", "nested password");
    assertEq(redacted.nested.apiKey, "[redacted]", "nested apiKey");
    assertEq(redacted.nested.keep, "visible", "non-secret values must survive");
    assertEq(redacted.name, "klant-a", "non-secret values must survive");

    const long = redact("x".repeat(5000));
    assertEq(typeof long, "string", "long value type");
    assert(long.length < 1000, `long string was not truncated (${long.length} chars)`);
    assertIncludes(long, "5000 chars", "truncation marker");
  });
}

// ================================================================ runner

async function main() {
  if (!existsSync(DIST_INDEX)) {
    console.log(`FAIL build - ${DIST_INDEX} does not exist; run "npm run build" first`);
    process.exit(1);
  }
  console.log(`microsoft-admin-mcp smoke suite (v${PKG.version})`);
  console.log(`isolated state directory: ${ROOT}`);
  console.log(`network tests: ${NETWORK ? "enabled" : "disabled (set SMOKE_NETWORK=1)"}`);
  console.log("");

  await groupCore();
  await groupEnvironmentsAndAudit();
  await groupTenantKnowledge();
  await groupBom();
  await groupMultiTenant();
  await groupUnits();

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  console.log("");
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
  return failed === 0 ? 0 : 1;
}

/** Reuse the server's own browser detection so png/pdf tests skip cleanly in CI. */
async function findBrowserPath() {
  try {
    const { findBrowser } = await import(new URL("../dist/render.js", import.meta.url).href);
    return findBrowser();
  } catch {
    return undefined;
  }
}

const watchdog = setTimeout(() => {
  console.log("");
  console.log("FAIL suite - global timeout reached; killing everything");
  cleanup();
  process.exit(1);
}, SUITE_BUDGET_MS);

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.log(`FAIL suite - unexpected error: ${oneLine(err && err.stack ? err.stack : err)}`);
  exitCode = 1;
} finally {
  clearTimeout(watchdog);
  cleanup();
}
process.exit(exitCode);
