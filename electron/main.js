// Strata Widget — main process.
// Polls the Strata server here so the renderer never hits CORS, and owns the
// window chrome: always-on-top ("compat mode"), theme, settings persistence.
const { app, BrowserWindow, ipcMain, Tray, Menu, safeStorage, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "",
  theme: "light",
  alwaysOnTop: false,
  opacity: 1,
  pollMs: 1000,
  compact: false,
};

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    const s = { ...DEFAULTS, ...raw };
    delete s.apiKeyEnc; // storage-only, never a runtime setting
    // A key typed into Settings (plaintext) always wins over a stale encrypted
    // one, so a leftover apiKeyEnc can never silently override what the user
    // just entered.
    if (raw.apiKey) {
      s.apiKey = raw.apiKey;
    } else if (raw.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
      try { s.apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, "base64")); } catch { s.apiKey = ""; }
    } else {
      s.apiKey = "";
    }
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s) {
  const out = { ...s };
  delete out.apiKeyEnc; // keep apiKey / apiKeyEnc mutually exclusive
  const key = out.apiKey || "";
  if (!key) {
    out.apiKey = "";
  } else {
    // Prefer OS-level encryption, but never let a failing encryptString abort
    // the whole write (that would silently drop the key the user just typed).
    let enc = null;
    try {
      if (safeStorage.isEncryptionAvailable()) enc = safeStorage.encryptString(key).toString("base64");
    } catch { enc = null; }
    if (enc) out.apiKeyEnc = enc;
    else out.apiKey = key;
  }
  try { fs.writeFileSync(settingsFile(), JSON.stringify(out, null, 2)); } catch { }
}

let settings = loadSettings();
let win = null;
let tray = null;
let pollTimer = null;
let lastPayload = null;

// Tray dot mirrors the model state, like the title-bar dot in the window.
const TRAY_STATES = ["idle", "reading", "generating", "queued", "error"];
function trayIcon(state) {
  const name = TRAY_STATES.includes(state) ? state : "idle";
  const img = nativeImage.createFromPath(path.join(__dirname, "..", "renderer", `tray-${name}.png`));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

// 760x640 fits the full monitor layout (bar + tabs + state + 4-up metric grid
// + context card) with a small bottom margin; requests live on their own tab.
const FULL_SIZE = { width: 760, height: 640 };
const COMPACT_SIZE = { width: 560, height: 44 };

function normalizeBase(u) {
  const v = (u || "").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(v) ? v : `http://${v}`;
}

async function request(pathname, { timeout = 4000 } = {}) {
  const base = normalizeBase(settings.baseUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = {};
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const r = await fetch(`${base}/${pathname}`, { headers, signal: ctrl.signal });
    if (r.status === 401) {
      // Terminal evidence of what the widget actually sent, without leaking the key.
      console.log(`[strata] GET ${base}/${pathname} -> 401 (Authorization ${settings.apiKey ? "sent" : "missing"})`);
      return { status: 401 };
    }
    if (!r.ok) return { status: r.status };
    return { status: r.status, body: await r.json() };
  } catch (e) {
    return { status: 0, error: e.name === "AbortError" ? "timeout" : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function pollOnce() {
  const m = await request("metrics");
  if (m.status === 200) {
    const h = await request("health", { timeout: 6000 });
    lastPayload = { ok: true, status: 200, metrics: m.body, health: h.status === 200 ? h.body : null };
  } else {
    lastPayload = { ok: false, status: m.status, error: m.error || `HTTP ${m.status}`, metrics: null, auth: Boolean(settings.apiKey) };
  }
  if (win && !win.isDestroyed()) win.webContents.send("metrics", lastPayload);
  updateTrayState();
}

function updateTrayState() {
  if (!tray) return;
  const live = lastPayload?.metrics?.live || {};
  const state = lastPayload?.ok
    ? (live.queued > 0 ? "queued" : live.state || "idle")
    : "error";
  tray.setImage(trayIcon(state));
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, Math.max(250, settings.pollMs || 1000));
  pollOnce();
}

function applyWindowFlags() {
  if (!win || win.isDestroyed()) return;
  // screen-saver level keeps the widget above ordinary windows and fullscreen
  // apps on both Windows and Linux/X11.
  win.setAlwaysOnTop(settings.alwaysOnTop, settings.alwaysOnTop ? "screen-saver" : "normal");
  win.setVisibleOnAllWorkspaces(Boolean(settings.alwaysOnTop), { visibleOnFullScreen: true });
  // setOpacity is win32/darwin only (no-op on Linux); the renderer fades the
  // page with CSS there instead.
  if (process.platform === "win32" || process.platform === "darwin") {
    win.setOpacity(settings.opacity ?? 1);
  }
  win.setBackgroundColor(settings.theme === "dark" ? "#0e1116" : "#f5f7fa");
  rebuildTray();
}

function applyCompactSize() {
  if (!win || win.isDestroyed()) return;
  if (settings.compact) {
    win.setMinimumSize(320, 40);
    win.setSize(COMPACT_SIZE.width, COMPACT_SIZE.height);
  } else {
    win.setMinimumSize(320, 340);
    win.setSize(FULL_SIZE.width, FULL_SIZE.height);
  }
}

function rebuildTray() {
  if (!tray) return;
  const on = settings.alwaysOnTop;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: on ? "✓ Always on top" : "Always on top", click: () => setSetting("alwaysOnTop", !on) },
    { label: settings.theme === "dark" ? "✓ Dark theme" : "Light theme", click: () => setSetting("theme", settings.theme === "dark" ? "light" : "dark") },
    { label: settings.compact ? "✓ Compact mode" : "Compact mode", click: () => setSetting("compact", !settings.compact) },
    { label: "Open settings…", click: () => win?.webContents.send("open-settings") },
    { type: "separator" },
    { label: "Reload data", click: () => pollOnce() },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.setToolTip(`Strata Widget${on ? " · pinned" : ""}`);
  updateTrayState();
}

function setSetting(key, value) {
  settings[key] = value;
  saveSettings(settings);
  if (key === "pollMs") startPolling();
  else if (key === "compact") applyCompactSize();
  else applyWindowFlags();
  if (win && !win.isDestroyed()) win.webContents.send("settings", settings);
}

function createWindow() {
  win = new BrowserWindow({
    width: settings.compact ? COMPACT_SIZE.width : FULL_SIZE.width,
    height: settings.compact ? COMPACT_SIZE.height : FULL_SIZE.height,
    minWidth: 320,
    minHeight: 40,
    frame: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: settings.theme === "dark" ? "#0e1116" : "#f5f7fa",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  applyWindowFlags();
  applyCompactSize();
  win.on("closed", () => { win = null; });
}

// Frameless window controls.
ipcMain.on("win:minimize", () => win?.minimize());
ipcMain.on("win:close", () => app.quit());
ipcMain.on("win:reset-size", () => { applyCompactSize(); win?.center(); });

// The settings overlay needs more height than the 44px compact strip.
ipcMain.on("win:settings-height", (_e, open) => {
  if (!win || win.isDestroyed() || !settings.compact) return;
  win.setSize(COMPACT_SIZE.width, open ? 430 : COMPACT_SIZE.height);
});

ipcMain.handle("get-state", () => ({ settings, payload: lastPayload }));
ipcMain.handle("set-setting", (_e, key, value) => { setSetting(key, value); return settings; });
ipcMain.handle("refresh", async () => { await pollOnce(); return lastPayload; });

// Single instance: a second launch focuses the existing widget instead.
if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });

app.whenReady().then(() => {
  createWindow();
  startPolling();
  try {
    tray = new Tray(trayIcon("idle"));
    rebuildTray();
  } catch {
    tray = null; // no system tray in this environment; window controls still work
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => app.quit());
