// Exercise Electron window lifecycle without opening a desktop window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function boot(servers, { wayland = false } = {}) {
  const handles = new Map();
  const events = new Map();
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  let ready;
  let latest;
  let tray;
  class Window extends EventEmitter {
    static all = [];
    constructor(options) { super(); this.options = options; this.size = [options.width, options.height]; this.skipTaskbar = options.skipTaskbar; this.minimum = [options.minWidth, options.minHeight]; this.minimized = false; this.position = [options.x ?? 100, options.y ?? 120]; latest = this; Window.all.push(this); }
    isDestroyed() { return Boolean(this.destroyed); }
    // A newer window may exist only as this server's replacement (mode switch),
    // never as another server's window.
    destroy() { assert.ok(latest === this || latest.options.title === this.options.title, 'replacement exists before old window closes'); this.destroyed = true; this.emit('closed'); }
    close() { this.destroy(); }
    getPosition() { return this.position; }
    setPosition(x, y) { this.position = [x, y]; }
    getContentSize() { return this.size; }
    frameSize() { return this.options.frame ? [wayland ? 44 : 16, wayland ? 80 : 36] : [0, 0]; }
    getBounds() { const [fw, fh] = this.frameSize(); return { x: this.position[0], y: this.position[1], width: this.size[0] + fw, height: this.size[1] + fh }; }
    isVisible() { return Boolean(this.visible); }
    setSkipTaskbar(value) { this.skipTaskbar = value; }
    setMinimumSize(...size) { this.minimum = size; }
    // Reproduce Electron/Wayland treating requested content height as outer height.
    setContentSize(width, height) { this.size = [width, height - (wayland ? this.frameSize()[1] : 0)]; }
    setSize(width, height) { const [fw, fh] = this.frameSize(); this.outerSize = [width, height]; this.size = [width - fw, height - fh]; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setOpacity() {}
    setBackgroundColor() {}
    setTitle() {}
    center() { this.position = [0, 0]; }
    removeMenu() {}
    loadFile() { this.emit('ready-to-show'); }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    webContents = { send() {} };
  }
  class Tray {
    constructor() { this.events = new Map(); tray = this; }
    setContextMenu(menu) { this.menu = menu; }
    setToolTip() {}
    setImage() {}
    on(name, callback) { this.events.set(name, callback); }
  }
  const electron = {
    app: {
      getPath: () => '/fake-user-data',
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then: callback => { ready = callback; } }),
      on: (name, callback) => events.set(name, callback),
    },
    BrowserWindow: Window, Tray,
    ipcMain: { handle: (name, callback) => handles.set(name, callback), on: (name, callback) => handles.set(name, callback) },
    screen: { getDisplayMatching: () => ({ workArea }) },
    Menu: { buildFromTemplate: menu => menu },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === 'node:fs' ? {
      readFileSync: () => JSON.stringify({ servers }), writeFileSync() {},
    } : require(name),
    __dirname: path.join(__dirname, '../electron'),
    process: { platform: 'win32' },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: async () => ({ status: 503, ok: false }), AbortController, console, Buffer,
  });
  ready();
  const live = () => [...liveWindows()];
  function liveWindows() {
    // main.js keeps instances internally; expose them through the created windows.
    return Window.all.filter(w => !w.isDestroyed());
  }
  return {
    get window() { return latest; },
    windows: live,
    tray, events, workArea,
    setCompact: value => handles.get('set-setting')({ sender: latest.webContents }, 'compact', value),
    fit: (height, sender = latest.webContents, width = 760) => handles.get('win:fit-content')({ sender }, height, width),
    addServer: () => handles.get('server:add')({ sender: latest.webContents }),
    removeServer: () => handles.get('server:remove')({ sender: latest.webContents }),
    // Simulate the user closing a window: no replacement invariant applies.
    forceClose: w => { w.destroyed = true; w.emit('closed'); },
  };
}

for (const compact of [false, true]) {
  const app = boot([{ compact }]);
  assert.equal(app.windows().length, 1, 'one widget window per configured server');
  assert.equal(app.window.options.skipTaskbar, compact, 'startup taskbar visibility');
  assert.equal(app.window.options.frame, !compact, 'native title bar in full mode');
  assert.equal(app.window.options.transparent, compact, 'transparent corners in compact mode');
  assert.equal(app.window.options.useContentSize, true, 'frame does not reduce the content area');
  assert.equal(app.window.options.minWidth, compact ? 380 : 760, 'mode-specific startup minimum width');
  assert.equal(app.window.skipTaskbar, compact);
  for (const mode of [true, false, true]) {
    const previous = app.window;
    const changed = previous.options.frame === mode;
    app.setCompact(mode);
    assert.equal(app.window.options.frame, !mode);
    assert.equal(app.window.options.transparent, mode);
    assert.equal(app.window.options.resizable, !mode);
    assert.equal(app.window.options.maximizable, !mode);
    assert.equal(app.window.minimum[0], mode ? 380 : 760, 'full mode cannot collapse to a single column');
    if (changed) {
      assert.notEqual(app.window, previous, 'frame changes recreate the native window');
      assert(previous.isDestroyed());
      assert.deepEqual(app.window.position, previous.position, 'position survives mode changes');
      assert.equal(app.window.isVisible(), true, 'replacement becomes visible when ready');
    }
    assert.equal(app.window.skipTaskbar, mode, 'taskbar visibility follows mode');
    assert.equal(app.window.size[1], mode ? 46 : 720);
    const compactItem = app.tray.menu[0].submenu.find(item => item.label?.includes('Compact mode'));
    assert.equal(compactItem.label.startsWith('✓'), mode, 'tray reflects current mode');
  }
  app.window.hide();
  app.setCompact(false);
  assert.equal(app.window.isVisible(), false, 'hidden widget stays hidden across a mode change');
  const showServer = app.tray.menu[0].submenu.find(item => item.label === 'Show');
  for (const show of [app.tray.events.get('click'), showServer.click, app.events.get('second-instance')]) {
    app.window.minimized = true;
    app.window.visible = false;
    app.window.focused = false;
    show();
    assert.equal(app.window.minimized, false, 'restore minimized widget');
    assert.equal(app.window.visible, true);
    assert.equal(app.window.focused, true);
  }
  app.window.size[0] = 320;
  app.fit(2000, app.window.webContents, 320);
  assert.deepEqual(app.window.size, [760, 720], 'discard height measured from a transient single-column layout');
  app.window.size[0] = 320;
  app.fit(800.2);
  assert.equal(app.window.size[0], 760, 'use rendered width instead of transient native width');
  assert.equal(app.window.size[1], 801, 'grow to measured content height');
  assert.deepEqual(app.window.outerSize, [776, 837], 'include measured decorations in the native resize');
  app.fit(750);
  assert.equal(app.window.size[1], 801, 'keep a larger existing window');
  for (const height of [NaN, Infinity, -1, '900']) app.fit(height);
  app.fit(900, {});
  assert.equal(app.window.size[1], 801, 'ignore invalid heights and stale renderers');
  app.workArea.y = 50;
  app.workArea.height = 900;
  app.fit(2000);
  assert.equal(app.window.size[1], 864, 'subtract native frame from display work area');
  assert.equal(app.window.position[1], 50, 'keep the resized window on screen');
  app.setCompact(true);
  app.fit(1000);
  assert.equal(app.window.size[1], 46, 'never auto-grow compact mode');
}
const wayland = boot([{}], { wayland: true });
wayland.window.size = [760, 619];
wayland.fit(699);
assert.deepEqual(wayland.window.size, [760, 699], 'Wayland receives the required content height');
assert.deepEqual(wayland.window.outerSize, [804, 779], 'Wayland resize includes its actual 44x80 decorations');
wayland.fit(699);
assert.deepEqual(wayland.window.size, [760, 699], 'Wayland fitting remains stable');

// Multiple servers: one window each, independent chrome, add/remove.
const multi = boot([{ name: 'Home', baseUrl: 'http://a:8080' }, { name: 'Office', baseUrl: 'http://b:8080', compact: true }]);
assert.equal(multi.windows().length, 2, 'each configured server gets its own window');
const [home, office] = multi.windows();
assert.equal(home.options.frame, true, 'full-mode server keeps its native frame');
assert.equal(office.options.frame, false, 'compact-mode server is frameless');
assert.equal(office.skipTaskbar, true, 'compact server hides the taskbar entry');
assert.equal(multi.tray.menu.length, 5, 'one tray entry per server, separator, Add server, Quit');
assert.ok(multi.tray.menu[0].label.startsWith('Home · '), 'tray lists server names with state');
assert.ok(multi.tray.menu[1].label.startsWith('Office · '), 'tray lists every server');
assert.equal(multi.tray.menu[3].label, 'Add server…');
assert.equal(multi.tray.menu[4].label, 'Quit');
// Per-server settings route to the window that sent them.
home.visible = false; home.focused = false; office.visible = false; office.focused = false;
multi.tray.menu[0].submenu.find(item => item.label === 'Show').click();
assert.equal(home.visible, true, 'Show focuses the right server window');
assert.equal(home.focused, true, 'Show focuses the right server window');
assert.equal(office.visible, false, 'the other window is untouched');
const before = multi.windows().length;
const list = multi.addServer();
assert.equal(list.length, 3, 'add returns the updated server list');
assert.equal(multi.windows().length, before + 1, 'Add server opens a new widget window');
assert.notEqual(multi.window, home, 'the new window is a separate BrowserWindow');
assert.equal(multi.window.options.frame, true, 'new servers start in full mode');
const added = multi.window;
multi.removeServer();
assert.equal(multi.windows().length, before, 'Remove closes only its own window');
assert.equal(home.isDestroyed(), false, 'removing a server leaves the others running');
assert.equal(added.isDestroyed(), true, 'the removed window closed');
// Closing a window keeps the profile: the tray can reopen it.
multi.forceClose(home);
assert.equal(multi.windows().length, before - 1, 'closed window drops its instance');
const reopen = multi.tray.menu[0].submenu.find(item => item.label === 'Open');
reopen.click();
assert.equal(multi.windows().length, before, 'tray Open recreates the window for the saved profile');
assert.equal(multi.windows().some(w => !w.isDestroyed() && w.options.frame), true, 'reopened window is full mode again');

console.log('window modes, taskbar visibility, tray recovery, multi-server windows, and content fitting OK');
