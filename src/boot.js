/* App entry: decides which copy of the code runs.
   1) dev folder (~/workspace/0202SwatchWidget/src) on the developer's machine -> edits show up with ↻
   2) a newer downloaded update (app-cache), if complete and it didn't fail to start last time
   3) the copy bundled in the installer */
const path = require("path"), fs = require("fs"), os = require("os");
const { app } = require("electron");
const DATA = path.join(app.getPath("appData"), "0202Swatch");
const CACHE = path.join(DATA, "app-cache");
const DEV = path.join(os.homedir(), "workspace", "0202SwatchWidget", "src");
function log(m) {
  const line = new Date().toISOString() + " BOOT " + m + "\n";
  try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(path.join(DATA, "widget-log.txt"), line); } catch (e) {}
  try { if (fs.existsSync(DEV)) fs.appendFileSync(path.join(DEV, "..", "_log.txt"), line); } catch (e) {}
}
process.on("uncaughtException", (e) => log("UNCAUGHT " + (e && e.stack)));
log("start " + process.argv.join(" "));
/* ---- beta build: usable for N days from the first launch, then shows a notice and quits ---- */
let PKG = {};
try { PKG = require(path.join(__dirname, "..", "package.json")); } catch (e) {}
if (PKG.beta) {
  const DAY = 864e5, DAYS = +PKG.betaDays || 3, now = Date.now();
  const F = [path.join(DATA, ".beta-start"), path.join(os.homedir(), ".0202swatch-beta")];
  const rd = f => { try { return fs.readFileSync(f, "utf8").trim().split(" ").map(Number); } catch (e) { return null; } };
  const vals = F.map(rd).filter(v => v && v[0] > 0);
  const start = vals.length ? Math.min(...vals.map(v => v[0])) : now;
  const seen = vals.length ? Math.max(...vals.map(v => v[1] || 0)) : now;
  const end = start + DAYS * DAY;
  const rollback = now < seen - 3600e3;            // clock moved backwards
  F.forEach(f => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, start + " " + Math.max(now, seen)); } catch (e) {} });
  global.__0202BETA__ = { start, end, daysLeft: Math.max(0, Math.ceil((end - now) / DAY)) };
  log("beta start " + new Date(start).toISOString() + " end " + new Date(end).toISOString() + (rollback ? " ROLLBACK" : ""));
  if (now < end && !rollback) {                    // every launch: show how long the beta still lasts
    const { dialog } = require("electron");
    const d = new Date(end), until = (d.getMonth() + 1) + "월 " + d.getDate() + "일 " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const left = Math.max(1, Math.ceil((end - now) / DAY));
    app.whenReady().then(() => {
      try { app.focus({ steal: true }); } catch (e) {}
      dialog.showMessageBox({
        type: "info", title: "0202Swatch 베타", buttons: ["시작하기"],
        message: vals.length ? "0202Swatch 베타 · " + left + "일 남았어요" : "0202Swatch 베타 체험판이에요",
        detail: (vals.length ? "" : "오늘부터 " + DAYS + "일 동안 모든 기능을 사용할 수 있어요.\n") + "체험 종료: " + until + "\n\n불편한 점이나 버그는 팔레트 맨 아래 빨간 문구를 눌러\n진단 정보를 복사한 뒤 보내주세요."
      });
    });
  }
  if (now >= end || rollback) {
    const { dialog, shell } = require("electron");
    app.whenReady().then(() => {
      try { app.focus({ steal: true }); } catch (e) {}
      const r = dialog.showMessageBoxSync({
        type: "info", title: "0202Swatch 베타", buttons: ["스토어 열기", "닫기"], defaultId: 0, cancelId: 1,
        message: "베타 체험 기간(" + DAYS + "일)이 끝났어요",
        detail: "베타 테스트에 참여해 주셔서 감사해요!\n계속 사용하시려면 정식 버전을 구매해 주세요.\n\n공이공이 프로덕션 스토어 · 0202production.imweb.me/shop"
      });
      if (r === 0) shell.openExternal("https://0202production.imweb.me/shop");
      setTimeout(() => app.quit(), 300);
    });
    return;
  }
}

function ver(dir) { try { return String(JSON.parse(fs.readFileSync(path.join(dir, "version.json"), "utf8")).v); } catch (e) { return null; } }
function cmp(a, b) { a = String(a || "0").split("."); b = String(b || "0").split("."); for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (+a[i] || 0) - (+b[i] || 0); if (d) return d > 0 ? 1 : -1; } return 0; }
function complete(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, "files.json"), "utf8")).every(f => fs.existsSync(path.join(dir, f))); } catch (e) { return false; } }
function read(f) { try { return fs.readFileSync(f, "utf8").trim(); } catch (e) { return ""; } }

let chosen = null;
if (path.resolve(DEV) !== path.resolve(__dirname) && fs.existsSync(path.join(DEV, "main.js"))) chosen = { kind: "dev", dir: DEV };
else {
  const cv = ver(CACHE), bv = ver(__dirname);
  const pending = read(path.join(DATA, "boot-pending")), bad = read(path.join(DATA, "bad-cache"));
  if (cv && pending === cv) { try { fs.writeFileSync(path.join(DATA, "bad-cache"), cv); } catch (e) {} log("cache " + cv + " failed to start last time, skipping"); }
  else if (cv && cmp(cv, bv) > 0 && bad !== cv && complete(CACHE)) {
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, "boot-pending"), cv); } catch (e) {}
    chosen = { kind: "update", dir: CACHE };
  }
}
let loaded = false;
if (chosen) {
  try { global.__0202SRC__ = chosen; require(path.join(chosen.dir, "main.js")); loaded = true; }
  catch (e) { log(chosen.kind + " load failed " + e.stack); }
}
if (!loaded) { global.__0202SRC__ = { kind: "bundled", dir: __dirname }; require("./main.js"); }
