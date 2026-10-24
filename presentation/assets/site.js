// Page behaviour: the mobile menu, the reading-progress bar, highlighting the
// chapter in view, and hover tooltips on chart marks.

(function () {
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.getElementById('site-nav');
  const closeMenu = () => {
    if (!nav || !nav.classList.contains('open')) return;
    nav.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  };
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) closeMenu(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && nav.classList.contains('open')) { closeMenu(); toggle.focus(); }
    });
  }

  // Reading progress along the bottom edge of the header.
  const bar = document.querySelector('.progress');
  if (bar) {
    const update = () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
    };
    addEventListener('scroll', update, { passive: true });
    addEventListener('resize', update);
    update();
  }

  // Highlight the menu link of the chapter currently in view.
  const links = new Map();
  for (const a of document.querySelectorAll('.site-nav a[href^="#"]')) links.set(a.getAttribute('href').slice(1), a);
  const chapters = [...document.querySelectorAll('.chapter[id]')].filter((c) => links.has(c.id));
  if (chapters.length) {
    const mark = () => {
      const line = innerHeight * 0.35;
      let current = null;
      for (const c of chapters) if (c.getBoundingClientRect().top <= line) current = c.id;
      for (const [id, a] of links) {
        const on = id === current;
        a.classList.toggle('active', on);
        if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
      }
    };
    addEventListener('scroll', mark, { passive: true });
    addEventListener('resize', mark);
    mark();
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
