(() => {
  'use strict';
  const $ = s => document.querySelector(s);
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

  const courseId = (new URLSearchParams(location.search).get('c') || 'maths').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(courseId)) { $('#lesson').textContent = 'Course not found.'; return; }
  const KEY = 'signal:progress:' + courseId;
  let course, flat = [], idx = 0, prog = {};
  try { prog = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { prog = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prog)); } catch {} };
  const P = id => (prog[id] ||= { practice: {}, quiz: {}, done: false });

  fetch('/content/' + courseId + '.json').then(r => { if (!r.ok) throw 0; return r.json(); }).then(c => {
    course = c;
    c.modules.forEach(m => m.lessons.forEach(l => flat.push({ ...l, module: m.title })));
    const hash = location.hash.slice(1);
    const i = flat.findIndex(l => l.id === hash);
    idx = i >= 0 ? i : Math.max(0, flat.findIndex(l => !P(l.id).done));
    document.title = c.title + ' — Signal Classroom';
    render();
  }).catch(() => { $('#lesson').textContent = 'Could not load this course.'; });

  window.addEventListener('hashchange', () => {
    const i = flat.findIndex(l => l.id === location.hash.slice(1));
    if (i >= 0 && i !== idx) { idx = i; render(); }
  });

  /* ---- answer checking ---- */
  function parseNum(s) {
    s = String(s).trim().replace(/[−–]/g, '-').replace(/,/g, '').replace(/\s+/g, '').replace(/^[a-z]=/i, '').replace(/[a-z°%²]+$/i, '');
    const f = s.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
    if (f) return +f[1] / +f[2];
    return /^-?\d*\.?\d+$/.test(s) ? Number(s) : NaN;
  }

  /* ---- rendering ---- */
  function setProgress() {
    const done = flat.filter(l => P(l.id).done).length;
    return { done, total: flat.length, pct: Math.round(done / flat.length * 100) };
  }
  function renderSyllabus() {
    const box = $('#syllabus'); box.replaceChildren();
    const { done, total, pct } = setProgress();
    box.append(el('h2', { text: course.title }), el('div', { class: 'muted', text: course.level + ' · ' + done + ' of ' + total + ' done' }),
      el('div', { class: 'progress' }, el('i', { style: 'width:' + pct + '%' })));
    course.modules.forEach((m, mi) => {
      box.append(el('h3', { text: 'Module ' + (mi + 1) + ' · ' + m.title }));
      m.lessons.forEach(l => {
        const i = flat.findIndex(x => x.id === l.id), d = P(l.id).done;
        box.append(el('button', { class: 'lnk' + (i === idx ? ' active' : '') + (d ? ' done' : ''), type: 'button', onclick: () => go(i) },
          el('span', { class: 'st', text: d ? '✓' : '' }), el('span', { text: l.title }), el('small', { text: l.minutes + 'm' })));
      });
    });
  }
  function go(i) {
    idx = Math.max(0, Math.min(flat.length - 1, i));
    history.replaceState(null, '', '#' + flat[idx].id);
    render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function checkDone(l) {
    const p = P(l.id);
    const allPrac = l.practice.every((_, i) => p.practice[i] === true);
    const allQuiz = l.quiz.every((q, i) => p.quiz[i] === q.answer);
    if (allPrac && allQuiz && !p.done) { p.done = true; save(); renderSyllabus(); const n = $('#doneNote'); if (n) n.hidden = false; }
  }

  function renderNotes(notes) {
    return notes.map(n => {
      if (typeof n === 'string') return el('p', { text: n });
      if (n.h) return el('h3', { class: 'sub', text: n.h });
      if (n.f) return el('div', { class: 'formula', text: n.f });
      if (n.list) return el('ul', {}, n.list.map(t => el('li', { text: t })));
      return null;
    });
  }

  function render() {
    renderSyllabus();
    const l = flat[idx], p = P(l.id), root = $('#lesson'); root.replaceChildren();
    root.append(
      el('div', { class: 'eyebrow', text: l.module + ' · ' + l.minutes + ' min' }),
      el('h1', { text: l.title }),
      el('div', { class: 'goals' }, el('strong', { text: 'By the end you can' }), el('ul', {}, l.goals.map(g => el('li', { text: g })))),
      el('h2', { text: 'Key ideas' }), ...renderNotes(l.notes),
      el('h2', { text: 'Worked examples' }),
      ...l.examples.map((ex, i) => el('div', { class: 'ex' },
        el('div', { class: 'q', text: 'Example ' + (i + 1) + '. ' + ex.q }),
        el('details', {}, el('summary', { text: 'Show the steps' }), el('ol', {}, ex.steps.map(s => el('li', { text: s })))),
        el('span', { class: 'ans', text: 'Answer: ' + ex.a }))),
      el('h2', { text: 'Practice' }),
      el('p', { class: 'muted', text: 'Type a number or a fraction such as 3/8. Answers are checked for you.' }),
      el('div', { class: 'prac' }, l.practice.map((q, i) => practiceItem(l, q, i))),
      el('h2', { text: 'Quick quiz' }),
      ...l.quiz.map((q, i) => quizItem(l, q, i)),
      el('div', { class: 'tip' }, el('span', { text: '💡' }), el('div', {}, el('strong', { text: 'Tutor tip. ' }), l.tip)),
      el('p', { id: 'doneNote', class: 'fb good', hidden: !p.done, text: '✓ Lesson complete. Great work!' }),
      el('div', { class: 'pager' },
        el('button', { class: 'btn', type: 'button', disabled: idx === 0, text: '← Previous', onclick: () => go(idx - 1) }),
        el('div', { class: 'toolrow' }, el('button', { class: 'btn', type: 'button', text: 'Print or save as PDF', onclick: () => window.print() }),
          el('button', { class: 'btn', type: 'button', text: 'Reset this lesson', onclick: () => { delete prog[l.id]; save(); render(); } })),
        el('button', { class: 'btn primary', type: 'button', disabled: idx === flat.length - 1, text: 'Next lesson →', onclick: () => go(idx + 1) })));
    // restore saved state
    l.practice.forEach((q, i) => { if (p.practice[i] === true) markPractice(i, q, true); });
  }

  const practiceEls = {};
  function practiceItem(l, q, i) {
    const input = el('input', { type: 'text', inputmode: 'text', autocomplete: 'off', 'aria-label': 'Your answer to question ' + (i + 1), placeholder: 'Your answer' });
    const fb = el('div', { class: 'fb', role: 'status' });
    const hintBtn = q.hint ? el('button', { class: 'btn small', type: 'button', text: 'Hint', onclick: () => { fb.className = 'fb'; fb.textContent = '💡 ' + q.hint; } }) : null;
    const solBtn = el('button', { class: 'btn small', type: 'button', text: 'Show solution', onclick: () => { fb.className = 'fb'; fb.textContent = 'Solution: ' + q.sol + ' (answer: ' + q.a + ')'; } });
    const check = () => {
      const n = parseNum(input.value);
      if (Number.isNaN(n)) { fb.className = 'fb bad'; fb.textContent = 'Enter a number (for example 12, −3 or 3/8).'; return; }
      if (Math.abs(n - q.a) <= (q.tol ?? 0.01)) { P(l.id).practice[i] = true; save(); markPractice(i, q, true); checkDone(l); }
      else { fb.className = 'fb bad'; fb.textContent = 'Not quite. Try again, or open the hint.'; }
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') check(); });
    const box = el('div', { class: 'pq' }, el('div', {}, el('strong', { text: (i + 1) + '. ' }), q.q),
      el('div', { class: 'row2' }, input, el('button', { class: 'btn primary small', type: 'button', text: 'Check', onclick: check }), hintBtn, solBtn), fb);
    practiceEls[i] = { box, input, fb };
    return box;
  }
  function markPractice(i, q, ok) {
    const e = practiceEls[i]; if (!e) return;
    e.box.classList.toggle('ok', ok); e.input.value = q.a; e.input.disabled = ok;
    e.fb.className = 'fb good'; e.fb.textContent = '✓ Correct. ' + q.sol;
  }

  function quizItem(l, q, qi) {
    const p = P(l.id), box = el('div', { class: 'pq' }), fb = el('div', { class: 'fb', role: 'status' });
    const btns = q.options.map((o, oi) => el('button', { class: 'btn opt', type: 'button', text: o, onclick: () => pick(oi) }));
    const paint = ch => {
      btns.forEach((b, oi) => { b.disabled = ch === q.answer; b.classList.toggle('right', oi === q.answer && ch === q.answer); b.classList.toggle('wrong', oi === ch && ch !== q.answer); });
      fb.className = 'fb ' + (ch === q.answer ? 'good' : 'bad');
      fb.textContent = ch === q.answer ? '✓ Correct. ' + q.why : 'Not quite. Try another answer.';
    };
    function pick(oi) { p.quiz[qi] = oi; save(); paint(oi); checkDone(l); }
    box.append(el('div', {}, el('strong', { text: 'Q' + (qi + 1) + '. ' }), q.q), ...btns, fb);
    if (p.quiz[qi] !== undefined) paint(p.quiz[qi]);
    return box;
  }
})();
