(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(k => k != null && e.append(k));
    return e;
  };
  const toast = (t, ms = 2600) => { const d = el('div', { class: 'toast', text: t }); document.body.append(d); setTimeout(() => d.remove(), ms); };

  const API = (window.SIGNAL_API || '').replace(/\/$/, '');

  // ───────── identity / url ─────────
  const code = (location.pathname.split('/')[2] || '').toUpperCase();
  if (/^#h=/.test(location.hash)) { sessionStorage.setItem('host:' + code, location.hash.slice(3)); history.replaceState(null, '', location.pathname); }
  const hostToken = sessionStorage.getItem('host:' + code) || '';

  // ───────── state ─────────
  let socket = null, me = null, creds = null, ice = [];
  let flags = {}, joinedOnce = false, leaving = false;
  const peers = new Map();            // id -> {info, pc, remote, pending[], initiator}
  const tiles = new Map();            // id|'me' -> element
  let localStream = new MediaStream(), screenTrack = null;
  let micOn = false, camOn = false;
  let board = null, timerEnd = 0, timerTotal = 0, timerInt = null;
  let recorder = null;
  const isHost = () => me && me.role === 'host';

  // ───────── join screen ─────────
  (async () => {
    $('#jName').value = localStorage.getItem('signal:name') || '';
    try {
      const r = await fetch(API + '/api/rooms/' + code);
      if (!r.ok) throw 0;
      const d = await r.json();
      $('#jTitle').textContent = d.title;
      $('#jSub').textContent = hostToken ? 'You are joining as the teacher.' : 'Enter your name to join.';
      if (d.needsPassword && !hostToken) $('#jPassBox').hidden = false;
      if (d.ended && !hostToken) { $('#jErr').textContent = 'This class has ended.'; $('#jBtn').disabled = true; }
    } catch { $('#jTitle').textContent = 'Class not found'; $('#jSub').textContent = 'Check the code or ask your teacher for a new link.'; $('#jBtn').disabled = true; }
  })();

  $('#joinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#jName').value.trim(); if (!name) return;
    localStorage.setItem('signal:name', name);
    $('#jBtn').disabled = true; $('#jErr').textContent = '';
    await acquire($('#jMic').checked, $('#jCam').checked);
    creds = { code, name, password: $('#jPass').value, hostToken };
    connect();
  });

  async function acquire(wantMic, wantCam) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    const tryGet = async c => { try { return await navigator.mediaDevices.getUserMedia(c); } catch { return null; } };
    let s = null;
    if (wantMic && wantCam) s = await tryGet({ audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 640 }, height: { ideal: 360 } } });
    if (!s && wantMic) { s = await tryGet({ audio: { echoCancellation: true, noiseSuppression: true } }); if (wantCam) toast('Camera unavailable — joining audio only'); }
    if (!s && wantCam && !wantMic) s = await tryGet({ video: { width: { ideal: 640 }, height: { ideal: 360 } } });
    if (s) s.getTracks().forEach(t => localStream.addTrack(t));
    micOn = !!audioTrack(); camOn = !!camTrack();
  }
  const audioTrack = () => localStream.getAudioTracks()[0] || null;
  const camTrack = () => localStream.getVideoTracks()[0] || null;
  const outVideo = () => screenTrack || camTrack();

  // ───────── socket ─────────
  function connect() {
    socket = API ? io(API, { transports: ['websocket', 'polling'] }) : io({ transports: ['websocket', 'polling'] });
    socket.on('connect', () => { $('#net').textContent = 'connected'; doJoin(); });
    socket.on('disconnect', () => { if (!leaving) $('#net').textContent = 'reconnecting…'; });
    bindSocket();
  }
  function doJoin() {
    socket.emit('join', creds, res => {
      if (!res.ok) {
        if (!joinedOnce) { $('#jErr').textContent = res.error; $('#jBtn').disabled = false; socket.disconnect(); }
        else bye('Could not rejoin', res.error);
        return;
      }
      onJoined(res);
    });
  }

  function onJoined(res) {
    // rebuild everything (also runs after a reconnect)
    peers.forEach((p, id) => closePeer(id)); peers.clear();
    $('#videos').replaceChildren(); tiles.clear();
    me = res.me; ice = res.ice; flags = res.state.flags;
    document.body.classList.toggle('is-host', isHost());
    $('#join').hidden = true; $('#app').hidden = false;
    $('#title').textContent = res.state.title; document.title = res.state.title + ' — Signal Classroom';
    $('#codeChip').textContent = code;
    if (!joinedOnce) initUi();
    joinedOnce = true;

    makeTile('me');
    res.peers.forEach(p => addPeer(p, true));  // newcomer sends the offers
    board.setState(res.state.board); board.canDraw = canDraw(); syncBoardUi();
    $('#pad').value = res.state.pad || '';
    $('#chatLog').replaceChildren(); res.state.chat.forEach(addChat);
    renderPoll(res.state.poll);
    setTimer(res.state.timer);
    applyFlags(); renderPeople(); paintAll(); sendMedia();
  }

  function bindSocket() {
    socket.on('peer-joined', info => { addPeer(info, false); toast(info.name + ' joined'); renderPeople(); });
    socket.on('peer-left', id => { const p = peers.get(id); if (p) toast(p.info.name + ' left'); closePeer(id); peers.delete(id); tiles.get(id)?.remove(); tiles.delete(id); renderPeople(); });
    socket.on('peer-update', info => {
      if (info.id === me.id) { me = info; board.canDraw = canDraw(); syncBoardUi(); applyFlags(); }
      else { const p = peers.get(info.id); if (!p) return;
        const startedShare = !p.info.screen && info.screen;
        const handUp = !p.info.hand && info.hand;
        p.info = info; if (startedShare && !isHost()) setStageTab('gallery'); if (handUp && isHost()) toast('✋ ' + info.name + ' raised a hand'); }
      renderPeople(); paintAll();
    });
    socket.on('flags', f => { flags = f; applyFlags(); paintAll(); });
    socket.on('signal', onSignal);
    socket.on('chat', m => { addChat(m); if ($('#p-chat').hidden) $('#chatDot').hidden = false; });
    socket.on('force', ({ kind }) => {
      if (kind === 'mute') { setMic(false); toast('The teacher muted you'); }
      if (kind === 'cam-off') { setCam(false); toast('The teacher turned your camera off'); }
      if (kind === 'stop-screen') { stopScreen(); toast('Screen sharing is off for students'); }
    });
    socket.on('kicked', () => { leaving = true; bye('Removed from class', 'The teacher removed you from this class.'); });
    socket.on('ended', () => { leaving = true; bye('Class ended', 'Thanks for joining.'); });

    socket.on('wb:start', ({ page, item }) => board.remoteStart(page, item));
    socket.on('wb:pts', ({ page, id, pts }) => board.remotePts(page, id, pts));
    socket.on('wb:add', ({ page, item }) => board.remoteAdd(page, item));
    socket.on('wb:remove', ({ page, id }) => board.remoteRemove(page, id));
    socket.on('wb:clear', ({ page }) => board.remoteClear(page));
    socket.on('wb:page', ({ index, count }) => board.setPage(index, count));
    socket.on('wb:bg', ({ bg }) => { board.setBg(bg); $('#bgSel').value = bg; });
    socket.on('wb:state', b => board.setState(b));
    socket.on('wb:laser', ({ from, name, x, y }) => board.remoteLaser(from, name, x, y));

    socket.on('pad', t => { const ta = $('#pad'); if (ta.value === t) return; const s = ta.selectionStart; ta.value = t; if (document.activeElement === ta) ta.setSelectionRange(s, s); });
    socket.on('poll', renderPoll);
    socket.on('timer', setTimer);
    socket.on('react', ({ emoji }) => floatEmoji(emoji));
  }

  function bye(title, text) {
    peers.forEach((p, id) => closePeer(id));
    localStream.getTracks().forEach(t => t.stop()); screenTrack?.stop();
    $('#app').hidden = true; $('#join').hidden = true; $('#goodbye').hidden = false;
    $('#byeTitle').textContent = title; $('#byeText').textContent = text;
    try { socket.disconnect(); } catch {}
  }

  // ───────── WebRTC mesh ─────────
  function addPeer(info, initiator) {
    if (peers.has(info.id)) return;
    peers.set(info.id, { info, pc: null, remote: new MediaStream(), pending: [], initiator });
    makeTile(info.id);
    if (initiator) { createPC(info.id, true); sendOffer(info.id); }
  }
  function createPC(id, initiator) {
    const p = peers.get(id);
    const pc = new RTCPeerConnection({ iceServers: ice });
    p.pc = pc;
    if (initiator) {
      pc.addTransceiver(audioTrack() || 'audio', { direction: 'sendrecv', streams: [localStream] });
      pc.addTransceiver(outVideo() || 'video', { direction: 'sendrecv', streams: [localStream] });
    }
    pc.ontrack = e => {
      if (!p.remote.getTracks().includes(e.track)) p.remote.addTrack(e.track);
      const v = $('video', tiles.get(id)); if (v && v.srcObject !== p.remote) v.srcObject = p.remote;
      v && v.play && v.play().catch(() => {});
    };
    pc.onicecandidate = e => { if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && p.initiator && peers.has(id)) sendOffer(id, { iceRestart: true });
    };
    return pc;
  }
  async function sendOffer(id, opts) {
    const p = peers.get(id); if (!p || !p.pc) return;
    const o = await p.pc.createOffer(opts); await p.pc.setLocalDescription(o);
    socket.emit('signal', { to: id, data: { sdp: p.pc.localDescription } });
  }
  async function onSignal({ from, data }) {
    const p = peers.get(from); if (!p) return;
    try {
      if (data.sdp) {
        if (data.sdp.type === 'offer') {
          const fresh = !p.pc;
          if (fresh) createPC(from, false);
          await p.pc.setRemoteDescription(data.sdp);
          if (fresh) { // attach our tracks to the transceivers the offer created
            for (const t of p.pc.getTransceivers()) {
              const kind = t.receiver.track.kind;
              t.direction = 'sendrecv';
              await t.sender.replaceTrack(kind === 'audio' ? audioTrack() : outVideo());
            }
          }
          await flushPending(p);
          const a = await p.pc.createAnswer(); await p.pc.setLocalDescription(a);
          socket.emit('signal', { to: from, data: { sdp: p.pc.localDescription } });
        } else if (p.pc) { await p.pc.setRemoteDescription(data.sdp); await flushPending(p); }
      } else if (data.candidate) {
        if (p.pc && p.pc.remoteDescription) await p.pc.addIceCandidate(data.candidate).catch(() => {});
        else p.pending.push(data.candidate);
      }
    } catch (err) { console.warn('signal error', err); }
  }
  async function flushPending(p) { while (p.pending.length) await p.pc.addIceCandidate(p.pending.shift()).catch(() => {}); }
  function closePeer(id) { const p = peers.get(id); if (p && p.pc) { p.pc.ontrack = p.pc.onicecandidate = p.pc.onconnectionstatechange = null; p.pc.close(); p.pc = null; } }
  const senderOf = (p, kind) => p.pc && p.pc.getTransceivers().find(t => t.receiver.track.kind === kind)?.sender;
  function replaceOnAll(kind, track) { peers.forEach(p => { const s = senderOf(p, kind); if (s) s.replaceTrack(track).catch(() => {}); }); }

  // ───────── local media controls ─────────
  function sendMedia() { socket && socket.connected && socket.emit('media', { mic: micOn, cam: camOn, screen: !!screenTrack }); paintAll(); syncControls(); }
  async function setMic(on) {
    if (on && !audioTrack()) {
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); const t = s.getAudioTracks()[0]; localStream.addTrack(t); replaceOnAll('audio', t); }
      catch { toast('Microphone unavailable'); return; }
    }
    if (audioTrack()) audioTrack().enabled = on;
    micOn = on && !!audioTrack(); sendMedia();
  }
  async function setCam(on) {
    if (on) {
      if (camTrack()) return;
      try { const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 } } }); const t = s.getVideoTracks()[0]; localStream.addTrack(t); camOn = true; if (!screenTrack) replaceOnAll('video', t); }
      catch { toast('Camera unavailable'); return; }
    } else {
      const t = camTrack(); if (t) { t.stop(); localStream.removeTrack(t); }
      camOn = false; if (!screenTrack) replaceOnAll('video', null);
    }
    sendMedia();
  }
  async function toggleScreen() {
    if (screenTrack) return stopScreen();
    if (!isHost() && !flags.screenAll) return toast('The teacher has not enabled screen sharing');
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      screenTrack = s.getVideoTracks()[0]; screenTrack.onended = stopScreen;
      replaceOnAll('video', screenTrack); sendMedia();
    } catch { /* user cancelled */ }
  }
  function stopScreen() {
    if (!screenTrack) return;
    screenTrack.onended = null; screenTrack.stop(); screenTrack = null;
    replaceOnAll('video', camTrack()); sendMedia();
  }

  // ───────── tiles ─────────
  function makeTile(id) {
    const local = id === 'me';
    const v = el('video', { autoplay: true, playsinline: true }); v.muted = local;
    const t = el('div', { class: 'tile' }, v, el('div', { class: 'avatar' }), el('div', { class: 'label' }), el('div', { class: 'badges' }));
    tiles.set(id, t);
    $('#videos').append(t);
    if (!local && peers.get(id)?.remote.getTracks().length) v.srcObject = peers.get(id).remote;
    paintTile(id);
  }
  function paintTile(id) {
    const t = tiles.get(id); if (!t) return;
    const local = id === 'me', info = local ? { ...me, mic: micOn, cam: camOn, screen: !!screenTrack } : peers.get(id)?.info;
    if (!info) return;
    $('.avatar', t).textContent = (info.name || '?').trim().charAt(0).toUpperCase();
    $('.label', t).textContent = info.name + (local ? ' (you)' : '') + (info.role === 'host' ? ' · teacher' : '');
    $('.badges', t).textContent = (info.hand ? '✋' : '') + (info.mic ? '' : '🔇');
    t.classList.toggle('hascam', !!(info.cam || info.screen));
    t.classList.toggle('sharing', !!info.screen);
    t.classList.toggle('spot', flags.spotlight === (local ? me.id : id));
    if (local) { const v = $('video', t), tr = outVideo(); v.srcObject = tr ? new MediaStream([tr]) : null; v.play && v.play().catch(() => {}); }
  }
  function paintAll() { tiles.forEach((_, id) => paintTile(id)); }

  // ───────── UI wiring ─────────
  function canDraw() { return !!me && (me.role === 'host' || me.canDraw); }
  function syncControls() {
    $('#micBtn').classList.toggle('off', !micOn); $('#micBtn').textContent = micOn ? '🎤' : '🔇';
    $('#camBtn').classList.toggle('off', !camOn); $('#camBtn').textContent = camOn ? '📷' : '🚫';
    $('#screenBtn').classList.toggle('on', !!screenTrack);
    $('#handBtn').classList.toggle('on', !!me?.hand);
  }
  function syncBoardUi() {
    const ok = canDraw();
    $('#board').classList.toggle('locked', !ok);
    $('#drawHint').hidden = ok;
    $('#pad').readOnly = !ok;
    $('#padHint').textContent = ok ? '' : 'Read-only: ask the teacher to let you edit.';
    $('#runJs').disabled = false;
    $('#pageLabel').textContent = (board.page + 1) + ' / ' + board.pages.length;
  }
  function applyFlags() {
    $$('[data-set]').forEach(i => { i.checked = !!flags[i.dataset.set]; });
    $('#recBadge').hidden = !flags.recording;
    $('#chatInput').disabled = !!flags.chatLocked && !isHost();
    $('#chatInput').placeholder = flags.chatLocked && !isHost() ? 'Chat is locked by the teacher' : 'Message';
    $('#recBtn').textContent = flags.recording ? '⏹ Stop recording' : '⏺ Record board + audio';
    renderPeople();
  }
  function setStageTab(tab) {
    $('#stage').dataset.tab = tab;
    $$('#stageTabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'board') setTimeout(() => board.fit(), 0);
  }
  function setSideTab(name) {
    $$('#sideTabs .tab').forEach(b => b.classList.toggle('active', b.dataset.p === name));
    ['people', 'chat', 'poll', 'class'].forEach(n => { const p = $('#p-' + n); if (p) p.hidden = n !== name; });
    if (name === 'chat') { $('#chatDot').hidden = true; const l = $('#chatLog'); l.scrollTop = l.scrollHeight; }
  }

  let uiReady = false;
  function initUi() {
    if (uiReady) return; uiReady = true;

    board = new Whiteboard($('#board'), $('#canvasWrap'), $('#boardArea'), {
      emit: (ev, p) => socket && socket.emit(ev, p), myId: () => me.id
    });
    board.onChange = syncBoardUi;

    // tool buttons
    $$('.tool[data-tool]').forEach(b => b.addEventListener('click', () => {
      board.tool = b.dataset.tool; $$('.tool[data-tool]').forEach(x => x.classList.toggle('active', x === b));
    }));
    const colors = ['#111827', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ffffff'];
    colors.forEach((c, i) => {
      const b = el('button', { class: 'sw' + (i === 0 ? ' active' : ''), style: 'background:' + c, 'aria-label': 'Colour ' + c, type: 'button' });
      b.addEventListener('click', () => pickColor(c)); $('#swatches').append(b);
    });
    function pickColor(c) { board.color = c; $('#colorPick').value = c; $$('.sw').forEach(s => s.classList.toggle('active', s.style.background && rgb2hex(s.style.background) === c)); }
    const rgb2hex = s => { const m = s.match(/\d+/g); return m ? '#' + m.slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('') : s; };
    $('#colorPick').addEventListener('input', e => pickColor(e.target.value));
    $('#sizeRange').addEventListener('input', e => { board.size = +e.target.value; });
    $('#undo').addEventListener('click', () => board.undo());
    $('#redo').addEventListener('click', () => board.redo());
    document.addEventListener('keydown', e => {
      if (/input|textarea|select/i.test(document.activeElement.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); board.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); board.redo(); }
    });
    $('#savePng').addEventListener('click', () => {
      const a = el('a', { href: board.png(), download: 'board-' + code + '-p' + (board.page + 1) + '.png' }); a.click();
    });
    $('#clearPage').addEventListener('click', () => { if (confirm('Clear this page for everyone?')) socket.emit('wb:clear', { page: board.page }); });
    $('#bgSel').addEventListener('change', e => { board.setBg(e.target.value); socket.emit('wb:bg', { bg: e.target.value }); });
    $('#prevPage').addEventListener('click', () => board.page > 0 && socket.emit('wb:page', { index: board.page - 1 }));
    $('#nextPage').addEventListener('click', () => board.page < board.pages.length - 1 && socket.emit('wb:page', { index: board.page + 1 }));
    $('#newPage').addEventListener('click', () => socket.emit('wb:newpage'));

    // tabs
    $$('#stageTabs .tab').forEach(b => b.addEventListener('click', () => setStageTab(b.dataset.tab)));
    $$('#sideTabs .tab').forEach(b => b.addEventListener('click', () => setSideTab(b.dataset.p)));
    setSideTab('people');

    // footer controls
    $('#micBtn').addEventListener('click', () => setMic(!micOn));
    $('#camBtn').addEventListener('click', () => setCam(!camOn));
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) $('#screenBtn').hidden = true;
    $('#screenBtn').addEventListener('click', toggleScreen);
    $('#handBtn').addEventListener('click', () => socket.emit('hand', { up: !me.hand }));
    $('#leaveBtn').addEventListener('click', () => { leaving = true; bye('You left the class', 'You can rejoin any time with the same link.'); });
    $('#codeChip').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.origin + '/r/' + code); toast('Student link copied'); } catch { toast(location.origin + '/r/' + code, 6000); } });

    ['👍', '👏', '❤️', '😂', '🎉', '🤯', '❓'].forEach(em => $('#reactBar').append(el('button', { text: em, type: 'button', onclick: () => { socket.emit('react', { emoji: em }); $('#reactBar').hidden = true; } })));
    $('#reactBtn').addEventListener('click', () => { $('#reactBar').hidden = !$('#reactBar').hidden; });

    // chat
    $('#chatForm').addEventListener('submit', e => {
      e.preventDefault();
      const text = $('#chatInput').value.trim(); if (!text) return;
      socket.emit('chat', { text, priv: $('#privChk').checked }); $('#chatInput').value = '';
    });
    $('#fileIn').addEventListener('change', e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      if (f.size > 2 * 1024 * 1024) return toast('File too large (max 2 MB)');
      const r = new FileReader();
      r.onload = () => socket.emit('chat', { text: '', file: { name: f.name, data: r.result }, priv: $('#privChk').checked });
      r.readAsDataURL(f);
    });

    // pad
    let padT = null;
    $('#pad').addEventListener('input', () => { clearTimeout(padT); padT = setTimeout(() => socket.emit('pad', { text: $('#pad').value }), 150); });
    $('#pad').addEventListener('keydown', e => {
      if (e.key === 'Tab') { e.preventDefault(); const t = e.target, s = t.selectionStart; t.setRangeText('  ', s, t.selectionEnd, 'end'); t.dispatchEvent(new Event('input')); }
    });
    $('#padCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#pad').value); toast('Copied'); } catch { toast('Copy failed'); } });
    $('#padSave').addEventListener('click', () => {
      const a = el('a', { href: URL.createObjectURL(new Blob([$('#pad').value], { type: 'text/plain' })), download: 'notes-' + code + '.txt' }); a.click(); URL.revokeObjectURL(a.href);
    });
    $('#runJs').addEventListener('click', runJs);

    // host: poll, rules, timer, record, end
    $('#pollForm').addEventListener('submit', e => {
      e.preventDefault();
      socket.emit('poll:start', { q: $('#pollQ').value, opts: $('#pollO').value.split('\n') });
      $('#pollQ').value = ''; $('#pollO').value = '';
    });
    $$('[data-set]').forEach(i => i.addEventListener('change', () => socket.emit('room-set', { key: i.dataset.set, value: i.checked })));
    $('#muteAll').addEventListener('click', () => socket.emit('mod', { action: 'mute-all' }));
    $('#lowerAll').addEventListener('click', () => socket.emit('mod', { action: 'lower-all' }));
    $('#timerStart').addEventListener('click', () => socket.emit('timer:set', { seconds: (+$('#timerMin').value || 1) * 60 }));
    $('#timerStop').addEventListener('click', () => socket.emit('timer:set', { seconds: 0 }));
    $('#recBtn').addEventListener('click', toggleRecording);
    $('#endClass').addEventListener('click', () => { if (confirm('End this class for everyone? Students will be disconnected.')) socket.emit('mod', { action: 'end-class' }); });

    if (isHost()) initLessons();

    window.addEventListener('beforeunload', e => { if (isHost() && flags.recording) { e.preventDefault(); e.returnValue = ''; } });
  }

  // ───────── course library (teacher): load a lesson into the pad or ask its quiz as a poll ─────────
  const lessonMap = new Map(); let quizPtr = {};
  async function initLessons() {
    const sel = $('#lessonSel');
    try {
      const list = await (await fetch('/content/index.json')).json();
      sel.replaceChildren(el('option', { value: '', text: 'Select a lesson…' }));
      for (const c of list) {
        const data = await (await fetch('/content/' + c.id + '.json')).json();
        for (const m of data.modules) {
          const g = el('optgroup', { label: c.title + ' · ' + m.title });
          for (const l of m.lessons) { lessonMap.set(l.id, { ...l, course: c.id }); g.append(el('option', { value: l.id, text: l.title })); }
          sel.append(g);
        }
      }
    } catch { sel.replaceChildren(el('option', { value: '', text: 'Could not load lessons' })); return; }
    sel.addEventListener('change', () => { const l = lessonMap.get(sel.value); $('#lessonOpen').href = l ? '/course?c=' + l.course + '#' + l.id : '/courses'; });
    $('#lessonPad').addEventListener('click', () => {
      const l = lessonMap.get(sel.value); if (!l) return toast('Pick a lesson first');
      const pad = $('#pad');
      if (pad.value.trim() && !confirm('Replace the current pad text with this lesson outline?')) return;
      pad.value = lessonOutline(l); socket.emit('pad', { text: pad.value }); setStageTab('pad'); toast('Outline sent to the pad');
    });
    $('#lessonPoll').addEventListener('click', () => {
      const l = lessonMap.get(sel.value); if (!l) return toast('Pick a lesson first');
      const i = (quizPtr[l.id] || 0) % l.quiz.length, q = l.quiz[i]; quizPtr[l.id] = i + 1;
      socket.emit('poll:start', { q: q.q, opts: q.options });
      setSideTab('poll'); toast('Correct answer (only you see this): ' + q.options[q.answer], 9000);
    });
  }
  function lessonOutline(l) {
    const out = ['# ' + l.title, '', 'Goals:'];
    l.goals.forEach(g => out.push('- ' + g));
    out.push('', 'Key ideas:');
    l.notes.forEach(n => {
      if (typeof n === 'string') out.push(n);
      else if (n.h) out.push('', '## ' + n.h);
      else if (n.f) out.push('    ' + n.f);
      else if (n.list) n.list.forEach(t => out.push('- ' + t));
    });
    l.examples.forEach((e, i) => out.push('', 'Example ' + (i + 1) + ': ' + e.q, '(work it out together on the board)'));
    out.push('', 'Try it:');
    l.practice.forEach((q, i) => out.push((i + 1) + '. ' + q.q));
    return out.join('\n');
  }

  // ───────── people list (with teacher controls) ─────────
  function renderPeople() {
    const box = $('#peopleList'); if (!box || !me) return;
    box.replaceChildren();
    const all = [{ ...me, mic: micOn, cam: camOn, _me: true }, ...[...peers.values()].map(p => p.info)];
    all.sort((a, b) => (a.role === 'host' ? -1 : 1) - (b.role === 'host' ? -1 : 1) || (b.hand ? 1 : 0) - (a.hand ? 1 : 0));
    box.append(el('p', { class: 'hint', text: all.length + ' in class' }));
    for (const p of all) {
      const acts = el('div', { class: 'acts' });
      if (isHost() && !p._me && p.role !== 'host') {
        const m = (action, text, title) => el('button', { class: 'btn small', text, title, onclick: () => socket.emit('mod', { action, target: p.id }) });
        if (p.hand) acts.append(m('lower-hand', '✋ Lower', 'Lower hand'));
        acts.append(m('mute', '🔇', 'Mute'), m('cam-off', '🚫', 'Turn camera off'),
          el('button', { class: 'btn small' + (p.canDraw ? ' on' : ''), text: '✏️', title: p.canDraw ? 'Revoke drawing' : 'Allow drawing', onclick: () => socket.emit('mod', { action: 'toggle-draw', target: p.id }) }),
          m('spotlight', '⭐', 'Spotlight'),
          el('button', { class: 'btn small danger', text: 'Remove', onclick: () => { if (confirm('Remove ' + p.name + ' from the class?')) socket.emit('mod', { action: 'kick', target: p.id }); } }));
      } else if (isHost() && p._me && p.hand) acts.append(el('button', { class: 'btn small', text: 'Lower', onclick: () => socket.emit('hand', { up: false }) }));
      box.append(el('div', { class: 'person' },
        el('span', { class: 'nm', text: p.name + (p._me ? ' (you)' : '') }),
        p.role === 'host' ? el('span', { class: 'pill live', text: 'teacher' }) : (p.canDraw ? el('span', { class: 'pill', text: 'can draw' }) : null),
        p.hand ? el('span', { text: '✋' }) : null,
        el('span', { text: p.mic ? '' : '🔇' }),
        acts));
    }
  }

  // ───────── chat ─────────
  function addChat(m) {
    const log = $('#chatLog');
    const body = el('div', { class: 'msg' + (m.priv ? ' priv' : '') },
      el('div', { class: 'who' }, el('b', { text: m.name }), (m.role === 'host' ? ' · teacher' : '') + (m.priv ? ' · private to teacher' : '') + ' · ' + new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    if (m.text) body.append(el('div', { class: 'txt', text: m.text }));
    if (m.file) {
      if (/^data:image\/(png|jpe?g|gif|webp);/.test(m.file.data)) body.append(el('img', { src: m.file.data, alt: m.file.name }));
      body.append(el('a', { href: m.file.data, download: m.file.name, text: '📎 ' + m.file.name }));
    }
    log.append(body); log.scrollTop = log.scrollHeight;
  }

  // ───────── polls ─────────
  function renderPoll(p) {
    const box = $('#pollBox'); box.replaceChildren();
    if (!p) { box.append(el('p', { class: 'muted', text: isHost() ? 'No active poll. Create one below.' : 'No poll right now.' })); return; }
    box.append(el('h3', { text: p.q, style: 'margin-bottom:8px' }), el('p', { class: 'hint', text: p.total + ' vote' + (p.total === 1 ? '' : 's') + (p.open ? ' · open' : ' · closed') }));
    p.opts.forEach((o, i) => {
      const pct = p.counts && p.total ? Math.round(p.counts[i] / p.total * 100) : 0;
      const b = el('button', { class: 'btn poll-opt' + (p.myVote === i ? ' mine' : ''), disabled: !p.open && !isHost() ? true : false, onclick: () => p.open && socket.emit('poll:vote', { index: i }) },
        p.counts ? el('div', { class: 'bar', style: 'width:' + pct + '%' }) : null,
        el('span', { text: o + (p.counts ? ' — ' + p.counts[i] + ' (' + pct + '%)' : '') }));
      if (isHost()) b.disabled = true;
      box.append(b);
    });
    if (isHost()) box.append(el('div', { class: 'actions', style: 'display:flex;gap:6px;margin-top:8px' },
      p.open ? el('button', { class: 'btn small', text: 'End poll & show results', onclick: () => socket.emit('poll:end') }) : null,
      el('button', { class: 'btn small', text: 'Clear', onclick: () => socket.emit('poll:clear') })));
    else if (p.open && p.myVote == null) setSideTab('poll');
  }

  // ───────── timer ─────────
  function setTimer(t) {
    clearInterval(timerInt);
    const box = $('#timerBox');
    if (!t) { box.hidden = true; return; }
    timerEnd = Date.now() + t.remaining; timerTotal = t.total; box.hidden = false;
    const tick = () => {
      const left = Math.max(0, timerEnd - Date.now());
      const s = Math.ceil(left / 1000);
      box.textContent = '⏱ ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      box.classList.toggle('low', s <= 30);
      if (left <= 0) { clearInterval(timerInt); beep(); toast('⏱ Time is up'); }
    };
    tick(); timerInt = setInterval(tick, 500);
  }
  function beep() {
    try { const a = new AudioContext(), o = a.createOscillator(), g = a.createGain(); o.connect(g); g.connect(a.destination); g.gain.value = .12; o.frequency.value = 880; o.start(); setTimeout(() => { o.stop(); a.close(); }, 450); } catch {}
  }

  function floatEmoji(em) {
    const d = el('div', { class: 'float', text: em, style: 'left:' + (10 + Math.random() * 70) + '%' });
    $('#stage').append(d); setTimeout(() => d.remove(), 2500);
  }

  // ───────── run JS in a sandboxed iframe ─────────
  function runJs() {
    const out = $('#padOut'); out.textContent = '';
    const src = $('#pad').value, id = Math.random().toString(36).slice(2);
    const f = el('iframe', { sandbox: 'allow-scripts', style: 'display:none' });
    const onMsg = e => { if (e.source === f.contentWindow && e.data && e.data.id === id) out.textContent += e.data.t + '\n'; };
    window.addEventListener('message', onMsg);
    f.srcdoc = '<script>const send=t=>parent.postMessage({id:' + JSON.stringify(id) + ',t},"*");' +
      'const fmt=a=>a.map(x=>{try{return typeof x==="string"?x:JSON.stringify(x)}catch(e){return String(x)}}).join(" ");' +
      'console.log=(...a)=>send(fmt(a));console.error=(...a)=>send("Error: "+fmt(a));window.onerror=m=>send("Error: "+m);' +
      'try{eval(' + JSON.stringify(src).replace(/</g, '\\u003c') + ')}catch(e){send("Error: "+e.message)}<\/script>';
    document.body.append(f);
    setTimeout(() => { window.removeEventListener('message', onMsg); f.remove(); if (!out.textContent) out.textContent = '(no output — use console.log)'; }, 4000);
  }

  // ───────── lesson recording (teacher): board + mixed audio → .webm on their device ─────────
  async function toggleRecording() {
    if (recorder) { recorder.stop(); return; }
    if (!window.MediaRecorder) return toast('Recording is not supported in this browser');
    const cv = document.createElement('canvas');
    const draw = () => board.composite(cv);
    draw(); const timer = setInterval(draw, 66);
    const stream = cv.captureStream(15);
    let actx = null;
    try {
      actx = new AudioContext(); const dest = actx.createMediaStreamDestination();
      const add = s => { if (s && s.getAudioTracks().length) actx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest); };
      add(localStream); peers.forEach(p => add(p.remote));
      dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    } catch {}
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm' });
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      clearInterval(timer); actx && actx.close();
      const a = el('a', { href: URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })), download: 'lesson-' + code + '-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.webm' });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      recorder = null; socket.emit('recording', { on: false }); toast('Recording saved to your downloads');
    };
    recorder.start(1000);
    socket.emit('recording', { on: true });
    toast('Recording started — students can see the badge');
  }
})();
