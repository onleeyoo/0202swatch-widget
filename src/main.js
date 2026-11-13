/* 0202Swatch widget - a floating bubble that picks a color from anywhere on screen.
   Shares its color list with the 0202Swatch Premiere panel (same projects.json).
   Runs on macOS and Windows. Code updates arrive in the background (see boot.js / checkUpdate). */
const { app, BrowserWindow, ipcMain, clipboard, globalShortcut, Menu, Tray, nativeImage, screen, dialog, desktopCapturer } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const { execFile } = require("child_process");
const share = require("./share.js");

if (!app.requestSingleInstanceLock()) { app.quit(); }

const IS_MAC = process.platform === "darwin", IS_WIN = process.platform === "win32";
const DATA_DIR = path.join(app.getPath("appData"), "0202Swatch");   /* same folder the Premiere panel uses */
const STORE = path.join(DATA_DIR, "projects.json");
const WSTATE = path.join(DATA_DIR, "widget.json");
const LOG = path.join(DATA_DIR, "widget-log.txt");
const CACHE = path.join(DATA_DIR, "app-cache");
const DEFAULT_KEY = "Alt+CommandOrControl+C";
let PICK_KEY = DEFAULT_KEY;
const BUBBLE = 76;
const SRC = global.__0202SRC__ || { kind: "bundled", dir: __dirname };
const CODE_VER = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8")).v; } catch (e) { return app.getVersion(); } })();
/* where new versions are published (public build repo); first that answers wins */
const UPDATE_BASES = ["https://onleeyoo.github.io/0202swatch-widget/", "https://cdn.jsdelivr.net/gh/onleeyoo/0202swatch-widget@main/"];

function tmpFile(name) {
  for (const d of [os.tmpdir(), path.join(DATA_DIR, "tmp")]) {
    try { mkdir(d); const f = path.join(d, name); fs.writeFileSync(f, ""); return f; } catch (e) {}
  }
  return path.join(os.tmpdir(), name);
}
let widget = null, palette = null, tray = null, picking = false, statusMsg = { msg: "", err: false };
let state = { x: null, y: null, last: "#FFE400", recent: [], onTop: true, lang: null };

function mkdir(d) { try { fs.mkdirSync(d || DATA_DIR, { recursive: true }); } catch (e) {} }
function log(m) {
  const line = new Date().toISOString() + " " + m + "\n";
  try { mkdir(); fs.appendFileSync(LOG, line); } catch (e) {}
  /* dev machine: also next to the code, so problems can be read without asking */
  if (SRC.kind === "dev") { try { fs.appendFileSync(path.join(SRC.dir, "..", "_log.txt"), line); } catch (e) {} }
}
function loadState() { try { Object.assign(state, JSON.parse(fs.readFileSync(WSTATE, "utf8"))); } catch (e) {} }
function saveState() { mkdir(); try { writeAtomic(WSTATE, JSON.stringify(state)); } catch (e) {} }

/* ---------- language ---------- */
function lang() {
  if (state.lang === "ko" || state.lang === "en" || state.lang === "ja") return state.lang;
  const l = (app.getLocale() || "").toLowerCase();
  return l.indexOf("ko") === 0 ? "ko" : l.indexOf("ja") === 0 ? "ja" : "en";
}
function T(ko, en, ja) { const l = lang(); return l === "ko" ? ko : l === "ja" ? (ja || en) : en; }
function keyLabel(acc) {
  const parts = String(acc || PICK_KEY).split("+"), key = parts.pop(), m = {};
  parts.forEach((x) => { if (x === "CommandOrControl" || x === "CmdOrCtrl") m[IS_MAC ? "cmd" : "ctrl"] = 1; else if (x === "Command" || x === "Cmd" || x === "Meta" || x === "Super") m[IS_MAC ? "cmd" : "win"] = 1; else if (x === "Control" || x === "Ctrl") m.ctrl = 1; else if (x === "Alt" || x === "Option") m.alt = 1; else if (x === "Shift") m.shift = 1; });
  if (IS_MAC) return (m.ctrl ? "⌃" : "") + (m.alt ? "⌥" : "") + (m.shift ? "⇧" : "") + (m.cmd ? "⌘" : "") + key;
  return [m.ctrl && "Ctrl", m.alt && "Alt", m.shift && "Shift", m.win && "Win", key].filter(Boolean).join("+");
}
/* change the pick shortcut; keeps the old one if the new one can't be registered */
function setPickKey(acc) {
  const old = PICK_KEY;
  try { globalShortcut.unregister(old); } catch (e) {}
  let ok = false; try { ok = globalShortcut.register(acc, pick); } catch (e) {}
  if (!ok) { try { globalShortcut.register(old, pick); } catch (e) {} log("shortcut refused " + acc); return false; }
  PICK_KEY = acc; state.pickKey = acc === DEFAULT_KEY ? null : acc; saveState();
  rebuildTray(); send("key", keyLabel()); log("shortcut -> " + acc);
  return true;
}
let keyWin = null;
function openKeyWin() {
  if (keyWin && !keyWin.isDestroyed()) { keyWin.show(); keyWin.focus(); return; }
  try { globalShortcut.unregister(PICK_KEY); } catch (e) {}   /* so the current combo can be typed too */
  const d = screen.getDisplayMatching(widget ? widget.getBounds() : { x: 0, y: 0, width: 1, height: 1 }).workArea, W = 340, H = 210;
  keyWin = new BrowserWindow({ x: Math.round(d.x + (d.width - W) / 2), y: Math.round(d.y + (d.height - H) / 3), width: W, height: H, show: false, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, backgroundColor: "#141019", roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false } });
  keyWin.setAlwaysOnTop(true, "floating");
  hookLogs(keyWin, "keycap");
  keyWin.loadFile(path.join(__dirname, "keycap.html"));
  keyWin.once("ready-to-show", () => { keyWin.show(); if (IS_MAC) app.focus({ steal: true }); keyWin.focus(); });
  keyWin.on("closed", () => { keyWin = null; try { if (!globalShortcut.isRegistered(PICK_KEY)) globalShortcut.register(PICK_KEY, pick); } catch (e) {} });
}

function status(msg, err) { statusMsg = { msg, err: !!err }; send("status", statusMsg); if (err) log("STATUS " + msg); }
function send(ch, data) { [widget, palette].forEach(w => { if (w && !w.isDestroyed()) w.webContents.send(ch, data); }); }
function hookLogs(w, name) {
  w.webContents.on("console-message", (e, level, msg, line) => { if (level >= 2) log(name + " JS " + msg + " @" + line); });
  w.webContents.on("preload-error", (e, p, err) => log(name + " PRELOAD " + err));
  w.webContents.on("render-process-gone", (e, d) => log(name + " GONE " + d.reason));
  w.webContents.on("unresponsive", () => log(name + " UNRESPONSIVE"));
  /* a drop or a stray link must never navigate the window away (that looked like the panel closing) */
  w.webContents.on("will-navigate", (e, url) => { log(name + " blocked navigate " + String(url).slice(0, 80)); e.preventDefault(); });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.on("closed", () => log(name + " closed"));
}

/* ---------- color list (shared with the Premiere panel) ---------- */
/* older builds created the developer's own folder names on a fresh install -> remove them on other computers (only if still empty) */
const OLD_SEED = ["emart24", "0202PD", "PaulKim", "Sofy"];
function isDevMachine() { try { return fs.existsSync(path.join(require("os").homedir(), "workspace", "0202SwatchWidget")); } catch (e) { return false; } }
function cleanSeed(s) {
  if (!s || s.seedCleaned || !Array.isArray(s.projects) || isDevMachine()) return false;
  const empty = p => !(p.groups || []).some(g => g.colors && g.colors.length);
  const before = s.projects.length;
  s.projects = s.projects.filter(p => !(OLD_SEED.includes(p.name) && empty(p)));
  if (!s.projects.length) s.projects = [{ key: "w" + Date.now().toString(36), name: T("내 프로젝트", "My project", "マイプロジェクト"), groups: [] }];
  s.seedCleaned = true;
  log("store: removed " + (before - s.projects.length) + " old default folders");
  return true;
}
function readStore() {
  for (const f of [STORE, STORE + ".bak"]) {
    try { const s = JSON.parse(fs.readFileSync(f, "utf8")); if (s && Array.isArray(s.projects)) { if (f !== STORE) log("store: main file broken, using backup"); if (cleanSeed(s)) { try { writeAtomic(STORE, JSON.stringify(s)); } catch (e) {} } return s; } } catch (e) {}
  }
  if (fs.existsSync(STORE)) { try { fs.copyFileSync(STORE, STORE + ".broken-" + Date.now()); } catch (e) {} log("store: unreadable, kept a copy"); }
  return { v: 3, projects: [{ key: "w" + Date.now().toString(36), name: T("내 프로젝트", "My project", "マイプロジェクト"), groups: [] }], seeded: true, migratedMine: true, seedCleaned: true };
}
let ownWrite = 0;
function writeAtomic(f, data) {   /* write to a temp file then rename: a crash mid-write can't leave half a file */
  const tmp = f + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, data);
  try { if (fs.existsSync(f)) fs.copyFileSync(f, f + ".bak"); } catch (e) {}
  fs.renameSync(tmp, f);
}
function writeStore(s) { mkdir(); try { if (!s || !Array.isArray(s.projects)) throw new Error("bad store"); ownWrite = Date.now(); writeAtomic(STORE, JSON.stringify(s)); return true; } catch (e) { status(T("색 목록을 저장하지 못했어요", "Couldn't save the color list", "保存できませんでした"), true); return false; } }

/* ---------- picking ---------- */
/* macOS: the system color sampler (magnifier loupe, over every app, no screen-recording permission).
   Windows (and mac fallback): our own full-screen overlay with a magnifier on a screenshot of every display. */
const SAMPLER_JXA = [
  "ObjC.import('AppKit');",
  "var app = $.NSApplication.sharedApplication; app.setActivationPolicy(1);",
  "function out(s) { $.NSFileHandle.fileHandleWithStandardOutput.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding)); }",
  "var sampler = $.NSColorSampler.alloc.init;",
  "sampler.showSamplerWithSelectionHandler(function (c) {",
  "  try { if (!c || (c.isNil && c.isNil())) out('CANCEL');",
  "  else { var x = c.colorUsingColorSpace($.NSColorSpace.sRGBColorSpace);",
  "    out('RGB ' + Math.round(x.redComponent * 255) + ' ' + Math.round(x.greenComponent * 255) + ' ' + Math.round(x.blueComponent * 255)); } }",
  "  catch (e) { out('ERR ' + e); }",
  "  app.terminate(null);",
  "});",
  "app.activateIgnoringOtherApps(true);",
  "app.run;"
].join("\n");
function hex2(n) { n = Math.max(0, Math.min(255, Math.round(n))).toString(16); return n.length < 2 ? "0" + n : n; }
let samplerProc = null;
function macSampler() {
  return new Promise((resolve, reject) => {
    mkdir();
    const f = path.join(DATA_DIR, "sampler.js");
    try { fs.writeFileSync(f, SAMPLER_JXA); } catch (e) { return reject(e); }
    samplerProc = execFile("/usr/bin/osascript", ["-l", "JavaScript", f], { timeout: 60000 }, (err, out) => {
      samplerProc = null;
      out = String(out || "").trim();
      log("sampler -> " + out + (err ? " ERR " + err.message : ""));
      const m = out.match(/^RGB (\d+) (\d+) (\d+)/);
      if (m) return resolve("#" + (hex2(+m[1]) + hex2(+m[2]) + hex2(+m[3])).toUpperCase());
      if (out === "CANCEL" || (err && err.killed)) return resolve(null);
      reject(new Error(out || (err && err.message) || "sampler"));
    });
  });
}
let overlayDone = null;
async function overlayPick() {
  const displays = screen.getAllDisplays();
  let W = 0, H = 0;
  displays.forEach(d => { W = Math.max(W, Math.round(d.size.width * d.scaleFactor)); H = Math.max(H, Math.round(d.size.height * d.scaleFactor)); });
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: W, height: H } });
  return new Promise(resolve => {
    const wins = [], files = [];
    let done = false;
    const finish = (hex) => {
      if (done) return; done = true; overlayDone = null;
      wins.forEach(w => { if (!w.isDestroyed()) w.close(); });
      setTimeout(() => files.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} }), 500);
      resolve(hex);
    };
    overlayDone = finish;
    displays.forEach((d, i) => {
      const src = sources.find(s => String(s.display_id) === String(d.id)) || sources[i] || sources[0];
      if (!src || src.thumbnail.isEmpty()) return;
      const file = tmpFile("0202swatch_screen_" + d.id + "_" + Date.now() + ".png");
      try { fs.writeFileSync(file, src.thumbnail.toPNG()); files.push(file); } catch (e) { return; }
      const w = new BrowserWindow({
        x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
        frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        alwaysOnTop: true, skipTaskbar: true, hasShadow: false, enableLargerThanScreen: true, show: false, backgroundColor: "#000000",
        webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
      });
      w.setAlwaysOnTop(true, "screen-saver");
      if (IS_MAC) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      hookLogs(w, "overlay");
      w.loadFile(path.join(__dirname, "overlay.html"), { query: { img: file, lang: lang() } });
      w.once("ready-to-show", () => { w.show(); if (i === 0) w.focus(); });
      w.on("closed", () => { if (!done) finish(null); });
      wins.push(w);
    });
    if (!wins.length) {
      log("overlay: no screen image (sources " + sources.length + ")");
      status(IS_MAC ? T("화면을 캡처하지 못했어요 · 시스템 설정 → 개인정보 보호 → 화면 기록에서 0202Swatch 허용", "Couldn't capture the screen · allow 0202Swatch in Screen Recording settings", "画面をキャプチャできません")
                    : T("화면을 캡처하지 못했어요 · 여기를 누르면 진단 정보 복사", "Couldn't capture the screen · click to copy diagnostics", "画面をキャプチャできません"), true);
      finish(null);
    }
  });
}
async function pick() {
  if (picking) { if (samplerProc) { try { samplerProc.kill(); } catch (e) {} } return; }   /* second click = cancel */
  picking = true; send("picking", true);
  let hex = null;
  try {
    if (IS_MAC) { try { hex = await macSampler(); } catch (e) { log("sampler failed, overlay: " + e.message); hex = await overlayPick(); } }
    else hex = await overlayPick();
  } catch (e) { log("pick failed " + e.stack); status(T("색을 뽑지 못했어요 · 여기를 누르면 진단 정보 복사", "Couldn't pick a color · click to copy diagnostics", "色を取得できませんでした · クリックで診断情報をコピー"), true); }
  picking = false; send("picking", false);
  if (hex) gotColor(hex);
  return hex || null;   /* the palette's ＋ cell uses this to drop the color into a project */
}
/* small "copied" bubble above the widget, so it shows even when the palette is closed */
let toastWin = null, toastHide = null;
function showCopied(hex) {
  if (!widget || !widget.isVisible() || (palette && !palette.isDestroyed() && palette.isVisible())) return;
  const W = 170, H = 40, b = widget.getBounds(), wa = screen.getDisplayMatching(b).workArea;
  let x = Math.round(b.x + b.width / 2 - W / 2), y = b.y - H + 6;
  if (y < wa.y) y = b.y + b.height - 6;
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - W));
  const show = () => {
    toastWin.setBounds({ x, y, width: W, height: H });
    toastWin.showInactive();
    toastWin.webContents.send("toast-show", { hex, msg: T("복사됨", "copied", "コピー") });
    clearTimeout(toastHide); toastHide = setTimeout(() => { if (toastWin && !toastWin.isDestroyed()) toastWin.hide(); }, 1800);
  };
  if (toastWin && !toastWin.isDestroyed()) return show();
  toastWin = new BrowserWindow({
    x, y, width: W, height: H, frame: false, transparent: true, resizable: false, movable: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  toastWin.setAlwaysOnTop(true, "floating");
  toastWin.setIgnoreMouseEvents(true);
  if (IS_MAC) toastWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hookLogs(toastWin, "toast");
  toastWin.loadFile(path.join(__dirname, "toast.html"));
  toastWin.webContents.once("did-finish-load", show);
  toastWin.on("closed", () => { toastWin = null; });
}
function gotColor(hex) {
  hex = String(hex).toUpperCase();
  clipboard.writeText(hex.slice(1));
  state.last = hex;
  state.recent = [hex].concat(state.recent.filter(h => String(h).toUpperCase() !== hex)).slice(0, 50);   /* keep 50, oldest drop off */
  saveState();
  send("picked", hex);
  showCopied(hex);
  rebuildTray();
}

/* ---------- windows ---------- */
function defaultPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - BUBBLE - 24, y: wa.y + wa.height - BUBBLE - 120 };
}
function onScreen(x, y) {
  return screen.getAllDisplays().some(d => x >= d.bounds.x - 20 && y >= d.bounds.y - 20 && x < d.bounds.x + d.bounds.width - 20 && y < d.bounds.y + d.bounds.height - 20);
}
function createWidget() {
  const p = state.x === null || !onScreen(state.x, state.y) ? defaultPos() : { x: state.x, y: state.y };
  widget = new BrowserWindow({
    x: p.x, y: p.y, width: BUBBLE, height: BUBBLE,
    frame: false, transparent: true, resizable: false, movable: true, minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: state.onTop, skipTaskbar: true, hasShadow: false, acceptFirstMouse: true, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  widget.setAlwaysOnTop(state.onTop, "floating");
  if (IS_MAC) widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hookLogs(widget, "widget");
  widget.loadFile(path.join(__dirname, "widget.html"), { query: { lang: lang() } });
  widget.once("ready-to-show", () => { if (!state.widgetHidden) widget.showInactive(); });   /* stays hidden after restart if the user hid it */
}
function openPalette() {
  if (palette && !palette.isDestroyed()) { palette.show(); if (IS_MAC) app.focus({ steal: true }); palette.focus(); return; }
  const b = widget.getBounds(), wa = screen.getDisplayMatching(b).workArea, W = 344, H = Math.min(746, wa.height - 16);
  let x = b.x + b.width - W, y = b.y - H - 8;
  if (y < wa.y) y = b.y + b.height + 8;
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - W - 8));
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - H - 8));
  const glass = IS_MAC ? { transparent: true, backgroundColor: "#00000000", vibrancy: "under-window", visualEffectState: "active" } : { backgroundColor: "#0e0b14" };
  palette = new BrowserWindow(Object.assign({
    x, y, width: W, height: H, minWidth: 260, minHeight: 360, show: false,
    frame: false, alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  }, glass));
  palette.setAlwaysOnTop(true, "floating");
  if (IS_MAC) palette.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hookLogs(palette, "palette");
  palette.webContents.on("before-mouse-event", (ev, m) => { if (m.type === "mouseDown" || m.type === "mouseUp") log("main mouse " + m.type + " " + m.button + " focused=" + palette.isFocused()); });
  palette.webContents.on("context-menu", (ev, p) => log("main context-menu " + p.x + "," + p.y));
  palette.loadFile(path.join(__dirname, "palette.html"), { query: { glass: IS_MAC ? "1" : "0" } });
  palette.once("ready-to-show", () => { palette.show(); if (IS_MAC) app.focus({ steal: true }); palette.focus(); });
  palette.on("closed", () => { palette = null; });
}
/* ↻: look for a newer version first, so one press always ends on the latest code */
async function reloadApp() {
  log("reload");
  if (SRC.kind !== "dev") { status(T("새 버전 확인 중…", "Checking for updates…", "更新を確認中…")); try { await Promise.race([checkUpdate(), new Promise(r => setTimeout(r, 60000))]); } catch (e) {} }
  app.relaunch(); app.exit(0);
}

/* ---------- menus ---------- */
function menuTemplate() {
  return [
    { label: T("색 뽑기", "Pick a color", "色を取る"), accelerator: PICK_KEY, click: pick },
    { label: T("팔레트 열기", "Open palette", "パレットを開く"), click: openPalette },
    { label: T("최근 색", "Recent colors", "最近の色"), enabled: state.recent.length > 0, submenu: state.recent.slice(0, 15).map(h => ({ label: h + "  " + T("복사", "copy", "コピー"), click: () => gotColor(h) })) },
    { type: "separator" },
    { label: T("위젯 보이기", "Show widget", "ウィジェットを表示"), type: "checkbox", checked: !!(widget && widget.isVisible()), click: (i) => { state.widgetHidden = !i.checked; saveState(); if (i.checked) widget.showInactive(); else widget.hide(); } },
    { label: T("항상 위에", "Always on top", "常に手前"), type: "checkbox", checked: state.onTop, click: (i) => { state.onTop = i.checked; widget.setAlwaysOnTop(i.checked, "floating"); saveState(); } },
    { label: T("로그인할 때 자동 실행", "Open at login", "ログイン時に起動"), type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: T("언어 / Language", "Language / 언어", "言語 / Language"), submenu: [["ko", "한국어"], ["en", "English"], ["ja", "日本語"]].map(([k, n]) => ({ label: n, type: "radio", checked: lang() === k, click: () => setLang(k) })) },
    { label: T("단축키 변경…", "Change shortcut…", "ショートカットを変更…") + "   " + keyLabel(), click: openKeyWin },
    { label: T("위젯 위치 초기화", "Reset widget position", "位置をリセット"), click: () => { const p = defaultPos(); widget.setPosition(p.x, p.y); state.x = p.x; state.y = p.y; saveState(); } },
    { label: T("새로고침 (업데이트 반영)", "Reload (apply updates)", "再読み込み（更新を反映）"), click: reloadApp },
    { type: "separator" },
    { label: T("종료", "Quit", "終了"), role: "quit" }
  ];
}
function setLang(l) { state.lang = l; saveState(); send("lang", l); rebuildTray(); }
function trayIcon() {
  /* eyedropper: black template on mac (follows the menu bar colour), white on a purple circle on Windows */
  const MAC = "iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAC6klEQVR4AeyYS8gOURjHX7dCLim5hBQLCQullEshuSa3srKwkI2djViIDTZiY2WFUhauuSe3XJI1JSTllthIIdff7+ubmt7vm5kz40xvar7+v3lm5pwzz/973jPznnn7tv6zv8Zw3R9YU+Gmwm0VaKZEW0HyDqfQuBm2wwroB4XqVIW34ewxHIH9cBFuwijIVScM78HRAWiv6HzOnYJcT7mNDI6tHVxwF2RpHg2zIVN1GR5Dxo3g/NxAHApOg73EIk3L61CH4aUkfALHwfl5kvgZnAaEQn3M6xHbsNU5Q8IRUEXfGfQQMhXb8FYyDYKq2sLAd5Cp2IanZ2YqbthJl2OQq9iGP+Vmy27cTdM+KFRsw3cKM/bsoFGfzT1bejkT2/BTcvyBUP2k42EIVkzDS8h6FvpAqPrT0ccgIUyxDC8m3TkYAOoDm/sQoskhnZI+MQwv4mLnYSAozfoVu4CDa1Ckl0Ud0u3/anghF7sAybP3Lftz4RkMhwmQpy80XoFgZRoOuIJVTJt9w5g58BxGw12YCsqby5jmKweuM14Tg1XVsGavkmUwqFdsrKxRs85fF+icbn1j4yexnngUHHeQOAMuQylVMezyz6S9mR1Hds1OIirNrmTHap8mboJl4MrtBbG0yhrW7HWytJt1Omj2Hm3tZm9wLprKGJ5FVs0OISor5DTQ7HhOaHYiUf1gswaimuV6rTKGDzEgMeuN5SuNZjX5gDYjoaXZ1ew4bQhxVcbwyFTqVey7DPTjd35aYU51mV3LTumbiTFBKmM4fcGZHCwHFzuJ2V8crwPfgAn1KNSw/camLJxg/xJ4oxFaiVmfyx7XhkZCLu7zc1hGR836jPXrOaNLvNMhhq2ib8BJ1vfs3O7mFtGngQsfdutXiGGfBI+6rTgV/Adc2IjfYLVPg+7cXSHEsB397UuDVvq3JzpFqGF/K3AalHmbqOV/CjVcS/IqF20MV6lamTFNhctUq0rfpsJVqlZmzF8AAAD//2M2G0YAAAAGSURBVAMAZkBvWShn0EkAAAAASUVORK5CYII=";
  const WIN = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAEzElEQVR4AayWfWjVVRjHP+d3t6llrlcqc1jQi4UZWLhSlkTanLvbKisCLZrpDMxeoFp7o9FeQiiwwF6dNXBWf5hpmzYxF2WCYaAhhIozS3ElZVaac9s9Pc/v3M3d7f7u7t0cv+f8znlevs/3POc5vzuPFP+q8+yEirAtqAzbYnm/pBKdF6gtRTiSIlA6y2aW59sSSfRNV4hfjGEjhtXyXq4SnW9Um/qor8YkQyYhgepce6kA1qeN5rDn8Z4kyjFGxgBk32bIUV+NqSywtYoR4O6rAwlU5NvpXRnsl3RlApzpe6cwRGMqFEOxgkLjEpBznW882gxcFhSYrF4xFEsx48UMIiAlLxb2a8Q5Q2TYz6RpML1IdjDeh8hQzPKwXeSv+g0xBKrC9i6LnHU/h1SnGaNhYR3Mr4S8J+GZlTD1Xoci1Xi7qtDOcCs39hFYlmdHRQyfCtN0Z0p9TB8FT9TAdbeei/VCULgUxl4Mih2J0KS5iP71EcgMUSYMs6L6pF4KevtsyJ4Ll18Dj78CWTcNDg2lwfjrnV5ITBwX4nm3Ap9ARZHNktK/3KtM5j0pG15YDfcvg/BT8Ow7cO3k4MjTf5+zGSirmGsnqsYnYCIsFWZSQFUNLXLPmfcc6M6G9oZf98HRA/08DePkZhSrxieAZY4ukpXMK2D0hcl5Hz8Ca+vBSokHRPg5vfJce7XYpgwwJlye+A3+7Ejo4hs7DsGqUvj3hL+MGSTnNP3t8LwQt0n5TYw1iUX7nsROZ07B+rfg9D/x/TRnt2GyFwlxVXyXYO3MR+CO3GC7WvSIcubpLFg0t2dsagRmPwazFjjQnZtg3QqZSz1lHPT0dA1SxSg0t2vCGHXwYo707d0PO/uODdD8LqTpZyvOAcoHh+/Ex3kHjJYznjUk0U6QXwIzHnBA29fD5gY5hvugSL5yqtVr1tWpM+jplvN/E461u3XQ6EGH5/UMTUCT3Bl2MJq89UPIzpfkTzvdgR/g/RfhValOVSFUPwi725wt0aib99Ise+WOBpyiJJEd9jbcV2tBk2slwksctCZvkh8fLbnTJDdqzkgX+7zqzeaIHOH38cKmzJQyR7u99SP4+hPQG6C9oP77d4Em15LrOhXRnPWt5pgcgx/2pT8OGMaMdYr2H2H7Z677e2+A7ly/cMNJrqhS8s/17QgYGpGOVEV/GXuJW2VNgiWvu92r5uBu/M/rsJNbOonwsWL5BGq/MIcwSN+qysmYi6C38dIzYMKNTn9QvoBraqB7iDvuvOOP8hVcUbfJHFarT0AnXf/xmjTGSZ2rXDlRfnAuAL1au1qhTfhuaYSRJpccx9O6qdccKn0Elm81J43lIXHw9/bzXimzdPcbi2HDStgmBL5dJzs/q2HDFEu3MTwqjd/330EfAYWsbTFbpRckpa7gp51w6i83Px+jbLBYjntbf6wYAmqoazGNUoUFMh/JXiU85jmrmDUtRv/bjjEMIqDWumbTZCPcI1flD12PRBRDsRQzHk5cAuooldiR3sktciQfyDoikuoTkV2vUgzFCgoOJKAB1VvM77XNpkTObqqsGwTwqLwTPlGfBo2RXS9WjEQBCQn0BtY0mz3SPIsEcEIP3CxJCqUyC+VdqhKdF3YbblAf9dUYjR9K/gcAAP//f7j5QwAAAAZJREFUAwBl640Ui9phZQAAAABJRU5ErkJggg==";
  const img = nativeImage.createFromBuffer(Buffer.from(IS_MAC ? MAC : WIN, "base64"), { scaleFactor: 2 });
  if (IS_MAC) img.setTemplateImage(true);
  return img;
}
function rebuildTray() { if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate())); }

/* ---------- export / import ---------- */
/* render the color-chip card offscreen -> nativeImage */
async function chipImage(p, gs) {
  const w = new BrowserWindow({ show: false, width: 1080, height: 800, useContentSize: true, transparent: true, backgroundColor: "#00000000", frame: false, webPreferences: { offscreen: true, javascript: true } });
  try {
    await w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(share.chipHtml(p.name, gs, T("화면 어디서든 색 뽑기", "Pick colors anywhere", "どこでも色を抽出"))));
    const h = await w.webContents.executeJavaScript("document.documentElement.scrollHeight");
    w.setContentSize(1080, Math.ceil(h));
    await new Promise(r => setTimeout(r, 250));
    return await w.webContents.capturePage({ x: 0, y: 0, width: 1080, height: Math.ceil(h) });
  } finally { w.destroy(); }
}
function exportMenu(p) {
  const gs = share.liveGroups(p);
  if (!gs.length) { status(T("'" + p.name + "'에 내보낼 색이 없어요", "'" + p.name + "' has no colors to export", "エクスポートする色がありません")); return; }
  const win = palette || widget;
  const saveAs = async (ext, filterName, data) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("desktop"), share.safeName(p.name) + "." + ext), filters: [{ name: filterName, extensions: [ext] }] });
    if (r.canceled || !r.filePath) return;
    try { fs.writeFileSync(r.filePath, data); status(T("저장했어요 · ", "Saved · ", "保存しました · ") + path.basename(r.filePath)); }
    catch (e) { status(T("저장하지 못했어요 · ", "Couldn't save · ", "保存できませんでした · ") + e.message, true); }
  };
  const imgShare = async (save) => {
    try {
      status(T("이미지를 만드는 중…", "Making image…", "画像を作成中…"));
      const img = await chipImage(p, gs);
      if (!save) { clipboard.writeImage(img); status(T("컬러칩 이미지를 복사했어요 · 카톡·슬랙에 붙여넣기", "Color chip image copied · paste in chat", "カラーチップ画像をコピーしました")); return; }
      await saveAs("png", "PNG", img.toPNG());
    } catch (e) { log("chip " + e.message); status(T("이미지를 만들지 못했어요 · ", "Couldn't make the image · ", "画像を作成できませんでした · ") + e.message, true); }
  };
  Menu.buildFromTemplate([
    { label: T("이미지로 공유 (컬러칩 복사)", "Share as image (copy color chips)", "画像で共有 (カラーチップをコピー)"), click: () => imgShare(false) },
    { label: T("이미지로 저장 (.png)", "Save as image (.png)", "画像で保存 (.png)"), click: () => imgShare(true) },
    { type: "separator" },
    { label: T("공유 코드 복사 (카톡·슬랙에 붙여넣기)", "Copy share code (paste in chat)", "共有コードをコピー"), click: () => { clipboard.writeText(share.toCode(gs, p.name)); status(T("공유 코드를 복사했어요 · 팀원은 불러오기 → 코드 붙여넣기", "Share code copied · teammates use Import → paste", "共有コードをコピーしました")); } },
    { label: T("파일로 저장 (.0202swatch)", "Save as file (.0202swatch)", "ファイルで保存 (.0202swatch)"), click: () => saveAs("0202swatch", "0202Swatch", JSON.stringify({ app: "0202Swatch", v: 1, project: p.name, groups: gs }, null, 1)) },
    { label: T("포토샵 스와치로 저장 (.aco)", "Save as Photoshop swatches (.aco)", "Photoshop スウォッチで保存 (.aco)"), click: () => saveAs("aco", "Photoshop Swatches", share.acoEncode(gs)) },
    { label: T("ASE로 저장 (일러스트레이터·AE 스와치)", "Save as .ase (Illustrator / AE)", ".ase で保存"), click: () => saveAs("ase", "Adobe Swatch Exchange", share.aseEncode(gs)) }
  ]).popup({ window: win });
}
function presets() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "presets.json"), "utf8")); } catch (e) { return []; } }
function presetName(p) { return (p.names && p.names[lang()]) || p.name; }
function importMenu() {
  const win = palette || widget;
  return new Promise(resolve => {
    let done = false, chosen = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };
    Menu.buildFromTemplate([
      { label: T("복사한 공유 코드 붙여넣기", "Paste a copied share code", "コピーした共有コードを貼り付け"), click: () => { chosen = true;
        const gs = share.parseText(clipboard.readText(), T("가져온 색", "Imported", "読み込んだ色"));
        if (!gs || !gs.length) { status(T("클립보드에 공유 코드나 HEX가 없어요", "No share code or HEX on the clipboard", "クリップボードにコードがありません")); return fin(null); }
        fin({ name: gs.project || (gs.length === 1 ? gs[0].name : T("가져온 색", "Imported", "読み込んだ色")), groups: gs });
      } },
      { type: "separator" },
      { label: T("파일 열기 (.0202swatch · .aco · .ase)", "Open file (.0202swatch, .aco, .ase)", "ファイルを開く"), click: async () => { chosen = true;
        const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"], filters: [{ name: "Swatches", extensions: ["0202swatch", "aco", "ase", "json", "txt"] }] });
        if (r.canceled || !r.filePaths.length) return fin(null);
        const out = [];
        r.filePaths.forEach(f => {
          const nm = path.basename(f).replace(/\.[^.]+$/, "");
          try {
            const buf = fs.readFileSync(f);
            let gs = null, pname = nm;
            if (/\.ase$/i.test(f)) gs = share.aseDecode(buf, nm);
            else if (/\.aco$/i.test(f)) gs = share.acoDecode(buf, nm);
            else { const t = buf.toString("utf8"); try { const j = JSON.parse(t); if (j.project) pname = j.project; } catch (e) {} gs = share.parseText(t, nm); }
            if (gs && gs.length) out.push({ name: pname, groups: gs });
          } catch (e) { log("import " + f + " " + e.message); }
        });
        if (!out.length) { status(T("읽을 수 있는 색이 없어요", "No colors found in that file", "色が見つかりません"), true); return fin(null); }
        fin(out.length === 1 ? out[0] : { many: out });
      } }
    ]).popup({ window: win, callback: () => setTimeout(() => { if (!chosen) fin(null); }, 600) });
  });
}

function projectMenu(p) {
  const win = palette || widget;
  return new Promise(resolve => {
    let chosen = false;
    const pickA = (a) => () => { chosen = true; resolve(a); };
    const items = [
      { label: T("이름 바꾸기", "Rename", "名前を変更"), click: pickA("rename") },
      { label: p.fav ? T("즐겨찾기 해제", "Remove from favorites", "お気に入り解除") : T("★ 즐겨찾기", "★ Favorite", "★ お気に入り"), click: pickA("fav") },
      { label: p.hidden ? T("다시 보이기", "Show again", "再表示") : T("숨기기 (숨긴 프로젝트로 이동)", "Hide (move to hidden)", "非表示"), click: pickA("hide") },
      { type: "separator" },
      { label: T("공유 · 내보내기…", "Share / export…", "共有・エクスポート…"), enabled: !!p.count, click: pickA("export") },
      { label: T("복제", "Duplicate", "複製"), click: pickA("dup") }
    ];
    if (SRC.kind === "dev") items.push({ label: T("0202 기본 프리셋으로 등록 (개발자)", "Save as a 0202 preset (dev)", "0202 プリセットに登録（開発）"), enabled: !!p.count, click: pickA("preset") });
    items.push({ type: "separator" }, { label: T("삭제", "Delete", "削除"), click: pickA("delete") });
    Menu.buildFromTemplate(items).popup({ window: win, callback: () => setTimeout(() => { if (!chosen) resolve(null); }, 300) });
  });
}
/* dev only: write a project into presets.json of the dev folder, so it ships to everyone with the next release */
function savePreset(p) {
  if (SRC.kind !== "dev") return false;
  const f = path.join(__dirname, "presets.json");
  let list = presets();
  const gs = share.liveGroups(p).map(g => ({ name: g.name, colors: g.colors.map(c => { const o = { h: c.h, n: c.n || "" }; if (c.o) o.o = c.o; return o; }) }));
  const name = /^0202 · /.test(p.name) ? p.name : "0202 · " + p.name;
  const i = list.findIndex(x => x.name === name || (x.names && Object.values(x.names).indexOf(name) >= 0));
  const entry = { name, names: { ko: name, en: name, ja: name }, groups: gs };
  if (i >= 0) { entry.names = list[i].names || entry.names; entry.names.ko = name; list[i] = entry; } else list.push(entry);
  try { fs.writeFileSync(f, JSON.stringify(list, null, 1)); send("presets", list); status(T("기본 프리셋에 등록했어요 · 다음 배포 때 모두에게 들어가요", "Saved as a preset · ships with the next release", "プリセットに登録しました")); return true; }
  catch (e) { status(T("프리셋 저장 실패 · ", "Couldn't save preset · ", "保存できませんでした · ") + e.message, true); return false; }
}
/* capture a region of the screen -> image data URL (mac: screencapture -i, Windows: Snipping tool + clipboard) */
function captureRegion() {
  return new Promise(resolve => {
    if (IS_MAC) {
      const f = tmpFile("0202swatch_cap_" + Date.now() + ".png"); try { fs.unlinkSync(f); } catch (e) {}
      execFile("/usr/sbin/screencapture", ["-i", "-x", f], { timeout: 120000 }, () => {
        try { if (fs.existsSync(f) && fs.statSync(f).size > 500) { const d = "data:image/png;base64," + fs.readFileSync(f).toString("base64"); fs.unlinkSync(f); return resolve(d); } } catch (e) {}
        resolve(null);
      });
      return;
    }
    if (IS_WIN) {
      const before = clipboard.readImage().toDataURL();
      execFile("explorer.exe", ["ms-screenclip:"], () => {});
      let n = 0;
      const t = setInterval(() => {
        n++;
        const img = clipboard.readImage();
        if (!img.isEmpty()) { const d = img.toDataURL(); if (d !== before) { clearInterval(t); return resolve(d); } }
        if (n > 120) { clearInterval(t); resolve(null); }
      }, 500);
      return;
    }
    resolve(null);
  });
}

/* ---------- diagnostics (bottom-left status, click to copy) ---------- */
function diag() {
  let tail = "";
  try { tail = fs.readFileSync(LOG, "utf8").split("\n").slice(-40).join("\n"); } catch (e) {}
  return [
    "0202Swatch widget " + CODE_VER + " (" + SRC.kind + ") app " + app.getVersion(),
    "electron " + process.versions.electron + " · " + process.platform + " " + process.arch + " · " + os.release(),
    "displays " + screen.getAllDisplays().map(d => d.size.width + "x" + d.size.height + "@" + d.scaleFactor).join(", "),
    "status " + statusMsg.msg,
    "---- log ----", tail
  ].join("\n");
}

/* ---------- updates: new code is downloaded in the background, used after ↻ / next start ---------- */
function cmpVer(a, b) {
  a = String(a || "0").split("."); b = String(b || "0").split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (+a[i] || 0) - (+b[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function get(url, hops) {
  return new Promise((resolve) => {
    const req = https.get(url + (url.indexOf("?") < 0 ? "?t=" + Date.now() : ""), { timeout: 10000, headers: { "User-Agent": "0202Swatch" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (hops || 0) < 3) { res.resume(); return resolve(get(res.headers.location, (hops || 0) + 1)); }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks))); res.on("error", () => resolve(null));
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
async function checkUpdate() {
  if (SRC.kind === "dev") return;
  for (const base of UPDATE_BASES) {
    const vb = await get(base + "version.json");
    if (!vb) continue;
    let remote; try { remote = JSON.parse(vb.toString("utf8")); } catch (e) { continue; }
    if (cmpVer(remote.v, CODE_VER) <= 0) return;
    if (remote.minApp && cmpVer(app.getVersion(), remote.minApp) < 0) {   /* needs a new installer (e.g. new Electron) */
      status(T("새 버전 v" + remote.v + "은 다시 설치해야 해요 · 배포 페이지에서 받아주세요", "v" + remote.v + " needs a reinstall", "v" + remote.v + " は再インストールが必要です"));
      return;
    }
    const lb = await get(base + "files.json");
    let list; try { list = JSON.parse(lb.toString("utf8")); } catch (e) { continue; }
    const tmp = CACHE + ".new"; rmrf(tmp); mkdir(tmp);
    let ok = true;
    for (const rel of list) {
      if (/(^|[\\/])\.\.([\\/]|$)/.test(rel) || path.isAbsolute(rel)) continue;
      const data = await get(base + "src/" + rel);
      if (!data) { ok = false; break; }
      mkdir(path.dirname(path.join(tmp, rel)));
      fs.writeFileSync(path.join(tmp, rel), data);
    }
    if (!ok) { rmrf(tmp); continue; }
    fs.writeFileSync(path.join(tmp, "version.json"), JSON.stringify({ v: remote.v }));
    fs.writeFileSync(path.join(tmp, "files.json"), JSON.stringify(list));
    rmrf(CACHE); fs.renameSync(tmp, CACHE);
    try { fs.unlinkSync(path.join(DATA_DIR, "bad-cache")); } catch (e) {}
    log("update downloaded " + remote.v);
    status(T("새 버전 v" + remote.v + " 받았어요 · ↻ 누르면 적용", "Update v" + remote.v + " ready · press ↻", "新バージョン v" + remote.v + " · ↻ で適用"));
    return;
  }
}

/* ---------- ipc ---------- */
ipcMain.handle("pick", () => pick());
ipcMain.handle("reload", () => reloadApp());
ipcMain.handle("open-palette", () => openPalette());
ipcMain.handle("close-palette", () => { log("palette close button"); if (palette) palette.close(); });
ipcMain.handle("menu", () => { Menu.buildFromTemplate(menuTemplate()).popup({ window: widget }); });
ipcMain.handle("move-by", (e, dx, dy) => { const [x, y] = widget.getPosition(); widget.setPosition(Math.round(x + dx), Math.round(y + dy)); });
ipcMain.handle("drag-end", () => { const [x, y] = widget.getPosition(); state.x = x; state.y = y; saveState(); });
ipcMain.handle("copy", (e, hex) => gotColor(hex));
/* current color edited in the palette (RGB sliders): update the widget, no copy / no recent */
let curSaveT = null;
ipcMain.handle("add-recent", (e, hex) => {   /* a color made with the RGB sliders / hex box goes into recent too */
  hex = share.normHex(hex); if (!hex) return;
  state.last = hex;
  state.recent = [hex].concat(state.recent.filter(h => String(h).toUpperCase() !== hex)).slice(0, 50);
  saveState(); rebuildTray();
});
ipcMain.handle("set-current", (e, hex) => {
  hex = share.normHex(hex); if (!hex) return;
  state.last = hex;
  if (widget && !widget.isDestroyed()) widget.webContents.send("current", hex);
  clearTimeout(curSaveT); curSaveT = setTimeout(saveState, 400);
});
ipcMain.handle("state", () => ({ last: state.last, recent: state.recent, key: keyLabel(), lang: lang(), ver: CODE_VER, src: SRC.kind, status: statusMsg }));
ipcMain.handle("set-lang", (e, l) => setLang(l));
ipcMain.handle("lang-menu", () => {
  Menu.buildFromTemplate([["ko", "한국어"], ["en", "English"], ["ja", "日本語"]].map(([k, n]) => ({ label: n, type: "radio", checked: lang() === k, click: () => setLang(k) }))).popup({ window: palette || widget });
});
ipcMain.handle("store-get", () => readStore());
ipcMain.handle("store-set", (e, s) => writeStore(s));
ipcMain.handle("recent-remove", (e, hex) => { state.recent = state.recent.filter(h => h !== hex); saveState(); send("recent", state.recent); rebuildTray(); });
ipcMain.handle("export-menu", (e, p) => exportMenu(p));
ipcMain.handle("import-menu", () => importMenu());
ipcMain.handle("project-menu", (e, p) => projectMenu(p));
ipcMain.handle("save-preset", (e, p) => savePreset(p));
ipcMain.handle("capture-region", async () => { if (palette) palette.hide(); const d = await captureRegion(); if (palette) { palette.show(); palette.focus(); } return d; });
ipcMain.handle("diag", () => { const t = diag(); clipboard.writeText(t); return t; });
ipcMain.handle("overlay-done", (e, hex) => { if (overlayDone) overlayDone(hex || null); });
ipcMain.handle("log", (e, m) => log("renderer " + m));
/* palette grows upward (bottom edge stays) when the image card opens; returns the change actually applied */
ipcMain.handle("grow-by", (e, dy) => {
  if (!palette || palette.isDestroyed() || !dy) return 0;
  const b = palette.getBounds(), wa = screen.getDisplayMatching(b).workArea, bottom = b.y + b.height;
  const h = Math.max(360, Math.min(b.height + Math.round(dy), wa.height - 16));
  let y = bottom - h; if (y < wa.y + 8) y = wa.y + 8;
  palette.setBounds({ x: b.x, y: y, width: b.width, height: h }, false);
  /* transparent mac windows can keep the old frame for an instant after a resize -> force a full repaint */
  try { palette.webContents.invalidate(); } catch (x) {}
  if (IS_MAC) { try { palette.invalidateShadow(); } catch (x) {} }
  return h - b.height;
});
/* same as grow-by, animated here (ease-out) so the renderer can follow each step */
ipcMain.handle("grow-anim", (e, dy, ms) => new Promise((res) => {
  if (!palette || palette.isDestroyed() || !dy) return res(0);
  const b = palette.getBounds(), wa = screen.getDisplayMatching(b).workArea, bottom = b.y + b.height;
  const h1 = Math.max(360, Math.min(b.height + Math.round(dy), wa.height - 16)), real = h1 - b.height;
  if (!real) return res(0);
  const T = ms || 240, t0 = Date.now();
  const step = () => {
    if (!palette || palette.isDestroyed()) return res(0);
    const k = Math.min(1, (Date.now() - t0) / T), ez = 1 - Math.pow(1 - k, 3), h = Math.round(b.height + real * ez);
    let y = bottom - h; if (y < wa.y + 8) y = wa.y + 8;
    palette.setBounds({ x: b.x, y: y, width: b.width, height: h }, false);
    if (k < 1) setTimeout(step, 8); else res(real);
  };
  step();
}));
ipcMain.handle("presets-get", () => presets());
ipcMain.handle("key-get", () => ({ acc: PICK_KEY, label: keyLabel(), def: DEFAULT_KEY, defLabel: keyLabel(DEFAULT_KEY), mac: IS_MAC, lang: lang() }));
ipcMain.handle("key-label", (e, acc) => keyLabel(acc));
ipcMain.handle("key-set", (e, acc) => {
  try { globalShortcut.register(PICK_KEY, pick); } catch (x) {}   /* the window unregistered it while capturing */
  if (acc === PICK_KEY) return { ok: true, label: keyLabel() };
  return { ok: setPickKey(acc), label: keyLabel() };
});
ipcMain.handle("key-close", () => { if (keyWin && !keyWin.isDestroyed()) keyWin.close(); });
ipcMain.handle("focus-self", (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w || w.isDestroyed()) return; if (IS_MAC) app.focus({ steal: true }); w.focus(); });
let rendererOk = false;
ipcMain.handle("renderer-ready", () => { rendererOk = true; });

/* the Premiere panel (or a teammate's sync) changed the colors -> tell the palette */
function watchStore() {
  mkdir();
  fs.watchFile(STORE, { interval: 1500 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs || Date.now() - ownWrite < 1200) return;
    send("store-changed", readStore());
  });
}

/* ---- subject finder (on-device AI, downloaded on first use) ----
   two background-removal models: "anime" is good at characters in drawings, "general" at people / objects / designs.
   anime runs first; if it finds no clear subject, general runs. each file is downloaded the first time it is needed */
const AI_VER = "v1", AI_DIR = path.join(DATA_DIR, "ai-" + AI_VER), AI_SIZE = 1024;
const AI_MODELS = { anime: { mean: 0 }, general: { mean: .5 } };
let aiMan = null, aiWorker = null, aiSeq = 0; const aiWait = new Map(), aiFileJobs = {};
function download(url, dest, onProgress) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 20000, headers: { "User-Agent": "0202Swatch" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(download(res.headers.location, dest, onProgress)); }
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      let got = 0; const out = fs.createWriteStream(dest);
      res.on("data", (c) => { got += c.length; if (onProgress) onProgress(got); });
      res.pipe(out); out.on("finish", () => out.close(() => resolve(true))); res.on("error", () => resolve(false)); out.on("error", () => resolve(false));
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}
async function aiFiles(files) {
  mkdir(AI_DIR);
  const need = files.filter((f) => !fs.existsSync(path.join(AI_DIR, f)));
  if (!need.length) return;
  if (!aiMan) { const b = await get(UPDATE_BASES[0] + "ai/" + AI_VER + "/manifest.json"); try { aiMan = JSON.parse(b.toString("utf8")); } catch (e) { throw new Error("manifest"); } }
  const total = need.reduce((a, f) => a + aiMan[f].size, 0); let done = 0;
  for (const f of need) {
    if (!aiFileJobs[f]) aiFileJobs[f] = (async () => {
      const dest = path.join(AI_DIR, f), tmp = dest + ".part";
      const ok = await download(UPDATE_BASES[0] + "ai/" + AI_VER + "/" + f, tmp, (g) => send("ai-progress", Math.min(99, Math.round((done + g) / total * 100))));
      if (!ok) throw new Error("download " + f);
      const sha = require("crypto").createHash("sha256").update(fs.readFileSync(tmp)).digest("hex");
      if (sha !== aiMan[f].sha256) { try { fs.unlinkSync(tmp); } catch (e) {} throw new Error("checksum " + f); }
      fs.renameSync(tmp, dest);
    })().finally(() => { delete aiFileJobs[f]; });
    await aiFileJobs[f]; done += aiMan[f].size;
  }
  log("ai files ready " + need.join(","));
}
function aiRun(model, input) {
  if (!aiWorker) {
    const { Worker } = require("worker_threads");
    /* a worker can't start from inside app.asar -> run a copy from the data folder */
    let wf = path.join(__dirname, "ai-worker.js");
    if (/\.asar([\\/]|$)/.test(__dirname)) { const c2 = path.join(AI_DIR, "ai-worker.js"); try { fs.writeFileSync(c2, fs.readFileSync(wf)); wf = c2; } catch (e) {} }
    aiWorker = new Worker(wf, { workerData: { dir: AI_DIR } });
    aiWorker.on("message", (m) => { const w = aiWait.get(m.id); if (w) { aiWait.delete(m.id); m.err ? w.reject(new Error(m.err)) : w.resolve(m.mask); } });
    aiWorker.on("error", (e) => { log("ai worker " + e.message); aiWait.forEach((w) => w.reject(e)); aiWait.clear(); aiWorker = null; });
    aiWorker.on("exit", () => { aiWorker = null; });
  }
  return new Promise((resolve, reject) => { const id = ++aiSeq; aiWait.set(id, { resolve, reject }); aiWorker.postMessage({ id, model, input, size: AI_SIZE }, [input.buffer]); });
}
/* image data URL -> subject mask (probability 0..1 per pixel) at w x h, or null when no clear subject */
ipcMain.handle("subject-mask", async (e, src, w, h) => {
  try {
    const img = nativeImage.createFromDataURL(src); if (img.isEmpty()) return null;
    const bmp = img.resize({ width: AI_SIZE, height: AI_SIZE, quality: "good" }).toBitmap();   /* BGRA */
    const N = AI_SIZE * AI_SIZE;
    for (const model of ["anime", "general"]) {
      await aiFiles(["ort.node.min.js", "ort-wasm-simd.wasm", model + ".onnx"]);
      const mean = AI_MODELS[model].mean, input = new Float32Array(3 * N);
      for (let i = 0; i < N; i++) { input[i] = bmp[i * 4 + 2] / 255 - mean; input[N + i] = bmp[i * 4 + 1] / 255 - mean; input[2 * N + i] = bmp[i * 4] / 255 - mean; }
      const t = Date.now(), m = await aiRun(model, input);
      const out = new Array(w * h).fill(0), sx = AI_SIZE / w, sy = AI_SIZE / h; let on = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s2 = 0, n = 0;
        for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++) for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) { s2 += m[yy * AI_SIZE + xx]; n++; }
        const v = n ? s2 / n : 0; out[y * w + x] = v; if (v > .5) on++;
      }
      const frac = on / (w * h);
      log("ai " + model + " " + (Date.now() - t) + "ms subject " + Math.round(frac * 100) + "%");
      if (frac > .01 && frac < .9) return out;
    }
    return null;
  } catch (err) { log("ai subject failed " + (err && err.message)); return null; }
});

/* ---- anonymous usage stats: random install id only, no personal data ---- */
const SB_URL = "https://dmpfjmcxnvslzsjvhmjh.supabase.co", SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRtcGZqbWN4bnZzbHpzanZobWpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyMjc3NzUsImV4cCI6MjEwODgwMzc3NX0.LIh4M34bh-xchA8EJi_uShDt0ThVDo5fQKxKD11rkGs";
function installId() {
  const f = path.join(DATA_DIR, "install-id");
  try { const v = fs.readFileSync(f, "utf8").trim(); if (/^[0-9a-f-]{36}$/.test(v)) return v; } catch (e) {}
  const v = require("crypto").randomUUID(); mkdir(); try { fs.writeFileSync(f, v); } catch (e) {} return v;
}
function sbRpc(name, body) {
  try {
    const data = JSON.stringify(body), u = new URL(SB_URL + "/rest/v1/rpc/" + name);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: "POST", timeout: 10000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } }, (r) => r.resume());
    req.on("error", () => {}); req.on("timeout", () => req.destroy()); req.end(data);
  } catch (e) {}
}
function startStats() {
  const id = installId();
  const host = (SRC.kind === "dev" ? "dev-" : (global.__0202BETA__ ? "beta-" : "")) + (IS_MAC ? "mac" : IS_WIN ? "win" : process.platform);
  sbRpc("s0202_hit", { p_id: id, p_v: String(CODE_VER), p_host: host });
  setInterval(() => sbRpc("s0202_beat", { p_id: id }), 5 * 60 * 1000);
}

app.whenReady().then(() => {
  log("start code " + CODE_VER + " (" + SRC.kind + ") app " + app.getVersion() + " electron " + process.versions.electron + " " + process.platform);
  try { fs.unlinkSync(path.join(DATA_DIR, "boot-pending")); } catch (e) {}   /* this copy of the code booted fine */
  if (IS_MAC && app.dock) app.dock.hide();
  loadState();
  /* a widget should come back after a restart: turn "open at login" on once by default (can be turned off in the menu) */
  if (app.isPackaged && !state.loginDefaultSet) {
    try { app.setLoginItemSettings({ openAtLogin: true }); log("open at login: on (default)"); } catch (e) { log("login item failed " + e.message); }
    state.loginDefaultSet = true; saveState();
  }
  createWidget();
  tray = new Tray(trayIcon());
  tray.setToolTip("0202Swatch");
  if (IS_WIN) tray.on("click", openPalette);
  rebuildTray();
  if (state.pickKey) PICK_KEY = state.pickKey;
  let keyOk = false; try { keyOk = globalShortcut.register(PICK_KEY, pick); } catch (e) {}
  if (!keyOk) log("shortcut taken: " + PICK_KEY);
  watchStore();
  const keepOnScreen = () => { if (!widget) return; const [x, y] = widget.getPosition(); if (!onScreen(x, y)) { const p = defaultPos(); widget.setPosition(p.x, p.y); state.x = p.x; state.y = p.y; saveState(); } };
  screen.on("display-removed", keepOnScreen); screen.on("display-metrics-changed", keepOnScreen);
  /* mac: running straight from the dmg (or Downloads) breaks login-at-start -> offer to move it */
  if (IS_MAC && app.isPackaged && !app.isInApplicationsFolder()) {
    setTimeout(() => {
      const r = dialog.showMessageBoxSync({ type: "question", buttons: [T("응용 프로그램 폴더로 옮기기", "Move to Applications", "アプリケーションへ移動"), T("나중에", "Later", "後で")], defaultId: 0,
        message: T("0202Swatch를 응용 프로그램 폴더로 옮길까요?", "Move 0202Swatch to the Applications folder?", "アプリケーションフォルダへ移動しますか？"),
        detail: T("dmg 안에서 바로 실행하면 다음에 켤 때 안 보이거나 자동 실행이 안 될 수 있어요.", "Running from the disk image can break auto-start.", "") });
      if (r === 0) { try { app.moveToApplicationsFolder(); } catch (e) { log("move failed " + e.message); } }
    }, 1500);
  }
  status(T("준비 완료", "Ready", "準備完了") + " · v" + CODE_VER + (SRC.kind === "dev" ? T(" (개발)", " (dev)", "（開発）") : "")
    + (keyOk ? "" : T(" · 단축키 " + keyLabel() + "는 다른 앱이 쓰고 있어요", " · shortcut " + keyLabel() + " is used by another app", " · ショートカットは他のアプリが使用中")));
  if (SRC.kind === "update") setTimeout(() => {
    if (rendererOk) return;
    log("update " + CODE_VER + " did not draw the widget -> back to the installed copy");
    try { fs.writeFileSync(path.join(DATA_DIR, "bad-cache"), CODE_VER); } catch (e) {}
    app.relaunch(); app.exit(0);
  }, 15000);
  setTimeout(startStats, 3000);
  setTimeout(checkUpdate, 8000);
  setInterval(checkUpdate, 6 * 60 * 60 * 1000);
});
app.on("second-instance", () => { if (widget) { state.widgetHidden = false; saveState(); widget.showInactive(); } openPalette(); });
app.on("before-quit", () => log("quit"));
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => { /* keep running in the menu bar / tray */ });
