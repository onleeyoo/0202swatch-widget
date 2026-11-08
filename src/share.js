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
module.exports = { normHex, liveGroups, toCode, parseText, aseEncode, aseDecode, safeName };
