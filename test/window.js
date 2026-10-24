// Exercise Electron window lifecycle without opening a desktop window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function boot(compact, { wayland = false } = {}) {
  const handles = new Map();
  const events = new Map();
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  let ready;
  let window;
  let tray;
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.size = [options.width, options.height]; this.skipTaskbar = options.skipTaskbar; this.minimum = [options.minWidth, options.minHeight]; this.minimized = false; this.position = [options.x ?? 100, options.y ?? 120]; window = this; }
    isDestroyed() { return Boolean(this.destroyed); }
    destroy() { assert.notEqual(window, this, 'replacement exists before old window closes'); this.destroyed = true; this.emit('closed'); }
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
      readFileSync: () => JSON.stringify({ compact }), writeFileSync() {},
    } : require(name),
    __dirname: path.join(__dirname, '../electron'),
    process: { platform: 'win32' },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: async () => ({ status: 503, ok: false }), AbortController, console, Buffer,
  });
  ready();
  return { get window() { return window; }, tray, events, workArea,
    setCompact: value => handles.get('set-setting')(null, 'compact', value),
    fit: (height, sender = window.webContents, width = 760) => handles.get('win:fit-content')({ sender }, height, width),
  };
}

for (const compact of [false, true]) {
  const app = boot(compact);
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
    const compactItem = app.tray.menu.find(item => item.label?.includes('Compact mode'));
    assert.equal(compactItem.label.startsWith('✓'), mode, 'tray reflects current mode');
  }
  app.window.hide();
  app.setCompact(false);
  assert.equal(app.window.isVisible(), false, 'hidden widget stays hidden across a mode change');
  for (const show of [app.tray.events.get('click'), app.tray.menu[0].click, app.events.get('second-instance')]) {
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
const wayland = boot(false, { wayland: true });
wayland.window.size = [760, 619];
wayland.fit(699);
assert.deepEqual(wayland.window.size, [760, 699], 'Wayland receives the required content height');
assert.deepEqual(wayland.window.outerSize, [804, 779], 'Wayland resize includes its actual 44x80 decorations');
wayland.fit(699);
assert.deepEqual(wayland.window.size, [760, 699], 'Wayland fitting remains stable');
console.log('window modes, taskbar visibility, tray recovery, and content fitting OK');
