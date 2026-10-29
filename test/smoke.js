// Headless smoke test: stubs the DOM, loads renderer.js, and renders a live
// /metrics payload (when the Strata server is reachable) plus the saved
// fixture. The live part is skipped offline, e.g. in CI. Run: node test/smoke.js
const fs = require("node:fs");
const path = require("node:path");

/* ---- minimal DOM stub ---- */
class El {
  constructor(id) { this.id = id; this.children = []; this.dataset = {}; this.style = {}; this.hidden = false; this._html = ""; this._text = ""; this.onclick = null; this.oninput = null; this.onkeydown = null; this.value = ""; }
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
// Captured at load time: renderer.js registers its settings listener during boot.
let broadcast = null;
global.window = { strata: { platform: "linux", getState: async () => ({ settings: {}, payload: null }), setSetting: async () => { }, refresh: async () => { }, addServer: async () => [], removeServer: async () => [], minimize() { }, close() { }, resetSize() { }, settingsHeight() { }, onMetrics() { }, onSettings: (cb) => { broadcast = cb; }, onOpenSettings() { } } };

/* ---- load renderer.js ---- */
const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "renderer.js"), "utf8");
const run = new Function("window", "document", src + "\nreturn { render, renderFailure, renderConnected, connectNow };");
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

  /* ---- 5. context-fill ring tracks usage ---- */
  // r=40 -> circumference 251.3; half of a 131072-token context = 125.65.
  api.render({
    live: { state: "generating", prompt_tokens: 65536, generated: 0 },
    hardware: {}, hardware_static: {}, engine: { max_context: 131072 }, history: {}, requests: [],
  });
  console.assert($("ctx-fill").style.strokeDasharray === "125.7 251.3", `ctx dasharray: ${$("ctx-fill").style.strokeDasharray}`);
  console.assert($("ctx-pct").textContent === "50%", `ctx pct: ${$("ctx-pct").textContent}`);
  if ($("ctx-fill").style.strokeDasharray !== "125.7 251.3" || $("ctx-pct").textContent !== "50%") {
    throw new Error(`context fill ring wrong: dasharray=${$("ctx-fill").style.strokeDasharray} pct=${$("ctx-pct").textContent}`);
  }
  console.log("context fill ring OK");

  /* ---- 6. Connect must survive the settings broadcast ---- */
  // Regression: main broadcasts the saved settings after every setSetting, so
  // the renderer's `settings` object is replaced mid-connect with apiKey ""
  // (the key isn't stored yet). connectNow must read the fields from the DOM,
  // never from `settings`, or the typed key is silently wiped before saving.
  const saved = {};
  global.window.strata.setSetting = async (k, v) => {
    saved[k] = v;
    // Mirror main.js setSetting: save, then broadcast the whole settings object.
    if (broadcast) broadcast({ baseUrl: saved.baseUrl || "", apiKey: k === "apiKey" ? v : "" });
  };
  global.window.strata.refresh = async () => ({ ok: true, status: 200, metrics: {}, health: {} });
  $("set-url").value = "http://example.test:8080";
  $("set-key").value = "dummy-key";
  await api.connectNow();
  if (saved.apiKey !== "dummy-key") {
    throw new Error(`connect wiped the key: saved.apiKey=${JSON.stringify(saved.apiKey)}`);
  }
  console.log("connect keeps typed key through broadcast OK");
})().catch((e) => { console.error("SMOKE FAILED:", e.message); process.exit(1); });
