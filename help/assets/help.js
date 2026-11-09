// Search over the guide (search-index.js), and a closed topic list on phones.
(function () {
  const index = window.HELP_INDEX || [];
  const input = document.getElementById('help-search');
  const box = document.getElementById('help-results');
  if (window.matchMedia('(max-width: 52rem)').matches) {
    const details = document.querySelector('.sidebar details');
    if (details) details.open = false;
  }
  if (!input || !box) return;

  const esc = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function search(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return index
      .map(e => {
        // A match in a section's own heading counts most, then the page title, then the text.
        const heading = (e.h || e.t).toLowerCase(), title = e.t.toLowerCase(), text = e.x.toLowerCase();
        let score = 0;
        for (const w of words) {
          if (heading.includes(w)) score += 8;
          else if (title.includes(w)) score += 3;
          else if (text.includes(w)) score += 1;
          else return null;
        }
        return { e, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(r => r.e);
  }
  function snippet(text, q) {
    const w = q.toLowerCase().split(/\s+/).filter(Boolean)[0] || '';
    const at = Math.max(0, text.toLowerCase().indexOf(w) - 40);
    return (at ? '…' : '') + text.slice(at, at + 130) + (text.length > at + 130 ? '…' : '');
  }
  let active = -1;
  function show(q) {
    const hits = search(q);
    active = -1;
    if (!q.trim()) { box.hidden = true; return; }
    box.innerHTML = hits.length
      ? hits.map(h => `<a href="${h.u}"><strong>${esc(h.t)}</strong><span>${esc(snippet(h.x, q))}</span></a>`).join('')
      : '<p>Nothing found. Try other words, or email support@indietix.net.</p>';
    box.hidden = false;
  }
  input.addEventListener('input', () => show(input.value));
  input.addEventListener('keydown', (ev) => {
    const links = box.querySelectorAll('a');
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!links.length) return;
      active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
      links.forEach((l, i) => l.classList.toggle('active', i === active));
    } else if (ev.key === 'Enter') {
      const target = links[active >= 0 ? active : 0];
      if (target) { ev.preventDefault(); window.location.href = target.href; }
    } else if (ev.key === 'Escape') {
      box.hidden = true;
    }
  });
  document.addEventListener('click', (ev) => { if (!ev.target.closest('.search')) box.hidden = true; });
  const q = new URLSearchParams(window.location.search).get('q');
  if (q) { input.value = q; show(q); input.focus(); }
})();
