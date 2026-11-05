/* Theme: dark/light, remembered, follows the OS the first time. Loaded in <head> to avoid a flash. */
(function () {
  var KEY = 'signal:theme', root = document.documentElement, t = null;
  try { t = localStorage.getItem(KEY); } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  root.setAttribute('data-theme', t);
  function meta() { var m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', root.getAttribute('data-theme') === 'light' ? '#f3f5fa' : '#0d1626'); }
  document.addEventListener('DOMContentLoaded', function () {
    meta();
    [].forEach.call(document.querySelectorAll('[data-theme-toggle]'), function (b) {
      function paint() { var dark = root.getAttribute('data-theme') === 'dark'; b.textContent = dark ? '☀️' : '🌙'; b.title = b.ariaLabel = dark ? 'Switch to light mode' : 'Switch to dark mode'; }
      paint();
      b.addEventListener('click', function () {
        var n = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', n); try { localStorage.setItem(KEY, n); } catch (e) {} paint(); meta();
      });
    });
  });
})();
