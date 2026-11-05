/* Whiteboard — logical 1600x900 canvas, items are replayable JSON so late joiners get the full board.
 * hooks: { emit(event, payload), myId() } */
class Whiteboard {
  constructor(canvas, wrap, area, hooks) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.wrap = wrap; this.area = area; this.hooks = hooks;
    this.W = 1600; this.H = 900;
    canvas.width = this.W; canvas.height = this.H;
    this.pages = [[]]; this.page = 0; this.bg = 'grid';
    this.tool = 'pen'; this.color = '#111827'; this.size = 4;
    this.canDraw = false;
    this.cur = null;            // item being drawn
    this.buf = [];              // pen points waiting to be sent
    this.flushT = null;
    this.redoStack = [];
    this.lasers = new Map();    // id -> {x,y,t,name}
    this.lastLaserSent = 0;
    this.raf = 0;
    this.onChange = () => {};
    this._bind();
    new ResizeObserver(() => this.fit()).observe(area);
    this.fit();
  }

  /* ───────── layout ───────── */
  fit() {
    const r = this.area.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const w = Math.min(r.width, r.height * 16 / 9);
    this.wrap.style.width = Math.floor(w) + 'px';
    this.wrap.style.height = Math.floor(w * 9 / 16) + 'px';
    this.render();
  }

  /* ───────── state ───────── */
  setState(b) {
    this.pages = b.pages && b.pages.length ? b.pages : [[]];
    this.page = Math.min(b.page || 0, this.pages.length - 1);
    this.setBg(b.bg || 'grid');
    this.redoStack = [];
    this.render(); this.onChange();
  }
  setBg(bg) { this.bg = bg; this.wrap.dataset.bg = bg; }
  setPage(i, count) {
    while (this.pages.length < count) this.pages.push([]);
    this.page = Math.max(0, Math.min(i, this.pages.length - 1));
    this.cur = null; this.redoStack = [];
    this.render(); this.onChange();
  }
  get items() { return this.pages[this.page]; }

  /* ───────── remote events ───────── */
  remoteStart(page, item) { (this.pages[page] ||= []).push(item); if (page === this.page) this.render(); }
  remotePts(page, id, pts) {
    const it = (this.pages[page] || []).find(x => x.id === id);
    if (it && it.pts) { it.pts.push(...pts); if (page === this.page) this.render(); }
  }
  remoteAdd(page, item) { this.remoteStart(page, item); }
  remoteRemove(page, id) {
    const a = this.pages[page]; if (!a) return;
    const i = a.findIndex(x => x.id === id);
    if (i >= 0) { a.splice(i, 1); if (page === this.page) this.render(); }
  }
  remoteClear(page) { this.pages[page] = []; if (page === this.page) this.render(); }
  remoteLaser(id, name, x, y) { this.lasers.set(id, { x, y, t: performance.now(), name }); this._loop(); }

  /* ───────── drawing primitives ───────── */
  _stroke(ctx, it) {
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = ctx.fillStyle = it.color;
    ctx.lineWidth = it.size;
    if (it.tool === 'highlighter') { ctx.globalAlpha = 0.32; ctx.lineWidth = it.size * 3; ctx.lineCap = 'butt'; }
    if (it.tool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.lineWidth = it.size * 4; ctx.strokeStyle = '#000'; }
    switch (it.tool) {
      case 'pen': case 'highlighter': case 'eraser': {
        const p = it.pts; if (!p || !p.length) break;
        ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
        if (p.length === 1) ctx.lineTo(p[0][0] + 0.01, p[0][1]);
        for (let i = 1; i < p.length - 1; i++) {
          const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
          ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
        }
        if (p.length > 1) ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
        ctx.stroke(); break;
      }
      case 'line': ctx.beginPath(); ctx.moveTo(...it.a); ctx.lineTo(...it.b); ctx.stroke(); break;
      case 'rect': ctx.strokeRect(it.a[0], it.a[1], it.b[0] - it.a[0], it.b[1] - it.a[1]); break;
      case 'ellipse': {
        const cx = (it.a[0] + it.b[0]) / 2, cy = (it.a[1] + it.b[1]) / 2;
        ctx.beginPath(); ctx.ellipse(cx, cy, Math.abs(it.b[0] - it.a[0]) / 2, Math.abs(it.b[1] - it.a[1]) / 2, 0, 0, Math.PI * 2); ctx.stroke(); break;
      }
      case 'arrow': {
        const [x1, y1] = it.a, [x2, y2] = it.b, ang = Math.atan2(y2 - y1, x2 - x1), h = 12 + it.size * 2;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.moveTo(x2, y2); ctx.lineTo(x2 - h * Math.cos(ang - 0.45), y2 - h * Math.sin(ang - 0.45));
        ctx.moveTo(x2, y2); ctx.lineTo(x2 - h * Math.cos(ang + 0.45), y2 - h * Math.sin(ang + 0.45));
        ctx.stroke(); break;
      }
      case 'text': {
        ctx.font = `600 ${this._font(it.size)}px "Segoe UI",system-ui,sans-serif`;
        ctx.textBaseline = 'top';
        it.text.split('\n').forEach((ln, i) => ctx.fillText(ln, it.at[0], it.at[1] + i * this._font(it.size) * 1.2));
        break;
      }
    }
    ctx.restore();
  }
  _font(size) { return 16 + size * 3; }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);
    for (const it of this.items) this._stroke(ctx, it);
    if (this.cur && !this.cur.live) this._stroke(ctx, this.cur);
    const now = performance.now();
    for (const [id, l] of this.lasers) {
      const age = now - l.t;
      if (age > 1400) { this.lasers.delete(id); continue; }
      ctx.save(); ctx.globalAlpha = 1 - age / 1400;
      ctx.fillStyle = '#ff2d55'; ctx.shadowColor = '#ff2d55'; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(l.x, l.y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.font = '600 20px sans-serif'; ctx.fillStyle = '#ff2d55';
      ctx.fillText(l.name, l.x + 14, l.y - 10); ctx.restore();
    }
  }
  _loop() {
    if (this.raf) return;
    const step = () => { this.render(); this.raf = this.lasers.size ? requestAnimationFrame(step) : 0; };
    this.raf = requestAnimationFrame(step);
  }

  /* ───────── input ───────── */
  _pos(e) {
    const r = this.c.getBoundingClientRect();
    return [Math.max(0, Math.min(this.W, (e.clientX - r.left) / r.width * this.W)),
            Math.max(0, Math.min(this.H, (e.clientY - r.top) / r.height * this.H))];
  }
  _id() { return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now()); }

  _bind() {
    const c = this.c;
    c.addEventListener('pointerdown', e => {
      if (!this.canDraw || e.button > 0) return;
      this._commitText();
      const p = this._pos(e), me = this.hooks.myId();
      if (this.tool === 'laser') { c.setPointerCapture(e.pointerId); this.cur = { live: true, laser: true }; this._laser(p, true); return; }
      if (this.tool === 'text') { this._textAt(p, e); return; }
      c.setPointerCapture(e.pointerId);
      const base = { id: this._id(), tool: this.tool, color: this.color, size: this.size, owner: me };
      if (['pen', 'highlighter', 'eraser'].includes(this.tool)) {
        this.cur = { ...base, pts: [p], live: true };
        this.items.push(this.cur);
        this.hooks.emit('wb:start', { page: this.page, item: { ...base, pts: [p] } });
      } else {
        this.cur = { ...base, a: p, b: p };
      }
      this.render();
    });
    c.addEventListener('pointermove', e => {
      if (!this.cur) return;
      const p = this._pos(e);
      if (this.cur.laser) return this._laser(p, false);
      if (this.cur.pts) {
        const last = this.cur.pts[this.cur.pts.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5) return;
        this.cur.pts.push(p); this.buf.push(p);
        if (!this.flushT) this.flushT = setTimeout(() => this._flush(), 40);
      } else this.cur.b = p;
      this.render();
    });
    const end = () => {
      if (!this.cur) return;
      const it = this.cur;
      if (it.pts) this._flush(it.id);
      this.cur = null;
      if (it.laser) return;
      if (it.pts) { this.redoStack = []; }
      else {
        if (Math.hypot(it.b[0] - it.a[0], it.b[1] - it.a[1]) > 3) {
          this.items.push(it);
          this.hooks.emit('wb:add', { page: this.page, item: it });
          this.redoStack = [];
        }
      }
      this.render(); this.onChange();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }
  _flush(id) {
    clearTimeout(this.flushT); this.flushT = null;
    id = id || (this.cur && this.cur.id);
    if (!this.buf.length || !id) { this.buf = []; return; }
    this.hooks.emit('wb:pts', { page: this.page, id, pts: this.buf });
    this.buf = [];
  }
  _laser(p, first) {
    const now = performance.now();
    this.lasers.set('me', { x: p[0], y: p[1], t: now, name: '' }); this._loop();
    if (first || now - this.lastLaserSent > 40) { this.lastLaserSent = now; this.hooks.emit('wb:laser', { x: p[0], y: p[1] }); }
  }

  /* text tool: floating input above the canvas */
  _textAt(p) {
    const r = this.c.getBoundingClientRect(), wr = this.wrap.getBoundingClientRect();
    const input = document.createElement('textarea');
    input.id = 'textInput'; input.rows = 1;
    const scale = r.width / this.W, fs = this._font(this.size) * scale;
    Object.assign(input.style, { left: (p[0] * scale + (r.left - wr.left)) + 'px', top: (p[1] * scale + (r.top - wr.top)) + 'px',
      fontSize: fs + 'px', color: this.color, fontWeight: 600, lineHeight: 1.2, resize: 'none', overflow: 'hidden' });
    this.wrap.append(input);
    this.textState = { input, p };
    setTimeout(() => input.focus(), 0);
    input.addEventListener('input', () => { input.rows = input.value.split('\n').length; });
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { input.remove(); this.textState = null; }
      else if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); this._commitText(); }
    });
    input.addEventListener('blur', () => this._commitText());
  }
  _commitText() {
    const t = this.textState; if (!t) return;
    this.textState = null;
    const text = t.input.value.trim(); t.input.remove();
    if (!text) return;
    const it = { id: this._id(), tool: 'text', color: this.color, size: this.size, owner: this.hooks.myId(), at: t.p, text: text.slice(0, 300) };
    this.items.push(it); this.redoStack = [];
    this.hooks.emit('wb:add', { page: this.page, item: it });
    this.render(); this.onChange();
  }

  /* ───────── actions ───────── */
  undo() {
    if (!this.canDraw) return;
    const me = this.hooks.myId(), a = this.items;
    for (let i = a.length - 1; i >= 0; i--) if (a[i].owner === me) {
      const [it] = a.splice(i, 1);
      this.redoStack.push(it);
      this.hooks.emit('wb:remove', { page: this.page, id: it.id });
      this.render(); this.onChange(); return;
    }
  }
  redo() {
    if (!this.canDraw || !this.redoStack.length) return;
    const it = this.redoStack.pop();
    this.items.push(it);
    this.hooks.emit('wb:add', { page: this.page, item: it });
    this.render(); this.onChange();
  }
  /** Draws background + strokes for the current page onto a fresh canvas (for PNG / recording). */
  composite(target) {
    const cv = target || document.createElement('canvas');
    cv.width = this.W; cv.height = this.H;
    const x = cv.getContext('2d');
    x.fillStyle = this.bg === 'dark' ? '#16322b' : '#ffffff'; x.fillRect(0, 0, this.W, this.H);
    x.strokeStyle = '#dbe3ef'; x.lineWidth = 1;
    if (this.bg === 'grid' || this.bg === 'lines') {
      const s = 50; x.beginPath();
      for (let y = 0; y <= this.H; y += s) { x.moveTo(0, y); x.lineTo(this.W, y); }
      if (this.bg === 'grid') for (let xx = 0; xx <= this.W; xx += s) { x.moveTo(xx, 0); x.lineTo(xx, this.H); }
      x.stroke();
    }
    x.drawImage(this.c, 0, 0);
    return cv;
  }
  png() { return this.composite().toDataURL('image/png'); }
}
window.Whiteboard = Whiteboard;
