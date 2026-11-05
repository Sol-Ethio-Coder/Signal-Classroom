(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const API = (window.SIGNAL_API || '').replace(/\/$/, '');
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    kids.flat().forEach(k => k != null && e.append(k));
    return e;
  };
  let token = sessionStorage.getItem('adminToken') || '';
  let timer = null, attRows = [], attTitle = '';

  async function api(path, opts = {}) {
    const r = await fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
    if (r.status === 401 && token) { lock(); throw new Error('Session expired'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  function lock() {
    token = ''; sessionStorage.removeItem('adminToken'); clearInterval(timer);
    $('#login').hidden = false; $('#dash').hidden = true;
  }
  function unlock() { $('#login').hidden = true; $('#dash').hidden = false; load(); loadStatus(); timer = setInterval(load, 10000); }

  async function loadStatus() {
    let s; try { s = await api('/api/admin/status'); } catch { return; }
    const item = (state, title, hint) => el('li', { class: state },
      el('span', { class: 'mark', text: state === 'ok' ? '✓' : state === 'warn' ? '!' : 'i' }),
      el('div', {}, el('strong', { text: title }), hint ? el('small', { text: hint }) : null));
    const list = $('#checklist'); list.replaceChildren(
      s.tempCreds ? item('warn', 'Using a temporary password', 'It changes every restart. Run npm run setup (or set ADMIN_USER and ADMIN_PASSWORD) and restart.')
        : s.weakPass ? item('warn', 'Admin password is short', 'Use 10+ characters. Change ADMIN_PASSWORD and restart.')
        : item('ok', 'Admin login is set'),
      s.https ? item('ok', 'Connection is HTTPS') : item('warn', 'Not using HTTPS', 'Camera and microphone only work on localhost or HTTPS. Deploy behind HTTPS.'),
      s.turn ? item('ok', 'TURN relay configured') : item('info', 'No TURN relay yet', 'Fine for testing. Students on mobile data may fail to connect without one (TURN_URL, TURN_USER, TURN_PASS).'),
      s.customData ? item('ok', 'Data folder configured') : item('info', 'Using default data folder', 'On hosts with temporary disks, set DATA_DIR to a persistent disk or classes reset on restart.'),
      item(s.rooms ? 'ok' : 'info', s.rooms ? s.rooms + ' class' + (s.rooms === 1 ? '' : 'es') + ' created' : 'Create your first class below'));
  }

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault(); $('#loginErr').textContent = '';
    try {
      const r = await fetch(API + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#user').value, password: $('#pass').value }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      token = d.token; sessionStorage.setItem('adminToken', token); $('#pass').value = ''; unlock();
    } catch (err) { $('#loginErr').textContent = err.message; }
  });
  $('#logout').addEventListener('click', lock);

  $('#createForm').addEventListener('submit', async e => {
    e.preventDefault();
    await api('/api/admin/rooms', { method: 'POST', body: JSON.stringify({ title: $('#title').value, password: $('#pw').value }) });
    $('#title').value = ''; $('#pw').value = ''; load();
  });

  const studentLink = c => location.origin + '/r/' + c;
  const teacherLink = r => location.origin + '/r/' + r.code + '#h=' + r.hostToken;
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = o, 1200); }
    catch { prompt('Copy this link:', text); }
  }

  async function load() {
    let rooms;
    try { rooms = await api('/api/admin/rooms'); } catch { return; }
    const box = $('#rooms'); box.replaceChildren();
    if (!rooms.length) box.append(el('p', { class: 'muted', text: 'No classes yet. Create your first one above.' }));
    for (const r of rooms) {
      const ended = r.status === 'ended';
      box.append(el('div', { class: 'card room-card' },
        el('header', {},
          el('strong', { text: r.title }),
          el('span', { class: 'pill ' + (ended ? 'ended' : 'live'), text: ended ? 'Ended' : (r.online + ' online') }),
          r.hasPassword ? el('span', { class: 'pill', text: 'Password' }) : null,
          el('span', { class: 'code', text: r.code })),
        el('div', { class: 'actions' },
          el('a', { class: 'btn primary', href: teacherLink(r), target: '_blank', rel: 'noopener', text: 'Enter as teacher' }),
          el('button', { class: 'btn', text: 'Copy student link', onclick: e => copy(studentLink(r.code), e.target) }),
          el('button', { class: 'btn', text: 'Copy teacher link', onclick: e => copy(teacherLink(r), e.target) }),
          el('button', { class: 'btn', text: 'Attendance (' + r.attendanceCount + ')', onclick: () => showAttendance(r) }),
          el('button', { class: 'btn', text: ended ? 'Reopen' : 'End class', onclick: async () => { await api('/api/admin/rooms/' + r.code + '/status', { method: 'POST', body: JSON.stringify({ status: ended ? 'open' : 'ended' }) }); load(); } }),
          el('button', { class: 'btn', text: 'Clear board', onclick: async () => { if (confirm('Erase every board page for this class?')) { await api('/api/admin/rooms/' + r.code + '/reset-board', { method: 'POST' }); } } }),
          el('button', { class: 'btn danger', text: 'Delete', onclick: async () => { if (confirm('Delete "' + r.title + '" and its attendance?')) { await api('/api/admin/rooms/' + r.code, { method: 'DELETE' }); load(); } } })),
        el('p', { class: 'hint muted', text: 'The teacher link is private — anyone with it controls the room.' })));
    }
  }

  const fmt = t => t ? new Date(t).toLocaleString() : '—';
  const mins = (a, b) => b ? Math.max(1, Math.round((b - a) / 60000)) + ' min' : 'in class';
  async function showAttendance(r) {
    attRows = await api('/api/admin/rooms/' + r.code + '/attendance'); attTitle = r.title;
    $('#dlgTitle').textContent = 'Attendance — ' + r.title;
    const t = $('#attTable'); t.replaceChildren();
    t.append(el('tr', {}, ...['Name', 'Role', 'Joined', 'Left', 'Time'].map(h => el('th', { text: h }))));
    if (!attRows.length) t.append(el('tr', {}, el('td', { text: 'Nobody has joined yet.', colspan: 5 })));
    attRows.slice().reverse().forEach(a => t.append(el('tr', {}, el('td', { text: a.name }), el('td', { text: a.role }), el('td', { text: fmt(a.joinedAt) }), el('td', { text: fmt(a.leftAt) }), el('td', { text: mins(a.joinedAt, a.leftAt) }))));
    $('#dlg').showModal();
  }
  $('#close').addEventListener('click', () => $('#dlg').close());
  $('#csv').addEventListener('click', () => {
    const q = s => '"' + String(s).replace(/"/g, '""') + '"';
    const rows = [['Name', 'Role', 'Joined', 'Left', 'Minutes']].concat(attRows.map(a => [a.name, a.role, new Date(a.joinedAt).toISOString(), a.leftAt ? new Date(a.leftAt).toISOString() : '', a.leftAt ? Math.round((a.leftAt - a.joinedAt) / 60000) : '']));
    const blob = new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'attendance-' + attTitle.replace(/\W+/g, '-') + '.csv' });
    a.click(); URL.revokeObjectURL(a.href);
  });

  if (token) unlock();
})();
