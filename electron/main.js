// Strata Widget — main process.
// One widget window per Strata server profile. Each profile polls its own
// server here so the renderer never hits CORS, and owns its window chrome:
// always-on-top ("compat mode"), theme, settings persistence.
const { app, BrowserWindow, ipcMain, Tray, Menu, safeStorage, nativeImage, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULTS = {
  id: "",
  name: "Strata",
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "",
  theme: "light",
  alwaysOnTop: false,
  opacity: 1,
  pollMs: 1000,
  compact: false,
};

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function nextId(taken) {
  let n = 1;
  while (taken.has(`srv-${n}`)) n++;
  return `srv-${n}`;
}

// A key typed into Settings (plaintext) always wins over a stale encrypted
// one, so a leftover apiKeyEnc can never silently override what the user
// just entered.
function decryptKey(raw) {
  if (raw.apiKey) return raw.apiKey;
  if (raw.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, "base64")); } catch { return ""; }
  }
  return "";
}

function normalizeServer(raw, taken) {
  const s = { ...DEFAULTS, ...raw };
  delete s.apiKeyEnc; // storage-only, never a runtime setting
  s.apiKey = decryptKey(raw);
  if (!s.id || taken.has(s.id)) s.id = nextId(taken);
  taken.add(s.id);
  return s;
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    // Legacy single-server files are a flat object; migrate them to profile 1.
    const list = Array.isArray(raw.servers) && raw.servers.length ? raw.servers : [raw];
    const taken = new Set();
    return list.map((s) => normalizeServer(s, taken));
  } catch {
    return [normalizeServer({}, new Set())];
  }
}

function saveConfig() {
  const out = servers.map((s) => {
    const o = { ...s };
    delete o.apiKeyEnc; // keep apiKey / apiKeyEnc mutually exclusive
    const key = o.apiKey || "";
    if (!key) {
      o.apiKey = "";
    } else {
      // Prefer OS-level encryption, but never let a failing encryptString abort
      // the whole write (that would silently drop the key the user just typed).
      let enc = null;
      try {
        if (safeStorage.isEncryptionAvailable()) enc = safeStorage.encryptString(key).toString("base64");
      } catch { enc = null; }
      if (enc) o.apiKeyEnc = enc;
      else o.apiKey = key;
    }
    return o;
  });
  try { fs.writeFileSync(settingsFile(), JSON.stringify({ servers: out }, null, 2)); } catch { }
}

let servers = loadConfig();
// serverId -> { server, win, pollTimer, lastPayload, windowCompact }
const instances = new Map();
let tray = null;

const serverById = (id) => servers.find((s) => s.id === id) || null;
const instanceOfSender = (sender) =>
  [...instances.values()].find((i) => i.win && !i.win.isDestroyed() && i.win.webContents === sender) || null;
const serverList = () => servers.map((s) => ({ id: s.id, name: s.name }));

// Tray dot mirrors the model state, like the title-bar dot in the window.
const TRAY_STATES = ["idle", "reading", "generating", "queued", "error"];
function trayIcon(state) {
  const name = TRAY_STATES.includes(state) ? state : "idle";
  const img = nativeImage.createFromPath(path.join(__dirname, "..", "renderer", `tray-${name}.png`));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

// 760x720 fits the full monitor layout (bar + tabs + state + 4-up metric grid
// + context card) with a small bottom margin; requests live on their own tab.
const FULL_SIZE = { width: 760, height: 720 };
const COMPACT_SIZE = { width: 560, height: 46 };

function normalizeBase(u) {
  const v = (u || "").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(v) ? v : `http://${v}`;
}

async function request(server, pathname, { timeout = 4000 } = {}) {
  const base = normalizeBase(server.baseUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = {};
    if (server.apiKey) headers.Authorization = `Bearer ${server.apiKey}`;
    const r = await fetch(`${base}/${pathname}`, { headers, signal: ctrl.signal });
    if (r.status === 401) {
      // Terminal evidence of what the widget actually sent, without leaking the key.
      console.log(`[strata] GET ${base}/${pathname} -> 401 (Authorization ${server.apiKey ? "sent" : "missing"})`);
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

async function pollOnce(instance) {
  const server = instance.server;
  const m = await request(server, "metrics");
  if (m.status === 200) {
    const h = await request(server, "health", { timeout: 6000 });
    instance.lastPayload = { ok: true, status: 200, metrics: m.body, health: h.status === 200 ? h.body : null };
  } else {
    instance.lastPayload = { ok: false, status: m.status, error: m.error || `HTTP ${m.status}`, metrics: null, auth: Boolean(server.apiKey) };
  }
  if (instance.win && !instance.win.isDestroyed()) instance.win.webContents.send("metrics", instance.lastPayload);
  updateTrayState();
}

function startPolling(instance) {
  clearInterval(instance.pollTimer);
  instance.pollTimer = setInterval(() => pollOnce(instance), Math.max(250, instance.server.pollMs || 1000));
  pollOnce(instance);
}

function trayStateFor(instance) {
  const live = instance.lastPayload?.metrics?.live || {};
  return instance.lastPayload?.ok
    ? (live.queued > 0 ? "queued" : live.state || "idle")
    : "error";
}

function updateTrayState() {
  if (!tray) return;
  // The tray dot mirrors the first server's model state, like the title-bar dot.
  const first = instances.get(servers[0]?.id);
  tray.setImage(trayIcon(first ? trayStateFor(first) : "idle"));
}

function createWindow(server, { x, y, visible = true } = {}) {
  const compact = Boolean(server.compact);
  const instance = { server, win: null, pollTimer: null, lastPayload: null, windowCompact: compact };
  const created = new BrowserWindow({
    width: compact ? COMPACT_SIZE.width : FULL_SIZE.width,
    height: compact ? COMPACT_SIZE.height : FULL_SIZE.height,
    minWidth: compact ? 380 : FULL_SIZE.width,
    minHeight: compact ? COMPACT_SIZE.height : 340,
    x, y,
    useContentSize: true,
    frame: !compact,
    title: server.name ? `${server.name} — Strata Widget` : "Strata Widget",
    titleBarStyle: "default",
    transparent: compact,
    roundedCorners: true,
    hasShadow: true,
    resizable: !compact,
    maximizable: !compact,
    fullscreenable: !compact,
    skipTaskbar: compact,
    show: false,
    backgroundColor: compact ? "#00000000" : server.theme === "dark" ? "#10120f" : "#f5f7f0",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  instance.win = created;
  instances.set(server.id, instance);
  created.once("ready-to-show", () => {
    if (visible && !created.isDestroyed()) created.show();
  });
  created.removeMenu();
  created.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  applyWindowFlags(instance);
  // The constructor already sets size and constraints. Reapplying native size
  // changes here races the window manager's initial configure on Linux.
  created.on("closed", () => {
    clearInterval(instance.pollTimer);
    instance.pollTimer = null;
    if (instances.get(server.id)?.win === created) instances.delete(server.id);
    rebuildTray();
  });
  return instance;
}

function applyWindowFlags(instance) {
  const win = instance.win;
  if (!win || win.isDestroyed()) return;
  const server = instance.server;
  // screen-saver level keeps the widget above ordinary windows and fullscreen
  // apps on both Windows and Linux/X11.
  win.setAlwaysOnTop(server.alwaysOnTop, server.alwaysOnTop ? "screen-saver" : "normal");
  win.setVisibleOnAllWorkspaces(Boolean(server.alwaysOnTop), { visibleOnFullScreen: true });
  // setOpacity is win32/darwin only (no-op on Linux); the renderer fades the
  // page with CSS there instead.
  if (process.platform === "win32" || process.platform === "darwin") {
    win.setOpacity(server.opacity ?? 1);
  }
  win.setBackgroundColor(server.compact ? "#00000000" : server.theme === "dark" ? "#10120f" : "#f5f7f0");
  win.setTitle(server.name ? `${server.name} — Strata Widget` : "Strata Widget");
  rebuildTray();
}

function applyCompactSize(instance) {
  const win = instance.win;
  if (!win || win.isDestroyed()) return;
  // Native frames and transparency are creation-time options in Electron.
  // Create the replacement first so switching modes never closes every window.
  if (instance.windowCompact !== Boolean(instance.server.compact)) {
    const previous = win;
    const [x, y] = previous.getPosition();
    const next = createWindow(instance.server, { x, y, visible: previous.isVisible() || previous.isMinimized() });
    // The replacement starts with no payload; carry the last one so its renderer
    // paints the current state instead of sitting on "Connecting…".
    next.lastPayload = instance.lastPayload;
    previous.destroy();
    // createWindow never polls, and closing the old window clears its timer, so
    // without this the recreated widget would stop fetching metrics for good.
    startPolling(next);
    return;
  }
  win.setSkipTaskbar(Boolean(instance.server.compact));
  if (instance.server.compact) {
    win.setMinimumSize(380, COMPACT_SIZE.height);
    win.setContentSize(COMPACT_SIZE.width, COMPACT_SIZE.height);
  } else {
    win.setMinimumSize(FULL_SIZE.width, 340);
    win.setContentSize(FULL_SIZE.width, FULL_SIZE.height);
  }
  rebuildTray();
}

function showInstance(instance) {
  if (!instance || !instance.win || instance.win.isDestroyed()) return;
  if (instance.win.isMinimized()) instance.win.restore();
  instance.win.show();
  instance.win.focus();
}

// Show every widget; used when a second launch of the app is refused by the
// single-instance lock.
function showAllWindows() {
  for (const instance of instances.values()) showInstance(instance);
}

function rebuildTray() {
  if (!tray) return;
  const items = [];
  for (const server of servers) {
    const instance = instances.get(server.id);
    const label = server.name || "Strata";
    const sub = [];
    if (instance) {
      sub.push({ label: "Show", click: () => showInstance(instance) });
      sub.push({ type: "separator" });
      sub.push({
        label: server.alwaysOnTop ? "✓ Always on top" : "Always on top",
        click: () => setSetting(instance, "alwaysOnTop", !server.alwaysOnTop),
      });
      sub.push({
        label: server.theme === "dark" ? "✓ Dark theme" : "Light theme",
        click: () => setSetting(instance, "theme", server.theme === "dark" ? "light" : "dark"),
      });
      sub.push({
        label: server.compact ? "✓ Compact mode" : "Compact mode",
        click: () => setSetting(instance, "compact", !server.compact),
      });
      sub.push({ label: "Open settings…", click: () => instance.win?.webContents.send("open-settings") });
      sub.push({ label: "Reload data", click: () => pollOnce(instance) });
      sub.push({ type: "separator" });
      sub.push({ label: "Close window", click: () => instance.win?.close() });
    } else {
      // Profile saved but its window was closed: reopen it rather than lose it.
      sub.push({ label: "Open", click: () => startServer(server) });
      sub.push({ type: "separator" });
    }
    sub.push({ label: "Remove server", click: () => removeServer(server.id) });
    items.push({ label: `${label} · ${instance ? trayStateFor(instance) : "closed"}`, submenu: sub });
  }
  items.push({ type: "separator" });
  items.push({ label: "Add server…", click: () => addServer() });
  items.push({ label: "Quit", click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(`Strata Widget · ${servers.length} server${servers.length === 1 ? "" : "s"}`);
  updateTrayState();
}

function setSetting(instance, key, value) {
  instance.server[key] = value;
  saveConfig();
  if (key === "pollMs") startPolling(instance);
  else if (key === "compact") applyCompactSize(instance);
  else applyWindowFlags(instance);
  if (instance.win && !instance.win.isDestroyed()) instance.win.webContents.send("settings", instance.server);
}

// A new profile always gets its own window, so monitoring a second server never
// disturbs the first one.
function addServer() {
  const taken = new Set(servers.map((s) => s.id));
  const server = { ...DEFAULTS, id: nextId(taken), name: `Strata ${servers.length + 1}` };
  servers.push(server);
  saveConfig();
  const instance = createWindow(server);
  startPolling(instance);
  rebuildTray();
  return server;
}

function removeServer(id) {
  const remaining = servers.filter((s) => s.id !== id);
  servers = remaining.length ? remaining : [normalizeServer({}, new Set())];
  saveConfig();
  // Keep at least one widget window alive: window-all-closed quits the app.
  // Start the replacement before closing so the app never sees zero windows.
  if (!servers.some((s) => s.id !== id && instances.has(s.id))) startServer(servers[0]);
  const instance = instances.get(id);
  if (instance?.win && !instance.win.isDestroyed()) instance.win.close();
  rebuildTray();
}

function startServer(server) {
  const instance = createWindow(server);
  startPolling(instance);
  rebuildTray();
  return instance;
}

// Frameless window controls.
ipcMain.on("win:minimize", (event) => instanceOfSender(event.sender)?.win?.minimize());
ipcMain.on("win:close", () => app.quit());
ipcMain.on("win:reset-size", (event) => {
  const instance = instanceOfSender(event.sender);
  if (!instance) return;
  applyCompactSize(instance);
  instance.win?.center();
});

// Fit the measured renderer content, including native frame height, to this
// display. Grow only: a larger user-selected window should remain larger.
ipcMain.on("win:fit-content", (event, height, renderedWidth) => {
  const instance = instanceOfSender(event.sender);
  const win = instance?.win;
  if (!win || win.isDestroyed() || instance.server.compact) return;
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(renderedWidth) || renderedWidth <= 0) return;
  // Never apply the height of a one-column layout or feed a transient native
  // width back into setContentSize while the initial window is being mapped.
  if (renderedWidth < 700) {
    win.setContentSize(FULL_SIZE.width, FULL_SIZE.height);
    return;
  }
  const [currentWidth, currentHeight] = win.getContentSize();
  const width = Math.max(FULL_SIZE.width, Math.ceil(renderedWidth));
  const bounds = win.getBounds();
  const frameWidth = bounds.width - currentWidth;
  const frameHeight = bounds.height - currentHeight;
  const { workArea } = screen.getDisplayMatching(bounds);
  const fittedHeight = Math.min(Math.ceil(height), workArea.height - frameHeight);
  if (fittedHeight <= currentHeight && width === currentWidth) return;
  const targetHeight = Math.max(currentHeight, fittedHeight);
  // On Electron/Wayland setContentSize can apply height as the outer height,
  // leaving the renderer short by the decorations on every resize. Set the
  // outer dimensions explicitly using the actual measured frame in both axes.
  win.setSize(width + frameWidth, targetHeight + frameHeight);
  const bottom = bounds.y + targetHeight + frameHeight;
  if (bottom > workArea.y + workArea.height) {
    win.setPosition(bounds.x, Math.max(workArea.y, workArea.y + workArea.height - targetHeight - frameHeight));
  }
});

// The settings overlay needs more height than the 46px compact strip.
ipcMain.on("win:settings-height", (event, open) => {
  const instance = instanceOfSender(event.sender);
  const win = instance?.win;
  if (!win || win.isDestroyed() || !instance.server.compact) return;
  win.setContentSize(COMPACT_SIZE.width, open ? 480 : COMPACT_SIZE.height);
});

ipcMain.handle("get-state", (event) => {
  const instance = instanceOfSender(event.sender);
  if (!instance) return { settings: null, servers: serverList(), payload: null };
  return { settings: instance.server, servers: serverList(), payload: instance.lastPayload };
});
ipcMain.handle("set-setting", (event, key, value) => {
  const instance = instanceOfSender(event.sender);
  if (!instance) return null;
  setSetting(instance, key, value);
  return instance.server;
});
ipcMain.handle("refresh", async (event) => {
  const instance = instanceOfSender(event.sender);
  if (!instance) return null;
  await pollOnce(instance);
  return instance.lastPayload;
});
ipcMain.handle("server:add", (event) => {
  instanceOfSender(event.sender); // sender must be a widget window
  const server = addServer();
  return serverList();
});
ipcMain.handle("server:remove", (event) => {
  const instance = instanceOfSender(event.sender);
  if (!instance) return serverList();
  removeServer(instance.server.id);
  return serverList();
});

// Single instance: a second launch focuses the existing widgets instead.
if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", showAllWindows);

app.whenReady().then(() => {
  for (const server of servers) startServer(server);
  try {
    tray = new Tray(trayIcon("idle"));
    tray.on("click", showAllWindows);
    rebuildTray();
  } catch {
    tray = null; // no system tray in this environment; window controls still work
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) for (const server of servers) startServer(server);
  });
});

app.on("window-all-closed", () => app.quit());
