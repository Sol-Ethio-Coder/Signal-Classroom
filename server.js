'use strict';
/**
 * Signal Classroom — server
 * - No user accounts. One admin (ADMIN_USER + ADMIN_PASSWORD) signs in at /admin (create classes, see attendance).
 * - Each class has a public join code (students) and a secret host token (teacher link).
 * - Socket.io = signalling + whiteboard/chat/poll state. Media is peer-to-peer (WebRTC mesh).
 */
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

// Minimal .env loader (no dependency). Real environment variables win over the file.
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !m[1].startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch { /* no .env file */ }

// ───────────────────────── config ─────────────────────────
const PORT = process.env.PORT || 3000;
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim();
let ADMIN_PASS = process.env.ADMIN_PASSWORD || process.env.ADMIN_KEY || '';   // ADMIN_KEY = old name, still accepted
const TEMP_PASS = !ADMIN_PASS;
if (TEMP_PASS) {                       // never fall back to a guessable default
  ADMIN_PASS = crypto.randomBytes(9).toString('base64url');
  console.warn('\n⚠  No admin credentials in .env. Temporary login for this run only:');
  console.warn('     username: ' + ADMIN_USER + '\n     password: ' + ADMIN_PASS + '\n   Run "npm run setup" to set your own.\n');
}
const SECRET = process.env.SECRET || crypto.createHash('sha256').update('signal-classroom:' + ADMIN_USER + ':' + ADMIN_PASS).digest('hex');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_PEERS = 12;          // WebRTC mesh gets heavy past ~8 cameras
const MAX_PTS = 6000;          // points per freehand stroke
const MAX_ITEMS = 4000;        // items per whiteboard page
const MAX_PAGES = 30;

const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) {
  ICE.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
}

// ───────────────────────── tiny JSON store ─────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { rooms: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); if (!db.rooms) db.rooms = {}; } catch { /* first run */ }
let saveTimer = null;
function save() { // throttled: at most one write every 1.5s
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DB_FILE + '.tmp', JSON.stringify(db), err => { if (!err) fs.rename(DB_FILE + '.tmp', DB_FILE, () => {}); });
  }, 1500);
}
process.on('SIGINT', () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch {} process.exit(0); });

// ───────────────────────── crypto helpers ─────────────────────────
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verify(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
function hashPass(pw) { const salt = crypto.randomBytes(12).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); }
function checkPass(room, pw) {
  if (!room.passHash) return true;
  const [salt, h] = room.passHash.split(':');
  const got = crypto.scryptSync(String(pw || ''), salt, 32).toString('hex');
  return got.length === h.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(h));
}
function genCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
  let c;
  do { c = Array.from(crypto.randomBytes(6), b => A[b % A.length]).join(''); } while (db.rooms[c]);
  return c;
}

// login throttle
const attempts = new Map();
function throttled(ip) { const a = attempts.get(ip); return a && a.n >= 8 && Date.now() < a.until; }
function failed(ip) { const a = attempts.get(ip) || { n: 0 }; a.n++; a.until = Date.now() + 10 * 60 * 1000; attempts.set(ip, a); }

// ───────────────────────── http ─────────────────────────
const app = express();
const server = http.createServer(app);
// Split deployment: pages on Vercel, this server on Render. CORS_ORIGIN = comma-separated exact origins.
const CORS = (process.env.CORS_ORIGIN || '').split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean);
const io = new Server(server, { maxHttpBufferSize: 3e6, cors: CORS.length ? { origin: CORS } : undefined });
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && CORS.includes(o)) {
    res.set({ 'Access-Control-Allow-Origin': o, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.get('/vercel.json', (req, res) => res.sendStatus(404));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)'
  });
  next();
});

const live = new Map(); // code -> live state (in-memory)

function adminAuth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const p = verify(t);
  if (p && p.role === 'admin') return next();
  res.status(401).json({ error: 'Unauthorized' });
}
const roomView = r => ({
  code: r.code, title: r.title, status: r.status, createdAt: r.createdAt,
  hasPassword: !!r.passHash, hostToken: r.hostToken,
  online: live.get(r.code)?.peers.size || 0, attendanceCount: r.attendance.length
});

app.post('/api/admin/login', (req, res) => {
  if (throttled(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  const userOk = safeEq(String(req.body?.username || '').trim().toLowerCase(), ADMIN_USER.toLowerCase());
  const passOk = safeEq(req.body?.password || '', ADMIN_PASS);
  if (!(userOk && passOk)) { failed(req.ip); return res.status(401).json({ error: 'Wrong username or password' }); }
  attempts.delete(req.ip);
  res.json({ token: sign({ role: 'admin', exp: Date.now() + 12 * 3600e3 }) });
});

// Setup checklist for the admin page (only after login, so nothing leaks to the public)
app.get('/api/admin/status', adminAuth, (req, res) => {
  const https = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.json({
    tempCreds: TEMP_PASS,
    weakPass: !TEMP_PASS && ADMIN_PASS.length < 10,
    https,
    turn: !!process.env.TURN_URL,
    customData: !!process.env.DATA_DIR,
    rooms: Object.keys(db.rooms).length
  });
});

app.get('/api/admin/rooms', adminAuth, (req, res) => {
  res.json(Object.values(db.rooms).sort((a, b) => b.createdAt - a.createdAt).map(roomView));
});

app.post('/api/admin/rooms', adminAuth, (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 80) || 'Untitled class';
  const pw = String(req.body?.password || '').slice(0, 64);
  const code = genCode();
  db.rooms[code] = {
    code, title, status: 'open', createdAt: Date.now(),
    hostToken: crypto.randomBytes(24).toString('hex'),
    passHash: pw ? hashPass(pw) : null,
    attendance: [], board: { pages: [[]], page: 0, bg: 'grid' }, pad: ''
  };
  save();
  res.json(roomView(db.rooms[code]));
});

app.get('/api/admin/rooms/:code/attendance', adminAuth, (req, res) => {
  const r = db.rooms[req.params.code];
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r.attendance);
});

app.post('/api/admin/rooms/:code/status', adminAuth, (req, res) => {
  const r = db.rooms[req.params.code];
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (req.body?.status === 'ended') endRoom(r.code); else r.status = 'open';
  save();
  res.json(roomView(r));
});

app.post('/api/admin/rooms/:code/reset-board', adminAuth, (req, res) => {
  const r = db.rooms[req.params.code];
  if (!r) return res.status(404).json({ error: 'Not found' });
  r.board = { pages: [[]], page: 0, bg: r.board?.bg || 'grid' };
  const st = live.get(r.code);
  if (st) io.to(r.code).emit('wb:state', r.board);
  save();
  res.json({ ok: true });
});

app.delete('/api/admin/rooms/:code', adminAuth, (req, res) => {
  const r = db.rooms[req.params.code];
  if (!r) return res.status(404).json({ error: 'Not found' });
  endRoom(r.code);
  delete db.rooms[r.code];
  live.delete(r.code);
  save();
  res.json({ ok: true });
});

// Public: what a student sees before joining (never leaks hostToken)
app.get('/api/rooms/:code', (req, res) => {
  const r = db.rooms[String(req.params.code).toUpperCase()];
  if (!r) return res.status(404).json({ exists: false });
  res.json({ exists: true, title: r.title, needsPassword: !!r.passHash, ended: r.status === 'ended' });
});

app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));
app.get('/r/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ───────────────────────── live state ─────────────────────────
function getLive(code) {
  let st = live.get(code);
  if (!st) {
    st = { peers: new Map(), locked: false, chatLocked: false, drawAll: false, screenAll: false,
           spotlight: null, recording: false, poll: null, timer: null, chat: [] };
    live.set(code, st);
  }
  return st;
}
const pub = p => ({ id: p.id, name: p.name, role: p.role, canDraw: p.canDraw, hand: p.hand, mic: p.mic, cam: p.cam, screen: p.screen });
const flagsOf = st => ({ locked: st.locked, chatLocked: st.chatLocked, drawAll: st.drawAll, screenAll: st.screenAll, spotlight: st.spotlight, recording: st.recording });
function pollView(st, peer) {
  const p = st.poll; if (!p) return null;
  const counts = p.opts.map((_, i) => [...p.votes.values()].filter(v => v === i).length);
  return { id: p.id, q: p.q, opts: p.opts, open: p.open, total: p.votes.size,
           counts: (!p.open || peer.role === 'host') ? counts : null,
           myVote: p.votes.has(peer.id) ? p.votes.get(peer.id) : null };
}
function emitPoll(st) { for (const peer of st.peers.values()) io.to(peer.id).emit('poll', pollView(st, peer)); }

function endRoom(code) {
  const r = db.rooms[code]; if (!r) return;
  r.status = 'ended';
  const now = Date.now();
  r.attendance.forEach(a => { if (!a.leftAt) a.leftAt = now; });
  io.to(code).emit('ended');
  setTimeout(() => io.in(code).disconnectSockets(true), 600);
  live.delete(code);
  save();
}

function cleanItem(it, owner) {
  if (!it || typeof it !== 'object') return null;
  const tools = ['pen', 'highlighter', 'eraser', 'line', 'rect', 'ellipse', 'arrow', 'text'];
  if (!tools.includes(it.tool)) return null;
  const num = (v, min, max, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
  const pt = p => Array.isArray(p) ? [num(p[0], 0, 2000, 0), num(p[1], 0, 2000, 0)] : [0, 0];
  const out = {
    id: String(it.id || '').slice(0, 40) || crypto.randomUUID(),
    tool: it.tool,
    color: /^#[0-9a-f]{6}$/i.test(it.color) ? it.color : '#111827',
    size: num(it.size, 1, 80, 4),
    owner
  };
  if (['pen', 'highlighter', 'eraser'].includes(it.tool)) out.pts = (Array.isArray(it.pts) ? it.pts : []).slice(0, MAX_PTS).map(pt);
  else if (it.tool === 'text') { out.at = pt(it.at); out.text = String(it.text || '').slice(0, 300); }
  else { out.a = pt(it.a); out.b = pt(it.b); }
  return out;
}

// ───────────────────────── sockets ─────────────────────────
io.on('connection', socket => {
  let ctx = null; // { code, room, st, me, att }

  // crude flood protection
  let evCount = 0;
  const tick = setInterval(() => { evCount = 0; }, 1000);
  socket.use((_pkt, next) => (++evCount > 400 ? next(new Error('rate limit')) : next()));
  socket.on('error', () => {});

  socket.on('join', (d, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    if (ctx) return ack({ ok: false, error: 'Already joined' });
    d = d || {};
    const code = String(d.code || '').toUpperCase().trim();
    const room = db.rooms[code];
    if (!room) return ack({ ok: false, error: 'Class not found. Check the code.' });
    if (room.status === 'ended') return ack({ ok: false, error: 'This class has ended.' });
    const name = String(d.name || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    if (!name) return ack({ ok: false, error: 'Enter your name.' });

    const isHost = !!d.hostToken && safeEq(d.hostToken, room.hostToken);
    const st = getLive(code);
    if (!isHost) {
      if (!checkPass(room, d.password)) return ack({ ok: false, error: 'Wrong class password.' });
      if (st.locked) return ack({ ok: false, error: 'The teacher has locked this class.' });
    }
    if (st.peers.size >= MAX_PEERS) return ack({ ok: false, error: 'Class is full.' });

    const me = { id: socket.id, name, role: isHost ? 'host' : 'student', canDraw: isHost || st.drawAll,
                 hand: false, mic: false, cam: false, screen: false };
    const att = { name, role: me.role, joinedAt: Date.now(), leftAt: null };
    room.attendance.push(att);
    if (room.attendance.length > 5000) room.attendance.splice(0, room.attendance.length - 5000);
    ctx = { code, room, st, me, att };
    socket.join(code);
    st.peers.set(socket.id, me);
    save();

    const others = [...st.peers.values()].filter(p => p.id !== socket.id);
    ack({
      ok: true, me: pub(me), peers: others.map(pub), ice: ICE,
      state: {
        title: room.title, code, flags: flagsOf(st), board: room.board, pad: room.pad || '',
        poll: pollView(st, me), chat: st.chat.slice(-100),
        timer: st.timer ? { remaining: Math.max(0, st.timer.endAt - Date.now()), total: st.timer.total } : null
      }
    });
    socket.to(code).emit('peer-joined', pub(me));
  });

  const on = (ev, fn) => socket.on(ev, (...a) => { if (!ctx) return; try { fn(...a); } catch (e) { console.error(ev, e); } });
  const isHost = () => ctx.me.role === 'host';
  const canDraw = () => isHost() || ctx.me.canDraw;
  const room = () => ctx.room;
  const board = () => ctx.room.board;
  const bcast = (ev, p) => io.to(ctx.code).emit(ev, p);
  const updatePeer = p => bcast('peer-update', pub(p));

  // WebRTC signalling relay
  on('signal', ({ to, data } = {}) => {
    if (ctx.st.peers.has(to) && data && typeof data === 'object') io.to(to).emit('signal', { from: socket.id, data });
  });

  on('media', (m = {}) => {
    const me = ctx.me;
    me.mic = !!m.mic; me.cam = !!m.cam;
    me.screen = !!m.screen && (isHost() || ctx.st.screenAll);
    if (m.screen && !me.screen) socket.emit('force', { kind: 'stop-screen' });
    updatePeer(me);
  });

  on('hand', ({ up } = {}) => { ctx.me.hand = !!up; updatePeer(ctx.me); });

  on('react', ({ emoji } = {}) => {
    if (['👍', '👏', '❤️', '😂', '🎉', '🤯', '❓'].includes(emoji)) bcast('react', { from: socket.id, emoji });
  });

  // ── chat ──
  on('chat', (m = {}) => {
    if (ctx.st.chatLocked && !isHost()) return;
    const text = String(m.text || '').slice(0, 1000).trim();
    let file = null;
    if (m.file && typeof m.file.data === 'string' && m.file.data.startsWith('data:') && m.file.data.length < 2.8e6) {
      file = { name: String(m.file.name || 'file').slice(0, 80), data: m.file.data };
    }
    if (!text && !file) return;
    const msg = { id: crypto.randomUUID(), from: socket.id, name: ctx.me.name, role: ctx.me.role, text, file, ts: Date.now(), priv: false };
    if (m.priv && !isHost()) { // private question to teacher(s)
      msg.priv = true;
      socket.emit('chat', msg);
      for (const p of ctx.st.peers.values()) if (p.role === 'host') io.to(p.id).emit('chat', msg);
      return;
    }
    ctx.st.chat.push(msg);
    if (ctx.st.chat.length > 200) ctx.st.chat.shift();
    bcast('chat', msg);
  });

  // ── whiteboard ──
  const pageOk = i => Number.isInteger(i) && i >= 0 && i < board().pages.length;
  on('wb:start', ({ page, item } = {}) => {
    if (!canDraw() || !pageOk(page)) return;
    const it = cleanItem(item, socket.id); if (!it) return;
    const arr = board().pages[page];
    if (arr.length >= MAX_ITEMS) return;
    arr.push(it); save();
    socket.to(ctx.code).emit('wb:start', { page, item: it });
  });
  on('wb:pts', ({ page, id, pts } = {}) => {
    if (!canDraw() || !pageOk(page) || !Array.isArray(pts)) return;
    const it = board().pages[page].find(x => x.id === id && x.owner === socket.id);
    if (!it || !it.pts) return;
    const clean = pts.slice(0, 200).map(p => [Math.min(2000, Math.max(0, +p[0] || 0)), Math.min(2000, Math.max(0, +p[1] || 0))]);
    if (it.pts.length + clean.length > MAX_PTS) return;
    it.pts.push(...clean); save();
    socket.to(ctx.code).emit('wb:pts', { page, id, pts: clean });
  });
  on('wb:add', ({ page, item } = {}) => {
    if (!canDraw() || !pageOk(page)) return;
    const it = cleanItem(item, socket.id); if (!it) return;
    const arr = board().pages[page];
    if (arr.length >= MAX_ITEMS) return;
    arr.push(it); save();
    socket.to(ctx.code).emit('wb:add', { page, item: it });
  });
  on('wb:remove', ({ page, id } = {}) => {
    if (!canDraw() || !pageOk(page)) return;
    const arr = board().pages[page];
    const i = arr.findIndex(x => x.id === id && (x.owner === socket.id || isHost()));
    if (i < 0) return;
    arr.splice(i, 1); save();
    socket.to(ctx.code).emit('wb:remove', { page, id });
  });
  on('wb:clear', ({ page } = {}) => {
    if (!isHost() || !pageOk(page)) return;
    board().pages[page] = []; save();
    bcast('wb:clear', { page });
  });
  on('wb:page', ({ index } = {}) => {
    if (!isHost() || !pageOk(index)) return;
    board().page = index; save();
    bcast('wb:page', { index, count: board().pages.length });
  });
  on('wb:newpage', () => {
    if (!isHost() || board().pages.length >= MAX_PAGES) return;
    board().pages.push([]); board().page = board().pages.length - 1; save();
    bcast('wb:page', { index: board().page, count: board().pages.length });
  });
  on('wb:bg', ({ bg } = {}) => {
    if (!isHost() || !['white', 'grid', 'lines', 'dark'].includes(bg)) return;
    board().bg = bg; save();
    bcast('wb:bg', { bg });
  });
  on('wb:laser', ({ x, y } = {}) => {
    if (!canDraw()) return;
    socket.to(ctx.code).emit('wb:laser', { from: socket.id, name: ctx.me.name, x: +x || 0, y: +y || 0 });
  });

  // ── shared pad ──
  on('pad', ({ text } = {}) => {
    if (!canDraw()) return;
    room().pad = String(text || '').slice(0, 20000); save();
    socket.to(ctx.code).emit('pad', room().pad);
  });

  // ── polls ──
  on('poll:start', ({ q, opts } = {}) => {
    if (!isHost()) return;
    const options = (Array.isArray(opts) ? opts : []).map(o => String(o).trim().slice(0, 80)).filter(Boolean).slice(0, 8);
    if (!String(q || '').trim() || options.length < 2) return;
    ctx.st.poll = { id: crypto.randomUUID(), q: String(q).trim().slice(0, 200), opts: options, votes: new Map(), open: true };
    emitPoll(ctx.st);
  });
  on('poll:vote', ({ index } = {}) => {
    const p = ctx.st.poll;
    if (!p || !p.open || !Number.isInteger(index) || index < 0 || index >= p.opts.length) return;
    p.votes.set(socket.id, index);
    emitPoll(ctx.st);
  });
  on('poll:end', () => { if (isHost() && ctx.st.poll) { ctx.st.poll.open = false; emitPoll(ctx.st); } });
  on('poll:clear', () => { if (isHost()) { ctx.st.poll = null; emitPoll(ctx.st); } });

  // ── timer ──
  on('timer:set', ({ seconds } = {}) => {
    if (!isHost()) return;
    const s = Math.floor(+seconds || 0);
    if (s <= 0) ctx.st.timer = null;
    else ctx.st.timer = { endAt: Date.now() + s * 1000, total: s };
    bcast('timer', ctx.st.timer ? { remaining: s * 1000, total: s } : null);
  });

  // ── recording notice (consent: everyone sees REC) ──
  on('recording', ({ on: v } = {}) => { if (!isHost()) return; ctx.st.recording = !!v; bcast('flags', flagsOf(ctx.st)); });

  // ── moderation ──
  on('room-set', ({ key, value } = {}) => {
    if (!isHost()) return;
    const st = ctx.st;
    if (!['locked', 'chatLocked', 'drawAll', 'screenAll'].includes(key)) return;
    st[key] = !!value;
    if (key === 'drawAll') for (const p of st.peers.values()) if (p.role !== 'host') { p.canDraw = st.drawAll; updatePeer(p); }
    if (key === 'screenAll' && !st.screenAll) for (const p of st.peers.values()) if (p.role !== 'host' && p.screen) io.to(p.id).emit('force', { kind: 'stop-screen' });
    bcast('flags', flagsOf(st));
  });
  on('mod', ({ action, target } = {}) => {
    if (!isHost()) return;
    const st = ctx.st;
    if (action === 'mute-all') { for (const p of st.peers.values()) if (p.role !== 'host') io.to(p.id).emit('force', { kind: 'mute' }); return; }
    if (action === 'lower-all') { for (const p of st.peers.values()) if (p.hand) { p.hand = false; updatePeer(p); } return; }
    if (action === 'end-class') return endRoom(ctx.code);
    const t = st.peers.get(target);
    if (!t) return;
    switch (action) {
      case 'mute': io.to(t.id).emit('force', { kind: 'mute' }); break;
      case 'cam-off': io.to(t.id).emit('force', { kind: 'cam-off' }); break;
      case 'lower-hand': t.hand = false; updatePeer(t); break;
      case 'toggle-draw': if (t.role !== 'host') { t.canDraw = !t.canDraw; updatePeer(t); } break;
      case 'spotlight': st.spotlight = st.spotlight === t.id ? null : t.id; bcast('flags', flagsOf(st)); break;
      case 'kick':
        if (t.role === 'host') break;
        io.to(t.id).emit('kicked');
        setTimeout(() => io.sockets.sockets.get(t.id)?.disconnect(true), 300);
        break;
    }
  });

  socket.on('disconnect', () => {
    clearInterval(tick);
    if (!ctx) return;
    const { code, st, att } = ctx;
    att.leftAt = Date.now();
    st.peers.delete(socket.id);
    if (st.spotlight === socket.id) { st.spotlight = null; io.to(code).emit('flags', flagsOf(st)); }
    io.to(code).emit('peer-left', socket.id);
    if (st.peers.size === 0) live.delete(code);
    save();
  });
});

server.listen(PORT, () => {
  console.log(`\n  Signal Classroom running → http://localhost:${PORT}`);
  console.log(`  Admin panel            → http://localhost:${PORT}/admin\n`);
});
