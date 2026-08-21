// Landing-page search/filter over the gallery grid, grouped into
// section/subsection blocks that hide themselves when nothing inside
// matches (mirrors the vega-lite example gallery's grouped layout).
(function () {
  const input = document.getElementById('search');
  const supportSelect = document.getElementById('support-filter');
  const summary = document.getElementById('stat-summary');
  const items = Array.from(document.querySelectorAll('.imagegroup'));
  const subsections = Array.from(document.querySelectorAll('[data-subsection]'));
  const sections = Array.from(document.querySelectorAll('[data-section]'));

  function normalize(s) { return (s || '').toLowerCase(); }

  function apply() {
    const q = normalize(input.value);
    const support = supportSelect.value;
    let visible = 0;

    for (const item of items) {
      const name = normalize(item.dataset.name);
      const desc = normalize(item.dataset.desc);
      const statuses = item.dataset.status.split(',');
      let ok = true;
      if (q && !name.includes(q) && !desc.includes(q)) ok = false;
      if (ok && support !== 'all') {
        const allOk = statuses.every(s => s === 'ok');
        const anyOk = statuses.some(s => s === 'ok');
        if (support === 'all-ok' && !allOk) ok = false;
        if (support === 'any-fail' && allOk) ok = false;
        if (support === 'none-ok' && anyOk) ok = false;
      }
      item.classList.toggle('hidden', !ok);
      if (ok) visible++;
    }

    for (const sub of subsections) {
      const anyVisible = Array.from(sub.querySelectorAll('.imagegroup')).some(el => !el.classList.contains('hidden'));
      sub.classList.toggle('hidden', !anyVisible);
    }
    for (const section of sections) {
      const anyVisible = Array.from(section.querySelectorAll('.imagegroup')).some(el => !el.classList.contains('hidden'));
      section.classList.toggle('hidden', !anyVisible);
    }

    summary.textContent = `Showing ${visible} of ${items.length} examples`;
  }

  input.addEventListener('input', apply);
  supportSelect.addEventListener('change', apply);
  apply();
})();
