const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("strata", {
  platform: process.platform,
  getState: () => ipcRenderer.invoke("get-state"),
  setSetting: (key, value) => ipcRenderer.invoke("set-setting", key, value),
  refresh: () => ipcRenderer.invoke("refresh"),
  addServer: () => ipcRenderer.invoke("server:add"),
  removeServer: () => ipcRenderer.invoke("server:remove"),
  minimize: () => ipcRenderer.send("win:minimize"),
  close: () => ipcRenderer.send("win:close"),
  resetSize: () => ipcRenderer.send("win:reset-size"),
  fitContent: (height, width) => ipcRenderer.send("win:fit-content", height, width),
  settingsHeight: (open) => ipcRenderer.send("win:settings-height", Boolean(open)),
  onMetrics: (cb) => ipcRenderer.on("metrics", (_e, p) => cb(p)),
  onSettings: (cb) => ipcRenderer.on("settings", (_e, s) => cb(s)),
  onOpenSettings: (cb) => ipcRenderer.on("open-settings", () => cb()),
});
