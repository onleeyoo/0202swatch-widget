/* color list formats shared with the Premiere panel: share code, .0202swatch JSON, .ase */
function normHex(h) { h = String(h || "").trim().replace(/^#/, ""); if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/(.)/g, "$1$1"); return /^[0-9a-f]{6}$/i.test(h) ? "#" + h.toUpperCase() : null; }
function liveGroups(p) { return (p.groups || []).filter(g => g.colors && g.colors.length); }
function toCode(groups, project) {
  const g = groups.map(x => ({ n: x.name, c: x.colors.map(c => c.o ? [c.h, c.n || "", c.o] : c.n ? [c.h, c.n] : [c.h]) }));
  /* "[project name] 0202SW1:..." - the name rides in front so it survives chat apps and older readers ignore it */
  return (project ? "[" + String(project).replace(/[\[\]]/g, "") + "] " : "") + "0202SW1:" + Buffer.from(JSON.stringify(g), "utf8").toString("base64");
}
function fromJsonGroups(o, fb) {
  const gs = o && o.groups ? o.groups : (Array.isArray(o) ? o : null);
  if (!gs) return null;
  return gs.map(g => ({ name: String(g.name || g.n || fb), colors: (g.colors || g.c || []).map(c => {
    const r = Array.isArray(c) ? { h: normHex(c[0]), n: c[1] || "", o: normHex(c[2]) } : { h: normHex(c.h || c.hex), n: c.n || c.name || "", o: normHex(c.o) };
    if (!r.o) delete r.o; return r;
  }).filter(c => c.h) }));
}
function parseText(t, fb) {
  t = String(t || "").trim();
  const m = t.match(/0202SW1:([A-Za-z0-9+/=]+)/);
  if (m) {
    try {
      const gs = fromJsonGroups(JSON.parse(Buffer.from(m[1], "base64").toString("utf8")), fb);
      const pn = t.match(/\[([^\]]+)\]\s*0202SW1:/); if (gs && pn) gs.project = pn[1].trim();
      return gs;
    } catch (e) { return null; }
  }
  if (/^[\[{]/.test(t)) { try { return fromJsonGroups(JSON.parse(t), fb); } catch (e) {} }
  const hs = t.match(/#?\b[0-9a-fA-F]{6}\b/g);
  if (hs && hs.length) return [{ name: fb, colors: hs.map(h => ({ h: normHex(h), n: "" })) }];
  return null;
}
function aseEncode(groups) {
  const parts = []; let blocks = 0;
  const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; };
  const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v, 0); return b; };
  const name = s => { s = String(s || ""); const b = Buffer.alloc((s.length + 1) * 2 + 2); b.writeUInt16BE(s.length + 1, 0); for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), 2 + i * 2); return b; };
  const block = (t, body) => { parts.push(u16(t), u32(body.length), body); blocks++; };
  groups.forEach(g => {
    block(0xC001, name(g.name));
    g.colors.forEach(c => { const n = parseInt(c.h.slice(1), 16), f = Buffer.alloc(12);
      f.writeFloatBE(((n >> 16) & 255) / 255, 0); f.writeFloatBE(((n >> 8) & 255) / 255, 4); f.writeFloatBE((n & 255) / 255, 8);
      block(0x0001, Buffer.concat([name(c.n || c.h), Buffer.from("RGB ", "ascii"), f, u16(2)])); });
    block(0xC002, Buffer.alloc(0));
  });
  return Buffer.concat([Buffer.from("ASEF", "ascii"), u16(1), u16(0), u32(blocks)].concat(parts));
}
function aseDecode(buf, fb) {
  if (buf.toString("ascii", 0, 4) !== "ASEF") return null;
  const n = buf.readUInt32BE(8); let o = 12, cur = null; const groups = [], loose = { name: fb, colors: [] };
  const rd = () => { const len = buf.readUInt16BE(o); o += 2; let s = ""; for (let i = 0; i < len; i++) { const ch = buf.readUInt16BE(o + i * 2); if (ch) s += String.fromCharCode(ch); } o += len * 2; return s; };
  for (let b = 0; b < n && o + 6 <= buf.length; b++) {
    const type = buf.readUInt16BE(o), len = buf.readUInt32BE(o + 2); o += 6; const end = o + len;
    if (type === 0xC001) { cur = { name: rd() || fb, colors: [] }; groups.push(cur); }
    else if (type === 0xC002) cur = null;
    else if (type === 0x0001) {
      const nm = rd(), model = buf.toString("ascii", o, o + 4).trim(); o += 4;
      const f = k => buf.readFloatBE(o + k * 4); let h = null;
      const hx = (r, g, bb) => "#" + [r, g, bb].map(v => { v = Math.max(0, Math.min(255, Math.round(v))).toString(16); return v.length < 2 ? "0" + v : v; }).join("").toUpperCase();
      if (model === "RGB") h = hx(f(0) * 255, f(1) * 255, f(2) * 255);
      else if (model === "CMYK") { const k = f(3); h = hx(255 * (1 - f(0)) * (1 - k), 255 * (1 - f(1)) * (1 - k), 255 * (1 - f(2)) * (1 - k)); }
      else if (model === "Gray") h = hx(f(0) * 255, f(0) * 255, f(0) * 255);
      if (h) (cur || loose).colors.push({ h, n: /^#?[0-9A-F]{6}$/i.test(nm) ? "" : nm });
    }
    o = end;
  }
  if (loose.colors.length) groups.unshift(loose);
  return groups;
}
function safeName(s) { return String(s || "0202Swatch").replace(/[\\/:*?"<>|]/g, "_"); }

/* color-chip share image (HTML rendered offscreen -> PNG) */
function chipHtml(project, groups, foot) {
  const esc = t => String(t || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const lum = h => { const n = parseInt(h.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255; };
  const multi = groups.length > 1;
  const body = groups.map(g => (multi ? '<div class="gn">' + esc(g.name) + '</div>' : '') + '<div class="grid">' + g.colors.map(c => {
    const h = (normHex(c.h) || "#000000").toUpperCase();
    return '<div class="chip"><div class="sw" style="background:' + h + (lum(h) < .08 ? ';box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)' : '') + '"></div><div class="lb"><b>' + h + '</b>' + (c.n ? '<span>' + esc(c.n) + '</span>' : '') + '</div></div>';
  }).join("") + '</div>').join("");
  const n = groups.reduce((a, g) => a + g.colors.length, 0);
  return '<!doctype html><html><head><meta charset="utf-8"><style>' +
    '*{box-sizing:border-box;margin:0;padding:0}html,body{background:#0b0910}' +
    'body{width:1080px;padding:56px;font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR","Noto Sans CJK KR",sans-serif;color:#f1edf8}' +
    '.card{background:#15111d;border:1px solid rgba(255,255,255,.09);border-radius:32px;padding:48px 48px 36px}' +
    '.top{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:34px}' +
    'h1{font-size:46px;font-weight:900;letter-spacing:-1px;line-height:1.15;word-break:keep-all}.cnt{color:#8a8197;font-size:20px;font-weight:700;white-space:nowrap;padding-left:20px}' +
    '.gn{font-size:22px;font-weight:800;color:#b69bff;margin:26px 0 14px}.gn:first-child{margin-top:0}' +
    '.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:22px}' +
    '.chip{border-radius:20px;overflow:hidden;background:#1c1626;box-shadow:0 0 0 1px rgba(255,255,255,.08)}' +
    '.sw{aspect-ratio:1/0.82}.lb{padding:14px 16px 16px;display:grid;gap:3px}' +
    '.lb b{font:800 22px ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.3px}.lb span{font-size:16px;color:#9d94ae;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.foot{display:flex;align-items:center;justify-content:space-between;margin-top:36px;padding-top:24px;border-top:2px solid rgba(255,255,255,.08)}' +
    '.logo{display:flex;align-items:center;gap:12px;font-size:26px;color:#b4abc6;font-weight:500}.logo b{color:#f1edf8;font-weight:900}' +
    '.dot{width:16px;height:16px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,#8a5cff 60%);box-shadow:0 0 14px #8a5cff}' +
    '.orb svg{width:22px;height:22px;color:#1a1424}.ft{font-size:17px;color:#a49bb3}' +
    '</style></head><body><div class="card"><div class="top"><h1>' + esc(project) + '</h1></div>' + body +
    '<div class="foot"><div class="logo"><span class="dot"></span><span>0202<b>Swatch</b></span></div></div></div></body></html>';
}
module.exports = { normHex, liveGroups, toCode, parseText, aseEncode, aseDecode, safeName, chipHtml };
