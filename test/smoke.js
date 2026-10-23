// Headless smoke test: stubs the DOM, loads renderer.js, and renders a live
// /metrics payload (when the Strata server is reachable) plus the saved
// fixture. The live part is skipped offline, e.g. in CI. Run: node test/smoke.js
const fs = require("node:fs");
const path = require("node:path");

/* ---- minimal DOM stub ---- */
class El {
  constructor(id) { this.id = id; this.children = []; this.dataset = {}; this.style = {}; this.hidden = false; this._html = ""; this._text = ""; this.onclick = null; this.oninput = null; this.value = ""; }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  classList = { _s: new Set(), toggle(n, f) { f ? this._s.add(n) : this._s.delete(n); } };
  querySelector(sel) { return this._q?.[sel] ?? (this._q = { ".spark": new El("spark"), ".line": new El("line"), ".area": new El("area") })[sel]; }
  setAttribute() { }
  get parentElement() { return this; }
}
const els = new Map();
const $ = (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };
$("cards").children = [];
$("state-badges").children = ["idle", "reading", "generating", "queued", "error"].map((s) => { const e = new El(`b-${s}`); e.dataset.s = s; return e; });
global.document = {
  getElementById: $,
  querySelector: () => new El("q"),
  querySelectorAll: () => [],
  documentElement: { dataset: {}, style: {} },
};
global.window = { strata: { platform: "linux", getState: async () => ({ settings: {}, payload: null }), setSetting: async () => { }, refresh: async () => { }, minimize() { }, close() { }, resetSize() { }, settingsHeight() { }, onMetrics() { }, onSettings() { }, onOpenSettings() { } } };

/* ---- load renderer.js ---- */
const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "renderer.js"), "utf8");
const run = new Function("window", "document", src + "\nreturn { render, renderFailure, renderConnected };");
const api = run(global.window, global.document);

/* ---- 1. live server (optional: LAN-only, skipped in CI) ---- */
(async () => {
  const url = process.env.STRATA_URL || "http://127.0.0.1:8080";
  const key = process.env.STRATA_KEY || "";
  let live = null;
  try {
    const r = await fetch(`${url}/metrics`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(4000),
    });
    if (r.status === 200) live = await r.json();
  } catch { /* offline */ }
  if (live) {
    api.render(live);
    console.log("live render OK");
    console.log("  speed :", $("mv-speed").innerHTML.replace(/<[^>]+>/g, " ").trim(), "|", $("ms-speed").textContent);
    console.log("  gpu   :", $("mv-gpu").innerHTML.replace(/<[^>]+>/g, "").trim(), "|", $("ms-gpu").textContent);
    console.log("  vram  :", $("mv-vram").innerHTML.replace(/<[^>]+>/g, " ").trim(), "|", $("ms-vram").textContent);
    console.log("  pcie  :", $("mv-pcie").innerHTML.replace(/<[^>]+>/g, "").trim(), "|", $("ms-pcie").textContent);
    console.log("  ctx   :", $("ctx-pct").textContent, $("ctx-sub").textContent);
    console.log("  rows  :", ($("req-body").innerHTML.match(/<tr>/g) || []).length);
  } else {
    console.log("live server unreachable — live render skipped");
  }

  /* ---- 2. fixture ---- */
  api.render(JSON.parse(fs.readFileSync(path.join(__dirname, "metrics.json"), "utf8")));
  console.log("fixture render OK");

  /* ---- 3. failure paths ---- */
  api.renderFailure(401, "HTTP 401");
  console.assert($("state-label").textContent === "API key needed", "401 label");
  api.renderFailure(0, "connect ECONNREFUSED");
  console.assert($("state-label").textContent === "Server not reachable", "offline label");
  console.log("failure paths OK");

  /* ---- 4. empty metrics ---- */
  api.render({ live: { state: "idle" }, hardware: {}, hardware_static: {}, engine: {}, history: {}, requests: [] });
  console.log("empty metrics OK");
})().catch((e) => { console.error("SMOKE FAILED:", e.message); process.exit(1); });
