'use strict';
/* Rixifrah · servidor en línea (sin dependencias externas)
   - Sirve la carpeta /public
   - WebSocket en /ws: salas, chat, retos, búsqueda de rival y partidas
   - El servidor valida cada jugada con el mismo motor que usa el navegador */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./public/engine.js');
const { newState, legal, apply, inChk, key, insuf } = E;

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const CAP = 50, NR = 60, TC = [20, 10, 5], GRACE = 60000;

/* ---------- archivos estáticos ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'";

/* ---------- propaganda (API) ----------
   GET  /api/ads        -> lista pública de propaganda (la ven todos los jugadores)
   POST /api/ads/auth   -> {pw}        comprueba la contraseña
   POST /api/ads        -> {pw, ads}   guarda la propaganda (exige contraseña)
   Contraseña: variable ADS_PASS (por defecto "semilla"). Datos: DATA_DIR/ads.json */
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADS_FILE = path.join(DATA, 'ads.json');
const ADS_PASS = process.env.ADS_PASS || 'semilla';
const ACATS = ['frecuente', 'semi', 'ocasional'];
const MAX_ADS = 10, MAX_BODY = 12 * 1024 * 1024;
function cleanAds(d) {
  const out = { s1: [], s2: [] };
  for (const k of ['s1', 's2']) {
    const arr = Array.isArray(d && d[k]) ? d[k].slice(0, MAX_ADS) : [];
    for (const a of arr) {
      if (!a || typeof a.src !== 'string' || a.src.length > 1600000) continue;
      const okSrc = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(a.src) || /^https:\/\/[^\s"'<>]{4,2000}$/.test(a.src);
      if (!okSrc) continue;
      const href = typeof a.href === 'string' && /^https?:\/\/[^\s"'<>]{4,2000}$/.test(a.href) ? a.href : '';
      out[k].push({ id: String(a.id || '').replace(/[^\w-]/g, '').slice(0, 24) || crypto.randomBytes(6).toString('hex'), src: a.src, href, cat: ACATS.includes(a.cat) ? a.cat : 'ocasional' });
    }
  }
  return out;
}
let ADS = { s1: [], s2: [] };
try { ADS = cleanAds(JSON.parse(fs.readFileSync(ADS_FILE, 'utf8'))); } catch (e) { /* aún no hay propaganda guardada */ }
function saveAds() {
  try { fs.mkdirSync(DATA, { recursive: true }); const tmp = ADS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(ADS)); fs.renameSync(tmp, ADS_FILE); return true; }
  catch (e) { console.error('No se pudo guardar la propaganda:', e.message); return false; }
}
const sha = x => crypto.createHash('sha256').update(String(x)).digest();
const passOk = p => typeof p === 'string' && crypto.timingSafeEqual(sha(p), sha(ADS_PASS));
const fails = new Map();
function limited(ip) { const f = fails.get(ip); return !!(f && f.n >= 8 && Date.now() - f.t < 600000); }
function failed(ip) { const f = fails.get(ip); if (!f || Date.now() - f.t >= 600000) fails.set(ip, { n: 1, t: Date.now() }); else { f.n++; f.t = Date.now(); } }
function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); }
function readJson(req, res, cb) {
  const chunks = []; let n = 0, dead = false;
  req.on('data', c => { if (dead) return; n += c.length; if (n > MAX_BODY) { dead = true; sendJson(res, 413, { error: 'big' }); req.destroy(); return; } chunks.push(c); });
  req.on('end', () => { if (dead) return; let b; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return sendJson(res, 400, { error: 'json' }); } cb(b || {}); });
  req.on('error', () => {});
}
function adsApi(req, res, pathname) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (pathname === '/api/ads' && (req.method === 'GET' || req.method === 'HEAD')) return sendJson(res, 200, ADS);
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  if (pathname !== '/api/ads' && pathname !== '/api/ads/auth') { res.writeHead(404); return res.end(); }
  if (limited(ip)) return sendJson(res, 429, { error: 'limit' });
  readJson(req, res, b => {
    if (!passOk(b.pw)) { failed(ip); return sendJson(res, 401, { error: 'pw' }); }
    fails.delete(ip);
    if (pathname === '/api/ads/auth') return sendJson(res, 200, { ok: true });
    ADS = cleanAds(b.ads);
    sendJson(res, 200, { ok: true, saved: saveAds(), ads: ADS });
  });
}

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  if (u.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok ' + players.size); }
  if (u.pathname.startsWith('/api/')) return adsApi(req, res, u.pathname.replace(/\/+$/, '') || '/');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (file !== PUB && !file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': (ext === '.png' || ext === '.mp3') ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

/* ---------- WebSocket mínimo (RFC 6455) ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frameOut(op, pay) {
  const l = pay.length; let h;
  if (l < 126) h = Buffer.from([128 | op, l]);
  else if (l < 65536) { h = Buffer.alloc(4); h[0] = 128 | op; h[1] = 126; h.writeUInt16BE(l, 2); }
  else { h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 127; h.writeUInt32BE(l, 6); }
  return Buffer.concat([h, pay]);
}
const conns = new Set();
class Conn {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.frag = []; this.fragLen = 0; this.fragOp = 0;
    this.alive = true; this.p = null; this.win = Date.now(); this.cnt = 0;
    conns.add(this);
    sock.setNoDelay(true);
    sock.on('data', d => this.onData(d));
    sock.on('close', () => this.onClose());
    sock.on('error', () => sock.destroy());
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 140000) return this.sock.destroy();
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 128), op = b[0] & 15, masked = !!(b[1] & 128);
      let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2)) return this.sock.destroy(); len = b.readUInt32BE(6); off = 10; }
      if (len > 65536 || !masked) return this.sock.destroy();
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const pay = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) pay[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this.frame(fin, op, pay);
      if (this.sock.destroyed) return;
    }
  }
  frame(fin, op, pay) {
    if (op === 8) { try { this.sock.write(frameOut(8, Buffer.alloc(0))); } catch (e) {} return this.sock.end(); }
    if (op === 9) { this.sock.write(frameOut(10, pay)); return; }
    if (op === 10) { this.alive = true; return; }
    if (op === 1 || op === 2) { this.fragOp = op; this.frag = [pay]; this.fragLen = pay.length; }
    else if (op === 0) { this.frag.push(pay); this.fragLen += pay.length; if (this.fragLen > 65536) return this.sock.destroy(); }
    else return;
    if (!fin) return;
    const full = Buffer.concat(this.frag); this.frag = [];
    if (this.fragOp === 1) this.onText(full.toString('utf8'));
  }
  onText(t) {
    this.alive = true;
    const n = Date.now();
    if (n - this.win > 1000) { this.win = n; this.cnt = 0; }
    if (++this.cnt > 30) return this.sock.destroy();
    let m; try { m = JSON.parse(t); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    try { handle(this, m); } catch (e) { console.error('error', e); }
  }
  send(o) {
    if (this.sock.destroyed || !this.sock.writable) return;
    try { this.sock.write(frameOut(1, Buffer.from(JSON.stringify(o)))); } catch (e) {}
  }
  onClose() { conns.delete(this); const p = this.p; this.p = null; if (p && p.conn === this) disconnect(p); }
}
server.on('upgrade', (req, sock) => {
  const k = req.headers['sec-websocket-key'];
  const okPath = (req.url || '').split('?')[0] === '/ws';
  if (!k || !okPath || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const o = req.headers.origin;
  if (o) {
    let h = ''; try { h = new URL(o).host; } catch (e) {}
    if (h !== req.headers.host && !EXTRA_ORIGINS.includes(o)) { sock.destroy(); return; }
  }
  const acc = crypto.createHash('sha1').update(k + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  new Conn(sock);
});
setInterval(() => {
  for (const c of conns) {
    if (!c.alive) { c.sock.destroy(); continue; }
    c.alive = false;
    try { c.sock.write(frameOut(9, Buffer.alloc(0))); } catch (e) {}
  }
}, 25000);

/* ---------- estado ---------- */
const players = new Map();   // id -> P
const rooms = new Map();     // "t:s" -> Set<P>
const chats = new Map();     // "t:s" -> mensajes
const challenges = new Map(); // cid -> {from,to,exp}
let cidn = 1, gidn = 1;
const rk = (t, s) => t + ':' + s;
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);

function pub(p) { return { id: p.id, name: p.name, lvl: p.lvl, pts: p.pts, st: p.game ? 'play' : p.seek ? 'seek' : 'free' }; }
function members(k) { return rooms.get(k) || new Set(); }
function pushPlayers(k) {
  const set = rooms.get(k); if (!set) return;
  const list = [...set].map(pub).sort((a, b) => a.name.localeCompare(b.name));
  for (const q of set) q.send({ type: 'players', players: list });
}
function psend(p, o) { if (p.conn) p.conn.send(o); }

function leaveRoom(p) {
  if (!p.room) return;
  const k = rk(p.room.t, p.room.s), set = rooms.get(k);
  p.room = null; p.seek = false;
  dropChallenges(p);
  if (set) { set.delete(p); if (!set.size) { rooms.delete(k); chats.delete(k); } else pushPlayers(k); }
}
function dropChallenges(p) {
  for (const [cid, c] of challenges) {
    if (c.from === p || c.to === p) {
      challenges.delete(cid);
      const other = c.from === p ? c.to : c.from;
      psend(other, { type: 'cancelch', cid });
    }
  }
}
function disconnect(p) {
  p.conn = null;
  leaveRoom(p);
  if (p.game && !p.game.over) {
    const g = p.game, opp = g.w === p ? g.b : g.w;
    psend(opp, { type: 'oppdc' });
    clearTimeout(p.dc);
    p.dc = setTimeout(() => { if (!p.conn && p.game === g && !g.over) endGame(g, g.w === p ? 'b' : 'w', 'desconexión'); }, GRACE);
  } else players.delete(p.id);
}

/* ---------- partidas ---------- */
function clkNow(g) {
  const c = { w: g.clk.w, b: g.clk.b };
  if (!g.over) c[g.s.turn] = Math.max(0, c[g.s.turn] - (Date.now() - g.t0));
  return c;
}
function schedule(g) {
  clearTimeout(g.timer);
  const t = g.s.turn;
  g.timer = setTimeout(() => {
    if (g.over) return;
    g.clk[t] = 0;
    endGame(g, t === 'w' ? 'b' : 'w', 'tiempo agotado');
  }, Math.max(0, g.clk[t] - (Date.now() - g.t0)) + 80);
}
function startGame(a, b, t) {
  for (const p of [a, b]) { p.seek = false; dropChallenges(p); }
  const aw = Math.random() < 0.5, w = aw ? a : b, bl = aw ? b : a;
  const ms = t * 60000;
  const g = { id: 'g' + gidn++, t, w, b: bl, s: newState({}), moves: [], clk: { w: ms, b: ms }, t0: Date.now(), reps: {}, over: false, draw: null, timer: null, room: a.room };
  g.reps[key(g.s)] = 1;
  w.game = g; bl.game = g;
  schedule(g);
  for (const p of [w, bl]) {
    psend(p, startMsg(g, p));
    if (p.room) pushPlayers(rk(p.room.t, p.room.s));
  }
}
function startMsg(g, p, type = 'start') {
  const color = g.w === p ? 'w' : 'b', o = color === 'w' ? g.b : g.w;
  return { type, gid: g.id, color, mn: g.t, opp: { name: o.name, lvl: o.lvl, pts: o.pts }, clk: clkNow(g), moves: g.moves, room: p.room };
}
function endGame(g, w, why) {
  if (g.over) return;
  g.over = true; clearTimeout(g.timer);
  const m = { type: 'end', gid: g.id, w, why };
  for (const p of [g.w, g.b]) {
    clearTimeout(p.dc);
    p.game = null; p.drawn = null;
    psend(p, m);
    if (p.room) pushPlayers(rk(p.room.t, p.room.s));
    if (!p.conn) players.delete(p.id);
  }
}
function gameMove(p, m) {
  const g = p.game;
  if (!g || g.over || !m) return;
  const color = g.w === p ? 'w' : 'b';
  if (g.s.turn !== color) return psend(p, startMsg(g, p, 'sync'));
  const el = Date.now() - g.t0;
  if (g.clk[color] - el <= 0) { g.clk[color] = 0; return endGame(g, color === 'w' ? 'b' : 'w', 'tiempo agotado'); }
  const f = +m.f, t = +m.t, pr = m.p ? String(m.p) : null, ca = m.castle === undefined || m.castle === null ? undefined : +m.castle;
  const mv = legal(g.s).find(x => x.f === f && x.t === t && (x.p || null) === pr && x.castle === ca);
  if (!mv) { psend(p, { type: 'err', x: 'Jugada no válida' }); return psend(p, startMsg(g, p, 'sync')); }
  g.clk[color] -= el; g.t0 = Date.now();
  const mover = g.s.turn;
  g.s = apply(g.s, mv); g.moves.push(mv); g.draw = null;
  const k = key(g.s); g.reps[k] = (g.reps[k] || 0) + 1;
  const lm = legal(g.s), chk = inChk(g.s);
  let res = null;
  if (!lm.length) res = chk ? [mover, 'jaque mate'] : ['d', 'ahogado'];
  else if (g.s.hm >= 100) res = ['d', 'regla de 50 movimientos'];
  else if (g.reps[k] >= 3) res = ['d', 'repetición triple'];
  else if (insuf(g.s.b)) res = ['d', 'material insuficiente'];
  const opp = color === 'w' ? g.b : g.w;
  const clk = { w: g.clk.w, b: g.clk.b };
  psend(opp, { type: 'move', gid: g.id, m: mv, clk });
  psend(p, { type: 'clk', gid: g.id, clk });
  if (res) endGame(g, res[0], res[1]); else schedule(g);
}

/* ---------- mensajes ---------- */
function handle(c, m) {
  if (m.type === 'ping') return c.send({ type: 'pong' });
  if (m.type === 'hello') {
    const id = String(m.id || '');
    if (!/^[\w.:-]{6,64}$/.test(id)) return;
    let p = players.get(id);
    if (p && p.conn && p.conn !== c) { const old = p.conn; old.p = null; old.send({ type: 'kicked' }); p.conn = null; old.sock.destroy(); }
    if (!p) { p = { id, name: '', lvl: '', pts: 0, conn: null, room: null, seek: false, game: null, send: null }; players.set(id, p); }
    p.send = o => psend(p, o);
    const reconnect = !p.conn;
    p.conn = c; c.p = p;
    p.name = clean(m.name, 20) || 'Invitado'; p.lvl = clean(m.lvl, 16);
    p.pts = Math.max(0, Math.min(1e6, Math.floor(+m.pts || 0)));
    clearTimeout(p.dc);
    c.send({ type: 'welcome', online: players.size, ingame: !!(p.game && !p.game.over) });
    if (p.game && !p.game.over) {
      c.send(startMsg(p.game, p, 'sync'));
      if (reconnect) { const g = p.game, o = g.w === p ? g.b : g.w; psend(o, { type: 'oppback' }); }
    }
    if (p.room) pushPlayers(rk(p.room.t, p.room.s));
    return;
  }
  const p = c.p; if (!p) return;
  switch (m.type) {
    case 'rooms': {
      const t = +m.t; if (!TC.includes(t)) return;
      const counts = []; for (let s = 1; s <= NR; s++) counts.push(members(rk(t, s)).size);
      return c.send({ type: 'rooms', t, counts });
    }
    case 'join': {
      const t = +m.t, s = +m.s;
      if (!TC.includes(t) || !Number.isInteger(s) || s < 1 || s > NR) return;
      if (p.game && !p.game.over) return c.send({ type: 'joinfail', x: 'Termina tu partida antes de entrar a una sala' });
      const k = rk(t, s);
      if (p.room && rk(p.room.t, p.room.s) === k) { c.send({ type: 'room', t, s, players: [...members(k)].map(pub), chat: chats.get(k) || [] }); return pushPlayers(k); }
      if (members(k).size >= CAP) return c.send({ type: 'joinfail', x: 'La sala está llena' });
      leaveRoom(p);
      p.room = { t, s };
      if (!rooms.has(k)) rooms.set(k, new Set());
      rooms.get(k).add(p);
      c.send({ type: 'room', t, s, players: [...rooms.get(k)].map(pub), chat: chats.get(k) || [] });
      return pushPlayers(k);
    }
    case 'leave': return leaveRoom(p);
    case 'chat': {
      if (!p.room) return;
      const x = clean(m.x, 200); if (!x) return;
      const n = Date.now(); p.ct = (p.ct || []).filter(v => n - v < 5000);
      if (p.ct.length >= 5) return c.send({ type: 'err', x: 'Escribes demasiado rápido' });
      p.ct.push(n);
      const k = rk(p.room.t, p.room.s), msg = { type: 'chat', n: p.name, l: p.lvl, x, ts: n };
      const arr = chats.get(k) || []; arr.push({ n: p.name, l: p.lvl, x, ts: n }); if (arr.length > 50) arr.shift(); chats.set(k, arr);
      for (const q of members(k)) q.send(msg);
      return;
    }
    case 'seek': {
      if (!p.room || p.game) return;
      p.seek = !!m.on;
      if (p.seek) {
        for (const q of members(rk(p.room.t, p.room.s))) {
          if (q !== p && q.seek && !q.game && q.conn) return startGame(q, p, p.room.t);
        }
      }
      return pushPlayers(rk(p.room.t, p.room.s));
    }
    case 'challenge': {
      if (!p.room || p.game) return;
      const q = players.get(String(m.to || ''));
      if (!q || q === p || !q.conn || !q.room || q.game) return c.send({ type: 'err', x: 'Ese jugador no está disponible' });
      if (q.room.t !== p.room.t || q.room.s !== p.room.s) return c.send({ type: 'err', x: 'Ese jugador no está en tu sala' });
      for (const [cid, ch] of challenges) if (ch.from === p) { challenges.delete(cid); psend(ch.to, { type: 'cancelch', cid }); }
      const cid = 'c' + cidn++;
      challenges.set(cid, { from: p, to: q, exp: Date.now() + 30000 });
      setTimeout(() => { const ch = challenges.get(cid); if (ch) { challenges.delete(cid); psend(ch.to, { type: 'cancelch', cid }); psend(ch.from, { type: 'info', x: 'El reto expiró' }); } }, 30000);
      psend(q, { type: 'challenged', cid, from: { name: p.name, lvl: p.lvl, pts: p.pts }, t: p.room.t });
      return c.send({ type: 'info', x: 'Reto enviado a ' + q.name });
    }
    case 'answer': {
      const ch = challenges.get(String(m.cid || ''));
      if (!ch || ch.to !== p) return;
      challenges.delete(String(m.cid));
      if (!m.ok) return psend(ch.from, { type: 'info', x: p.name + ' rechazó el reto' });
      const a = ch.from;
      if (!a.conn || a.game || p.game || !a.room || !p.room || a.room.t !== p.room.t || a.room.s !== p.room.s) return psend(p, { type: 'err', x: 'El reto ya no está disponible' });
      return startGame(a, p, p.room.t);
    }
    case 'move': return gameMove(p, m.m);
    case 'resign': { const g = p.game; if (g && !g.over) endGame(g, g.w === p ? 'b' : 'w', 'rendición'); return; }
    case 'draw': {
      const g = p.game; if (!g || g.over) return;
      const color = g.w === p ? 'w' : 'b', o = color === 'w' ? g.b : g.w;
      if (g.moves.length < 2) return c.send({ type: 'err', x: 'Es muy pronto para pedir tablas' });
      if (g.draw && g.draw !== color) return endGame(g, 'd', 'acuerdo');
      g.draw = color; psend(o, { type: 'drawOffer' }); return c.send({ type: 'info', x: 'Oferta de tablas enviada' });
    }
    case 'drawAnswer': {
      const g = p.game; if (!g || g.over || !g.draw) return;
      const color = g.w === p ? 'w' : 'b'; if (g.draw === color) return;
      const o = color === 'w' ? g.b : g.w;
      if (m.ok) return endGame(g, 'd', 'acuerdo');
      g.draw = null; return psend(o, { type: 'info', x: 'El rival rechazó las tablas' });
    }
    case 'gchat': {
      const g = p.game; if (!g || g.over) return;
      const x = clean(m.x, 200); if (!x) return;
      const n = Date.now(); p.gt = (p.gt || []).filter(v => n - v < 5000);
      if (p.gt.length >= 6) return;
      p.gt.push(n);
      return psend(g.w === p ? g.b : g.w, { type: 'gchat', n: p.name, x });
    }
  }
}

if (require.main === module) server.listen(PORT, () => console.log('Rixifrah escuchando en el puerto ' + PORT));
module.exports = { server };
