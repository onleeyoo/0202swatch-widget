const { contextBridge, ipcRenderer } = require("electron");
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld("sw", {
  pick: inv("pick"), reload: inv("reload"), openPalette: inv("open-palette"), closePalette: inv("close-palette"),
  menu: inv("menu"), langMenu: inv("lang-menu"), setLang: inv("set-lang"),
  moveBy: inv("move-by"), dragEnd: inv("drag-end"), copy: inv("copy"), state: inv("state"),
  storeGet: inv("store-get"), storeSet: inv("store-set"), recentRemove: inv("recent-remove"),
  exportMenu: inv("export-menu"), importMenu: inv("import-menu"), diag: inv("diag"),
  projectMenu: inv("project-menu"), savePreset: inv("save-preset"), captureRegion: inv("capture-region"),
  setCurrent: inv("set-current"), addRecent: inv("add-recent"), overlayDone: inv("overlay-done"), log: inv("log"), focusSelf: inv("focus-self"), keyGet: inv("key-get"), presetsGet: inv("presets-get"), growBy: inv("grow-by"), growAnim: inv("grow-anim"), keyLabel: inv("key-label"), keySet: inv("key-set"), keyClose: inv("key-close"), rendererReady: inv("renderer-ready"), subjectMask: inv("subject-mask"),
  on: (ch, fn) => ipcRenderer.on(ch, (e, d) => fn(d))
});
