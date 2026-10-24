// Shared page behaviour: the mobile menu and hover tooltips on chart marks.

(function () {
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && nav.classList.contains('open')) {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  }

  // Any element with data-tip shows its text on hover or focus.
  const marks = document.querySelectorAll('[data-tip]');
  if (!marks.length) return;
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  const place = (x, y) => {
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(x + 14, window.innerWidth - r.width - 8) + 'px';
    tip.style.top = Math.max(8, y - r.height - 12) + 'px';
  };
  for (const el of marks) {
    el.addEventListener('pointerenter', (e) => { tip.textContent = el.dataset.tip; tip.classList.add('show'); place(e.clientX, e.clientY); });
    el.addEventListener('pointermove', (e) => place(e.clientX, e.clientY));
    el.addEventListener('pointerleave', () => tip.classList.remove('show'));
    el.addEventListener('focus', () => {
      const r = el.getBoundingClientRect();
      tip.textContent = el.dataset.tip; tip.classList.add('show'); place(r.left + r.width / 2, r.top);
    });
    el.addEventListener('blur', () => tip.classList.remove('show'));
  }
})();
