/* Strata Widget — renderer. Renders the payload the main process polls. */
const $ = (id) => document.getElementById(id);

const ICONS = {
  speed: '<path d="M13 2L4.1 12.5H11l-1 9.5 8.9-10.5H12z"/>',
  gpu: '<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M9 7V4M15 7V4M8 17v3M16 17v3"/>',
  vram: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h.01M12 10h.01M16 10h.01"/>',
  temp: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>',
  power: '<path d="M13 2L4.1 12.5H11l-1 9.5 8.9-10.5H12z"/>',
  pcie: '<path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  disk: '<path d="M4 8h16v10H4z"/><path d="M4 8l2-4h12l2 4M8 12h8"/>',
};

const CARDS = [
  { key: "speed", icon: "speed", label: "Speed", dual: true },
  { key: "gpu", icon: "gpu", label: "GPU load" },
  { key: "vram", icon: "vram", label: "VRAM" },
  { key: "temp", icon: "temp", label: "GPU temp" },
  { key: "power", icon: "power", label: "Power" },
  { key: "pcie", icon: "pcie", label: "PCIe" },
  { key: "cpu", icon: "cpu", label: "CPU" },
  { key: "disk", icon: "disk", label: "Disk read" },
];

function buildCards() {
  const grid = $("cards");
  grid.innerHTML = CARDS.map((c) => `
    <div class="card metric">
      <div class="metric__head"><svg viewBox="0 0 24 24">${ICONS[c.icon]}</svg>${c.label}</div>
      <div class="metric__value" id="mv-${c.key}">–</div>
      <div class="metric__sub" id="ms-${c.key}"></div>
      <svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none"><path class="area"/><path class="line"/></svg>
    </div>`).join("");
}

/* ---- formatting ---- */
const fmt = (v, d = 0) => v == null ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const gb = (bytes, d = 1) => bytes == null ? "–" : fmt(bytes / 1073741824, d);
const kfmt = (n) => n == null ? "–" : Number(n).toLocaleString();
const ctxfmt = (n) => n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
const time = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function spark(key, values, max) {
  const svg = document.querySelector(`#mv-${key}`)?.parentElement?.querySelector(".spark");
  if (!svg) return;
  const v = (values || []).map((x) => (x == null ? 0 : x));
  if (v.length < 2) { svg.querySelector(".line").setAttribute("d", ""); svg.querySelector(".area").setAttribute("d", ""); return; }
  const top = Math.max(max || 0, ...v, 1);
  const pts = v.map((x, i) => [(i / (v.length - 1)) * 100, 30 - (x / top) * 26]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("");
  svg.querySelector(".line").setAttribute("d", line);
  svg.querySelector(".area").setAttribute("d", `${line}L100,32L0,32Z`);
}

function setMetric(key, value, unit, sub) {
  $(`mv-${key}`).innerHTML = value == null ? "–" : `${value}${unit ? `<small>${unit}</small>` : ""}`;
  $(`ms-${key}`).textContent = sub || "";
}

function setDot(state) { $("dot").dataset.state = state; }

function setBadges(on, state) {
  for (const b of $("state-badges").children) b.classList.toggle("on", b.dataset.s === on || b.dataset.s === state);
}

/* ---- render ---- */
function renderConnected(health) {
  $("brand-text").textContent = "Strata";
  if (health?.model) { $("model-name").textContent = health.model; $("strip-model").textContent = health.model; $("strip-model").title = health.model; }
}

function renderFailure(status, error) {
  setDot("error");
  setBadges("error", "error");
  $("state-label").textContent = status === 401 ? "API key needed" : "Server not reachable";
  $("state-detail").textContent = error || "";
  $("state-bar").style.width = "0%";
  $("req-body").innerHTML = `<tr><td colspan="6" class="muted">${status === 401 ? "Add the API key in Settings." : "Retrying…"}</td></tr>`;
  $("strip-dot").dataset.state = "error";
  $("strip-state").textContent = status === 401 ? "Key needed" : "Offline";
  $("strip-speed").textContent = "–";
  $("strip-gpu").textContent = "–";
  $("strip-ctx").textContent = "–";
}

function render(m) {
  const live = m.live || {}, hw = m.hardware || {}, st = m.hardware_static || {}, eng = m.engine || {}, h = m.history || {};
  const last = (m.requests || [])[0];

  const on = live.queued > 0 ? "queued" : live.state;
  setDot(on === "error" ? "error" : on);
  setBadges(on, live.state);

  let label = "Waiting for a request", detail = "", pct = 0, tone = "";
  if (live.state === "reading") {
    label = "Reading prompt"; tone = "info";
    if (live.prompt_total) {
      pct = (100 * live.prompt_read) / live.prompt_total;
      detail = `${kfmt(live.prompt_read)} / ${kfmt(live.prompt_total)} tokens · ${fmt(pct)}%`;
    } else detail = `${kfmt(live.prompt_tokens)} tokens`;
  } else if (live.state === "generating") {
    label = live.phase ? live.phase[0].toUpperCase() + live.phase.slice(1) : "Generating";
    pct = live.max_tokens ? Math.min(100, (100 * live.generated) / live.max_tokens) : 0;
    detail = `${kfmt(live.generated)} tokens · ${fmt(live.tok_s, 1)} tok/s`;
  } else if (last) {
    detail = `last: ${kfmt(last.output_tokens)} tokens${last.decode_tok_s ? ` at ${fmt(last.decode_tok_s, 1)} tok/s` : ""}`;
  }
  $("state-label").textContent = label;
  $("state-detail").textContent = detail;
  const bar = $("state-bar");
  bar.style.width = `${pct}%`;
  if (tone) bar.dataset.tone = "info"; else delete bar.dataset.tone;

  // Speed card: decode + prefill side by side, like the original.
  const speed = live.state === "generating" ? live.tok_s : last ? last.decode_tok_s : null;
  const prefill = live.state !== "idle" ? live.prefill_tok_s_mean
    : last && last.prompt_ms > 0 ? Math.max(0, last.prompt_tokens - (last.reused || 0)) / (last.prompt_ms / 1000) : null;
  const speedTxt = speed == null ? "–" : `${fmt(speed, 1)}<small>t/s</small>`;
  const prefillTxt = prefill == null ? "" : ` ${fmt(prefill)}<small>t/s</small>`;
  $("mv-speed").innerHTML = speedTxt + prefillTxt;
  $("ms-speed").textContent = live.state === "generating" ? "Decode now"
    : live.state === "reading" ? "Prefill now" : last ? "Decode last request" : "Decode";
  spark("speed", h.tok_s);

  const multi = (hw.gpus || []).length > 1;
  const per = (f) => (hw.gpus || []).map((g) => `GPU ${g.index} ${f(g)}`).join(" · ");

  setMetric("gpu", hw.gpu_util == null ? null : fmt(hw.gpu_util), "%",
    multi ? per((g) => (g.util == null ? "–" : `${fmt(g.util)}%`)) : st.gpu_name || (st.gpu_note ? "not available" : ""));
  spark("gpu", h.gpu_util, 100);

  setMetric("vram", hw.gpu_mem_used == null ? null : gb(hw.gpu_mem_used), hw.gpu_mem_total ? `/ ${gb(hw.gpu_mem_total, 0)} GB` : "GB",
    multi ? per((g) => (g.mem_used == null ? "–" : `${gb(g.mem_used)} GB`))
      : eng.expert_slots ? `${kfmt(eng.expert_slots)} experts cached` : (st.gpu_note || ""));
  spark("vram", h.gpu_mem_used, hw.gpu_mem_total);

  setMetric("temp", hw.gpu_temp == null ? null : fmt(hw.gpu_temp), "°C",
    multi ? per((g) => (g.temp == null ? "–" : `${fmt(g.temp)}°`)) : "");
  spark("temp", h.gpu_temp, 90);

  setMetric("power", hw.gpu_power == null ? null : fmt(hw.gpu_power), "W",
    hw.gpu_power_limit ? `of ${fmt(hw.gpu_power_limit)} W limit` : "");
  spark("power", h.gpu_power, hw.gpu_power_limit);

  const gen = hw.gpu_pcie_gen_max || hw.gpu_pcie_gen;
  setMetric("pcie", gen ? `Gen${gen}` : null, hw.gpu_pcie_width ? `x${hw.gpu_pcie_width}` : "",
    hw.gpu_pcie_rx_mb == null ? "" : `to GPU ${fmt(hw.gpu_pcie_rx_mb, hw.gpu_pcie_rx_mb < 10 ? 1 : 0)} MB/s` +
      (hw.gpu_pcie_gen && gen && hw.gpu_pcie_gen < gen ? ` · idle Gen${hw.gpu_pcie_gen}` : ""));
  spark("pcie", h.gpu_pcie_rx_mb);

  setMetric("cpu", hw.cpu == null ? null : fmt(hw.cpu), "%",
    st.threads ? `${st.cores ? `${st.cores} cores · ` : ""}${st.threads} threads` : "");
  spark("cpu", h.cpu, 100);

  if (hw.disk_read_mb == null) {
    setMetric("disk", null, "", st.psutil ? "" : "needs psutil");
  } else {
    const big = hw.disk_read_mb >= 1000;
    setMetric("disk", big ? fmt(hw.disk_read_mb / 1024, 2) : fmt(hw.disk_read_mb, hw.disk_read_mb < 10 ? 1 : 0),
      big ? "GB/s" : "MB/s", hw.disk_write_mb == null ? "" : `write ${fmt(hw.disk_write_mb, 1)} MB/s`);
  }
  spark("disk", h.disk_read_mb);

  // context fill
  const ctx = eng.max_context || 0;
  let used = 0;
  if (live.state !== "idle") used = (live.prompt_tokens || 0) + (live.generated || 0);
  else if (last) used = (last.prompt_tokens || 0) + (last.output_tokens || 0);
  const frac = ctx ? Math.min(1, used / ctx) : 0;
  // inline style, not setAttribute: the .donut__fill CSS rule would override a
  // presentation attribute and the ring would never fill.
  $("ctx-fill").style.strokeDasharray = `${(251.3 * frac).toFixed(1)} 251.3`;
  $("ctx-fill").style.opacity = 251.3 * frac >= 3 ? "1" : "0";
  $("ctx-pct").textContent = `${Math.round(frac * 100)}%`;
  $("ctx-sub").textContent = ctx ? `${kfmt(used)} / ${ctxfmt(ctx)}` : "–";

  const cacheBytes = (eng.expert_cache_mib || 0) * 1048576;
  $("slots-text").textContent = eng.expert_slots ? `${kfmt(eng.expert_slots)} · ${gb(cacheBytes)} GB` : "–";
  $("slots-bar").style.width = hw.gpu_mem_total ? `${Math.min(100, (100 * cacheBytes) / hw.gpu_mem_total)}%` : "0%";

  $("ram-text").textContent = hw.ram_total ? `${gb(hw.ram_used)} / ${gb(hw.ram_total, 0)} GB` : "–";
  const ramPct = hw.ram_total ? (100 * hw.ram_used) / hw.ram_total : 0;
  const ramBar = $("ram-bar");
  ramBar.style.width = `${ramPct}%`;
  if (ramPct > 92) ramBar.dataset.tone = "danger"; else delete ramBar.dataset.tone;

  $("temp-text").textContent = hw.gpu_temp == null ? "–" : `${fmt(hw.gpu_temp)} °C`;
  $("temp-bar").style.width = hw.gpu_temp == null ? "0%" : `${Math.min(100, hw.gpu_temp)}%`;

  // recent requests
  const badge = {
    stop: ["", "Done"], length: ["", "Max tokens"], cancel: ["pill--warn", "Stopped"],
    disconnect: ["pill--warn", "Closed"], error: ["pill--bad", "Error"]
  };
  // compact strip: state, speed, gpu load, context fill
  const shortState = { idle: "Idle", reading: "Reading", generating: "Generating", queued: "Queued", error: "Error" };
  $("strip-dot").dataset.state = on === "error" ? "error" : on;
  $("strip-state").textContent = shortState[on] || on || "Idle";
  $("strip-speed").textContent = speed == null ? "–" : fmt(speed, 1);
  $("strip-gpu").textContent = hw.gpu_util == null ? "–" : fmt(hw.gpu_util);
  $("strip-ctx").textContent = ctx ? String(Math.round(frac * 100)) : "–";

  const reqs = (m.requests || []).slice(0, 60);
  $("req-count").textContent = m.requests_kept ? `kept ${kfmt(m.requests_kept)}` : "";
  $("req-body").innerHTML = reqs.length ? reqs.map((r) => {
    const b = badge[r.finish] || ["", r.finish || ""];
    return `<tr><td>${time(r.time)}</td>
      <td><span class="pill ${b[0]}"><i></i>${b[1]}</span></td>
      <td>${kfmt(r.prompt_tokens)}</td><td>${kfmt(r.reused)}</td>
      <td>${kfmt(r.output_tokens)}</td><td>${fmt(r.decode_tok_s, 1)}</td></tr>`;
  }).join("") : `<tr><td colspan="6" class="muted">No requests yet</td></tr>`;
}

/* ---- chrome: theme, pin, settings ---- */
let settings = { theme: "light", alwaysOnTop: false, opacity: 1, pollMs: 1000, baseUrl: "", apiKey: "" };

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("btn-theme").classList.toggle("ibtn--on", t === "dark");
}
function applyPin(on) { $("btn-pin").classList.toggle("ibtn--on", Boolean(on)); }

function applyCompact(on) {
  // delete, not "" — an empty attribute value still matches [data-compact].
  if (on) document.documentElement.dataset.compact = "1";
  else delete document.documentElement.dataset.compact;
  $("strip").hidden = !on;
  $("btn-compact").classList.toggle("ibtn--on", Boolean(on));
  $("btn-compact").title = on ? "Exit compact mode" : "Compact mode (tab bar)";
  $("btn-compact").setAttribute("aria-label", $("btn-compact").title);
  $("btn-compact").setAttribute("aria-pressed", String(Boolean(on)));
}

/* ---- tabs: Monitor / Requests ---- */
function applyTab(t) {
  $("tab-btn-monitor").classList.toggle("on", t === "monitor");
  $("tab-btn-requests").classList.toggle("on", t === "requests");
  $("tab-monitor").hidden = t !== "monitor";
  $("tab-requests").hidden = t !== "requests";
}
$("tab-btn-monitor").onclick = () => applyTab("monitor");
$("tab-btn-requests").onclick = () => applyTab("requests");

// win.setOpacity() is a no-op on Linux, so fade the page with CSS there;
// Windows/macOS use the native window opacity and leave the page alone.
const IS_LINUX = window.strata.platform === "linux";
function applyOpacity(v) {
  const o = Math.min(1, Math.max(0.5, v ?? 1));
  document.documentElement.style.opacity = IS_LINUX ? String(o) : "";
}

function fillSettings() {
  $("set-url").value = settings.baseUrl || "";
  $("set-key").value = settings.apiKey || "";
  $("set-opacity").value = settings.opacity ?? 1;
  $("opacity-val").textContent = `${Math.round((settings.opacity ?? 1) * 100)}%`;
  $("set-poll").value = settings.pollMs || 1000;
  $("poll-val").textContent = `${((settings.pollMs || 1000) / 1000).toFixed(1)} s`;
}

$("btn-theme").onclick = () => { const t = settings.theme === "dark" ? "light" : "dark"; settings.theme = t; applyTheme(t); window.strata.setSetting("theme", t); };
$("btn-pin").onclick = () => { const on = !settings.alwaysOnTop; settings.alwaysOnTop = on; applyPin(on); window.strata.setSetting("alwaysOnTop", on); };
$("btn-compact").onclick = () => { const on = !settings.compact; settings.compact = on; applyCompact(on); window.strata.setSetting("compact", on); };
$("btn-min").onclick = () => window.strata.minimize();
$("btn-close").onclick = () => window.strata.close();
function toggleSettings(open) {
  $("settings").hidden = !open;
  if (open) {
    fillSettings();
    $("set-status").hidden = true;
  }
  if (settings.compact) window.strata.settingsHeight(open);
}
$("btn-settings").onclick = () => toggleSettings($("settings").hidden);
$("set-close").onclick = () => toggleSettings(false);
$("set-opacity").oninput = () => {
  const v = Number($("set-opacity").value);
  $("opacity-val").textContent = `${Math.round(v * 100)}%`;
  applyOpacity(v);
  window.strata.setSetting("opacity", v);
};
$("set-poll").oninput = () => {
  const v = Number($("set-poll").value);
  $("poll-val").textContent = `${(v / 1000).toFixed(1)} s`;
  window.strata.setSetting("pollMs", v);
};
$("set-reset").onclick = () => window.strata.resetSize();

// Connect: save server/key, poll once immediately, and report the result inline.
// Keeps the overlay open on failure so the fields can be fixed in place.
async function connectNow() {
  const status = $("set-status");
  status.hidden = false;
  // Capture the fields in locals BEFORE any await: setSetting broadcasts the
  // saved settings back to this renderer, which replaces the `settings` object
  // mid-await and would wipe a typed key to "" before it ever gets stored.
  const url = $("set-url").value.trim();
  const key = $("set-key").value.trim();
  settings.baseUrl = url;
  settings.apiKey = key;
  if (!url) {
    status.dataset.state = "bad";
    status.textContent = "Enter the server URL first";
    return;
  }
  if (!key) {
    status.dataset.state = "bad";
    status.textContent = "Enter the API key first";
    return;
  }
  status.dataset.state = "pending";
  status.textContent = "Connecting\u2026";
  await window.strata.setSetting("baseUrl", url);
  await window.strata.setSetting("apiKey", key);
  const p = await window.strata.refresh();
  if (p?.ok) {
    status.dataset.state = "ok";
    status.textContent = "Connected";
    toggleSettings(false);
  } else {
    status.dataset.state = "bad";
    status.textContent = p?.status === 401
      ? `API key rejected (401)${p.auth ? "" : " \u2014 no key was sent"}`
      : `Not reachable: ${p?.error || `HTTP ${p?.status}`}`;
  }
}
$("set-connect").onclick = () => connectNow();
// Editing either field invalidates the previous attempt's status line.
$("set-url").oninput = () => { $("set-status").hidden = true; };
$("set-key").oninput = () => { $("set-status").hidden = true; };
$("set-url").onkeydown = (e) => { if (e.key === "Enter") connectNow(); };
$("set-key").onkeydown = (e) => { if (e.key === "Enter") connectNow(); };
$("set-key-reveal").onclick = () => {
  const inp = $("set-key");
  const shown = inp.type === "text";
  inp.type = shown ? "password" : "text";
  $("set-key-reveal").textContent = shown ? "Show" : "Hide";
  $("set-key-reveal").title = shown ? "Show" : "Hide";
};
$("set-save").onclick = async () => {
  // Same broadcast trap as connectNow: read every field into locals first.
  const url = $("set-url").value.trim();
  const key = $("set-key").value.trim();
  const opacity = Number($("set-opacity").value);
  const pollMs = Number($("set-poll").value);
  settings.baseUrl = url;
  settings.apiKey = key;
  settings.opacity = opacity;
  settings.pollMs = pollMs;
  await window.strata.setSetting("baseUrl", url);
  await window.strata.setSetting("apiKey", key);
  await window.strata.setSetting("opacity", opacity);
  await window.strata.setSetting("pollMs", pollMs);
  toggleSettings(false);
  window.strata.refresh();
};

/* ---- boot ---- */
buildCards();

function fitWindowToContent() {
  if (settings.compact || $("tab-monitor").hidden) return;
  const monitor = $("tab-monitor");
  window.strata.fitContent(Math.ceil(window.innerHeight + monitor.scrollHeight - monitor.clientHeight), window.innerWidth);
}

// Measure after layout and font loading rather than guessing from fixed sizes.
// Observe the cards too: live text and width changes can alter their height.
if (typeof ResizeObserver === "function") {
  let fitFrame;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(fitWindowToContent);
  });
  for (const element of document.querySelectorAll(".widget, .bar, .tabs, #tab-monitor, #tab-monitor > section")) observer.observe(element);
  document.fonts.ready.then(fitWindowToContent);
}

(async () => {
  const state = await window.strata.getState();
  settings = { ...settings, ...state.settings };
  applyTheme(settings.theme);
  applyPin(settings.alwaysOnTop);
  applyCompact(settings.compact);
  applyOpacity(settings.opacity);
  if (state.payload) state.payload.ok ? render(state.payload.metrics) : renderFailure(state.payload.status, state.payload.error);
  if (state.payload?.health) renderConnected(state.payload.health);
})();
window.strata.onMetrics((p) => {
  if (p.ok) { renderConnected(p.health); render(p.metrics); }
  else renderFailure(p.status, p.error);
});
window.strata.onSettings((s) => {
  settings = { ...settings, ...s };
  applyTheme(settings.theme);
  applyPin(settings.alwaysOnTop);
  applyCompact(settings.compact);
  applyOpacity(settings.opacity);
});
window.strata.onOpenSettings(() => toggleSettings(true));
