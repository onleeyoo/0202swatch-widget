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
