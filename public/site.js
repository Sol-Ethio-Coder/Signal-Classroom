/* Shared by the marketing + course pages. */
(function () {
  document.documentElement.classList.add('js');
  var D = document;

  // scroll reveal
  var els = [].slice.call(D.querySelectorAll('.reveal'));
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (en) { en.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { threshold: .12 });
    els.forEach(function (e) { io.observe(e); });
  } else els.forEach(function (e) { e.classList.add('in'); });

  var y = D.getElementById('year'); if (y) y.textContent = new Date().getFullYear();

  // home: join form
  var f = D.getElementById('joinForm');
  if (f) f.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = D.getElementById('code').value.trim().toUpperCase(), err = D.getElementById('err');
    err.textContent = '';
    if (!/^[A-Z0-9]{4,10}$/.test(code)) { err.textContent = 'Enter the 6-character code from your teacher.'; return; }
    fetch((window.SIGNAL_API || '').replace(/\/$/, '') + '/api/rooms/' + encodeURIComponent(code)).then(function (r) {
      if (!r.ok) err.textContent = 'No class with that code. Check it and try again.'; else location.href = '/r/' + code;
    }).catch(function () { err.textContent = 'Could not reach the server. Try again.'; });
  });

  // home: course teaser from the real course file
  var box = D.getElementById('modList');
  if (box) fetch('/content/maths.json').then(function (r) { return r.json(); }).then(function (c) {
    box.textContent = '';
    c.modules.forEach(function (m, i) {
      var row = D.createElement('div'); row.className = 'mod';
      var n = D.createElement('b'); n.textContent = i + 1;
      var t = D.createElement('div'), s = D.createElement('strong'), sp = D.createElement('span');
      s.textContent = m.title; sp.textContent = m.lessons.length + ' lessons · ' + m.blurb;
      t.append(s, sp); row.append(n, t); box.append(row);
    });
  }).catch(function () {});
})();
