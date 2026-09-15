/* Server-side Bloxgen keys — hide client key UI and generate without client keys */
(function () {
  function hideKeyUI() {
    document.querySelectorAll('#gen-key, .quota, #quota-mini, [data-set="keys"], .set-nav-item[data-set="keys"]').forEach(function (el) {
      if (el) el.style.display = 'none';
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hideKeyUI);
  else hideKeyUI();
  setTimeout(hideKeyUI, 200);
  setTimeout(hideKeyUI, 1000);

  function currentType() {
    try {
      if (typeof genType === 'string' && genType) return genType;
    } catch (e) {}
    var el = document.querySelector('#gen-type .select-value');
    var label = el ? el.textContent.trim() : '';
    var map = {
      'Standard': 'alt',
      'Aged · 30d+': '+30 days old',
      'Aged · 1y+': '+1 year old',
      'Aged · 5y+': '5+ years old',
      'Dump': 'dump'
    };
    return map[label] || 'alt';
  }

  function currentRegion() {
    try {
      if (typeof genRegion === 'string') return genRegion;
    } catch (e) {}
    var el = document.querySelector('#gen-region .select-value');
    var v = el ? el.textContent.trim() : '';
    return (!v || v === 'Auto') ? '' : v;
  }

  async function serverGenerate() {
    if (typeof statusPill === 'function') statusPill('generating…');
    if (typeof genMeta === 'function') genMeta('requesting…', '');
    var r;
    try {
      r = await window.api.bloxgenGenerate({
        apiKey: '',
        type: currentType(),
        region: currentRegion() || undefined
      });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    if (r && r.ok && r.data) {
      if (typeof addGeneratedAccount === 'function') {
        addGeneratedAccount(r.data);
      }
      if (typeof statusPill === 'function') statusPill('idle');
      if (typeof genMeta === 'function') genMeta(r.fromPool ? 'from pool' : 'generated', '');
      return;
    }
    var err = (r && (r.error || r.message)) || 'Generate failed — check BLOXGEN_API_KEYS on server';
    if (typeof toast === 'function') toast(err);
    else alert(err);
    if (typeof statusPill === 'function') statusPill('idle');
    if (typeof genMeta === 'function') genMeta('failed', '');
  }

  function bindGenerate() {
    var btn = document.getElementById('btn-generate');
    if (!btn || btn.dataset.serverBound) return;
    btn.dataset.serverBound = '1';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      btn.style.opacity = '0.6';
      serverGenerate().finally(function () {
        delete btn.dataset.busy;
        btn.style.opacity = '';
      });
    }, true);
  }

  setTimeout(bindGenerate, 500);
  setTimeout(bindGenerate, 1500);
})();
