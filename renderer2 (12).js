'use strict';
/* ogalts renderer — wires the pixel-perfect UI to the real app logic.
   Legacy logic lives in renderer-legacy.js (kept for reference). */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// ---- Settings (shared storage with legacy) ---------------------------------
const SETTINGS_KEY = 'ram-settings';
let settings = {};
try { settings = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { settings = {}; }
if (!Array.isArray(settings.bloxgenKeys)) {
  settings.bloxgenKeys = settings.bloxgenKey ? [{ id: crypto.randomUUID(), label: '', key: settings.bloxgenKey }] : [];
}
delete settings.bloxgenKey;
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
window.__userCollabPlan = null;
function hasCollabPlan() { return !!(window.__userCollabPlan); }
function requireCollab(feature) {
  if (hasCollabPlan()) return true;
  if (typeof toast === 'function') toast((feature || 'This') + ' is collab-only — buy a plan under Collab');
  return false;
}
function keyList() { return (settings.bloxgenKeys || []).filter((k) => k.key && k.key.trim()); }
// Apply saved theme immediately to avoid a flash of the wrong theme.
const THEME_IDS = ['dark', 'light', 'airbnb', 'apple', 'arc', 'roblox'];
if (settings.theme && settings.theme !== 'dark' && THEME_IDS.includes(settings.theme)) {
  document.documentElement.setAttribute('data-theme', settings.theme);
}

// ---- State -----------------------------------------------------------------
let accounts = [];
let selected = new Set();       // ids selected in Accounts table
let modalId = null;             // account id open in modal
const PAGE_SIZE = 20;
// Accounts table has its own page size (user-selectable: 25/50/100).
let accPageSize = [25, 50, 100].includes(settings.accPageSize) ? settings.accPageSize : 25;
let histPage = 1;
let accPage = 1;
const accFilters = { search: '', type: '__all__', region: '__all__', folder: '__all__', verified: false, favorite: false };
const histFilters = { search: '', type: '__all__', region: '__all__', verified: false };
function matchFilters(a, f) {
  if (f.search) {
    const q = f.search.toLowerCase();
    if (!`${a.pseudo} ${a.userId || ''} ${a.notes || ''} ${a.region || ''}`.toLowerCase().includes(q)) return false;
  }
  if (f.type && f.type !== '__all__' && rawTypeOf(a) !== f.type) return false;
  if (f.region && f.region !== '__all__' && (a.region || '') !== f.region) return false;
  if (f.folder && f.folder !== '__all__' && (a.folder || 'Main pool') !== f.folder) return false;
  if (f.verified && !a.emailVerified && !a.ageVerified) return false;
  if (f.favorite && !a.favorite) return false;
  return true;
}
let genType = '+30 days old';
let genKeyId = '__all__';
let genRegion = ''; // '' = Auto (server default); ultra keys can force an ISO region code
let generating = false;

// Region choice is an ultra-only feature — sent as `region` in the /api/generate body.
const REGION_OPTS = [
  { value: '', label: 'Auto' },
  { value: 'GB', label: 'United Kingdom (GB)' },
  { value: 'US', label: 'United States (US) — coming soon', soon: true },
  { value: 'CA', label: 'Canada (CA) — coming soon', soon: true },
  { value: 'DE', label: 'Germany (DE) — coming soon', soon: true },
  { value: 'FR', label: 'France (FR) — coming soon', soon: true },
  { value: 'NL', label: 'Netherlands (NL) — coming soon', soon: true },
  { value: 'ES', label: 'Spain (ES) — coming soon', soon: true },
  { value: 'IT', label: 'Italy (IT) — coming soon', soon: true },
  { value: 'PL', label: 'Poland (PL) — coming soon', soon: true },
  { value: 'SE', label: 'Sweden (SE) — coming soon', soon: true },
  { value: 'AU', label: 'Australia (AU) — coming soon', soon: true },
  { value: 'BR', label: 'Brazil (BR) — coming soon', soon: true },
  { value: 'JP', label: 'Japan (JP) — coming soon', soon: true },
  { value: 'IN', label: 'India (IN) — coming soon', soon: true },
];
function regionLabel(v) { const o = REGION_OPTS.find((x) => x.value === v); return o ? o.label : (v || 'Auto'); }

const BLOXGEN_TYPES = ['alt', '+30 days old', '+1 year old', '5+ years old', '18+ age verified', 'dump'];
const TYPE_LABEL = { 'alt': 'Standard', '+30 days old': 'Aged · 30d+', '+1 year old': 'Aged · 1y+', '5+ years old': 'Aged · 5y+', '18+ age verified': '18+ verified', 'dump': 'Robux accounts' };
const TYPE_SHORT = { 'alt': 'Standard', '+30 days old': '30d+', '+1 year old': '1y+', '5+ years old': '5y+', '18+ age verified': '18+', 'dump': 'Robux' };
// Bloxgen price per 1000 accounts → per-account cost = /1000.
const COST_PER_1K = { 'alt': 0.4, '+30 days old': 0.6, '+1 year old': 0.8, '5+ years old': 1.2, '18+ age verified': 3.0, 'dump': 5.0 };
const GEN_UI_PRICE = { 'alt': 0.001, '+30 days old': 0.005, '+1 year old': 0.01, '5+ years old': 0.02, '18+ age verified': 0.03, 'dump': 0.04 };
function priceStr(t) { const p = GEN_UI_PRICE[t]; return p != null ? ('£' + p.toFixed(3)) : ''; }
function costStr(type) { return priceStr(type) || '—'; }
function rawTypeOf(a) { return (a.tags || []).find((t) => GEN_UI_PRICE[t] != null || BLOXGEN_TYPES.includes(t)) || null; }
const PALETTE = ['#3B4A8C', '#7A3F6D', '#2F6B58', '#8C5A2B', '#4A3F8C', '#2B6B8C', '#7A3F3F', '#3F7A4A'];

// ---- Helpers ---------------------------------------------------------------
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function initial(name) { return (name || '?').trim().slice(0, 1).toUpperCase() || '?'; }
function colorFor(name) { let h = 0; for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
// Real Roblox avatar when we have it, otherwise a coloured initial as fallback.
function avatarStyle(a) { return a.avatarUrl ? `background-image:url('${a.avatarUrl}');background-size:cover;background-position:center` : `background:${colorFor(a.pseudo)}`; }
function avatarInner(a) { return a.avatarUrl ? '' : esc(initial(a.pseudo)); }
function maskPass(p) { if (!p) return '—'; if (p.length <= 6) return p; return p.slice(0, 4) + '•••••' + p.slice(-2); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function timeAgo(iso) {
  if (!iso) return '—';
  const then = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso).getTime();
  if (isNaN(then)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function daysOldStr(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  return days + 'd old';
}
function formatCreated(a) {
  const ts = a.createdAt || a.created || a.addedAt;
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const old = daysOldStr(ts);
  return old ? (date + ' (' + old + ')') : date;
}
function formatTags(a) {
  return (a.tags || []).filter((t) => t && t !== 'bloxgen' && t !== 'imported').map((t) => TYPE_LABEL[t] || TYPE_SHORT[t] || t);
}
function typeOf(a) { const t = (a.tags || []).find((x) => BLOXGEN_TYPES.includes(x) || x === 'dump'); return t ? (TYPE_SHORT[t] || t) : 'Standard'; }
function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); }
function ageText(a) {
  if (a.age != null) return String(a.age) + (a.ageRange && a.ageRange !== 'Unknown' ? ` (${a.ageRange})` : '');
  return (a.ageRange && a.ageRange !== 'Unknown') ? a.ageRange : '—';
}
function isBloxgen(a) { const t = a.tags || []; return t.includes('bloxgen') || t.some((x) => BLOXGEN_TYPES.includes(x)); }

let toastTimer = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { toast('Copy failed'); } }
function comingSoon(name) { toast((name ? name + ' — ' : '') + 'coming soon 🚧'); }
async function askDelete(msg) { if (settings.confirmDelete === false) return true; const r = await window.api.confirm(msg, ['Delete', 'Cancel']); return r === 0; }

// ---- Persistence -----------------------------------------------------------
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => window.api.save(accounts).catch((e) => toast('Save error: ' + e.message)), 250); }

function normalize(a) {
  const STATUSES = ['Active', 'Warned', 'Banned'];
  const AGES = ['Unknown', '9-12', '13-15', '16-17', '18-20', '21+'];
  return {
    id: a.id || crypto.randomUUID(),
    pseudo: a.pseudo || '',
    password: a.password || '',
    ageRange: AGES.includes(a.ageRange) ? a.ageRange : 'Unknown',
    age: (typeof a.age === 'number') ? a.age : null,
    birthdate: a.birthdate || null,
    voiceChat: !!a.voiceChat,
    ageVerified: !!a.ageVerified,
    emailVerified: !!a.emailVerified,
    bannedGames: Array.isArray(a.bannedGames) ? a.bannedGames : [],
    status: STATUSES.includes(a.status) ? a.status : 'Active',
    tags: Array.isArray(a.tags) ? a.tags.filter((t) => t && t !== 'bloxgen') : [],
    dateAdded: a.dateAdded || todayISO(),
    notes: a.notes || '',
    favorite: !!a.favorite,
    userId: a.userId ? String(a.userId) : null,
    displayName: a.displayName || '',
    created: a.created || null,
    avatarUrl: a.avatarUrl || null,
    robloxBanned: !!a.robloxBanned,
    cookie: a.cookie || '',
    cookieValid: (typeof a.cookieValid === 'boolean') ? a.cookieValid : undefined,
    cookieCheckedAt: a.cookieCheckedAt || null,
    region: a.region || '',
    robux: (typeof a.robux === 'number') ? a.robux : null,
    rap: (typeof a.rap === 'number') ? a.rap : null,
    summary: a.summary || null,
    lastUsed: a.lastUsed || null,
    pwChangedAt: a.pwChangedAt || null,
    cookieRefreshedAt: a.cookieRefreshedAt || null,
    folder: a.folder || 'Main pool',
  };
}
function getAcc(id) { return accounts.find((a) => a.id === id) || null; }

// ---- Pager -----------------------------------------------------------------
const CHEV_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
const CHEV_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
function renderPager(container, page, total, onGo) {
  if (!container) return;
  if (total <= 1) { container.innerHTML = ''; return; }
  const pg = (p, label, active, dis) => `<span class="pg${active ? ' active' : ''}${dis ? ' dis' : ''}"${!dis && p ? ` data-pg="${p}"` : ''}>${label}</span>`;
  const wanted = [...new Set([1, 2, total - 1, total, page - 1, page, page + 1])].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  let html = pg(page - 1, CHEV_L, false, page <= 1);
  let prev = 0;
  for (const p of wanted) { if (p - prev > 1) html += '<span class="pg dis">…</span>'; html += pg(p, p, p === page, false); prev = p; }
  html += pg(page + 1, CHEV_R, false, page >= total);
  container.innerHTML = html;
  container.querySelectorAll('[data-pg]').forEach((el) => el.addEventListener('click', () => onGo(Number(el.dataset.pg))));
}

// ============================ SCREEN SWITCHING ==============================
let currentScreen = 'generator';
function showScreen(name, opts = {}) {
  currentScreen = name;
  $$('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
  if (opts.el) { $$('.nav-item').forEach((n) => n.classList.remove('is-active')); opts.el.classList.add('is-active'); }
  else { $$('.nav-item').forEach((n) => n.classList.toggle('is-active', n.dataset.screen === name)); }
  if (name === 'accounts') renderAccounts();
  if (name === 'generator') renderHistory();
  if (name === 'cookies') renderCookies();
  if (name === 'vault') renderVault();
  if (name === 'games') renderGames();
  if (name === 'support') renderSupport();
  if (name === 'settings') renderSettings();
  if (name === 'coming') {
    const f = opts.feature || 'This section';
    $('#coming-feature').textContent = f;
    $('#coming-title').textContent = f;
  }
}
$$('.nav-item[data-screen]').forEach((n) => n.addEventListener('click', () => showScreen(n.dataset.screen, { el: n })));
$$('.nav-item:not([data-screen]):not(.disabled)').forEach((n) => {
  const label = (n.querySelector('.nav-label') || {}).textContent || 'This section';
  n.addEventListener('click', () => showScreen('coming', { feature: label, el: n }));
});
$$('[data-screen-go]').forEach((b) => b.addEventListener('click', () => showScreen(b.dataset.screenGo, { el: $(`.nav-item[data-screen="${b.dataset.screenGo}"]`) })));

// ============================ HISTORY (generator) ===========================
function statusClass(a) { return a.status === 'Banned' ? 'flagged' : a.status === 'Warned' ? 'cooling' : 'active'; }
// Real cookie state, consistent with the Cookies screen: 'valid'/'expired' come from an actual
// liveness check (a.cookieValid), 'unknown' = has a cookie but not checked yet, 'none' = no cookie.
function cookieState(a) {
  if (!a.cookie) return 'none';
  if (a.cookieValid === true) return 'valid';
  if (a.cookieValid === false) return 'expired';
  return 'unknown';
}
function cookieLabel(s) { return s === 'unknown' ? 'unchecked' : s; }

function histRowHTML(a, isNew) {
  return `
    <div class="trow${isNew ? ' is-new' : ''}" data-id="${a.id}">
      <div class="col-avatar"><div class="avi" style="${avatarStyle(a)}">${avatarInner(a)}</div></div>
      <div class="col-user user-cell"><span class="user-name">${esc(a.pseudo)}</span>${isNew ? '<span class="new-tag">NEW</span>' : ''}</div>
      <div class="col-pass cell-mono tv-dim">${esc(maskPass(a.password))}</div>
      <div class="col-created cell-mono tv-mid">${esc(formatCreated(a))}</div>
      <div class="col-type"><span class="type-pill">${esc(typeOf(a))}</span></div>
      <div class="col-cost cell-mono tv-dim">${esc(rawTypeOf(a) ? costStr(rawTypeOf(a)) : '—')}</div>
      <div class="col-robux cell-mono tv-dim">${esc(fmtNum(a.robux))}</div>
      <div class="col-voice">${a.voiceChat ? '<span class="vpill yes">On</span>' : '<span class="vpill no">Off</span>'}</div>
      <div class="col-summary cell-mono tv-dim">—</div>
      <div class="col-region cell-mono tv-mid">${esc(a.region || '—')}</div>
      <div class="col-email">${a.emailVerified ? '<span class="vpill yes">Yes</span>' : '<span class="vpill no">No</span>'}</div>
      <div class="col-age">${a.ageVerified ? '<span class="vpill yes">Yes</span>' : '<span class="vpill no">No</span>'}</div>
      <div class="col-estage cell-mono tv-mid">${esc(a.age != null ? String(a.age) : (a.ageRange !== 'Unknown' ? a.ageRange : '—'))}</div>
      <div class="col-generated cell-mono tv-dim">${esc(timeAgo(a.dateAdded))}</div>
      <div class="hist-actions"><span class="hist-login" data-hlogin="${a.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/></svg><span>Login</span></span></div>
    </div>`;
}
function noFilters(f) { return !f.search && f.type === '__all__' && f.region === '__all__' && !f.verified; }
function renderHistTable(c) {
  if (!c.body) return;
  const allGen = accounts.filter(isBloxgen);
  if (c.count) c.count.textContent = String(allGen.length);
  updateNavBadges();
  const gen = allGen.filter((a) => matchFilters(a, c.filters));
  if (!gen.length) {
    c.body.innerHTML = `<div style="padding:26px 4px;font-family:var(--a-font-mono);font-size:11.5px;color:var(--a-text-3)">${allGen.length ? 'No matches for these filters.' : 'No generated accounts yet — hit Generate Account.'}</div>`;
    if (c.footer) c.footer.hidden = true;
    return;
  }
  const totalPages = Math.max(1, Math.ceil(gen.length / PAGE_SIZE));
  let page = c.getPage();
  if (page > totalPages) { page = totalPages; c.setPage(page); }
  const start = (page - 1) * PAGE_SIZE;
  const pageRows = gen.slice(start, start + PAGE_SIZE);
  const nf = noFilters(c.filters);
  c.body.innerHTML = pageRows.map((a, n) => histRowHTML(a, page === 1 && n === 0 && nf)).join('');
  c.body.querySelectorAll('[data-hlogin]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); loginAccount(b.dataset.hlogin); }));
  c.body.querySelectorAll('.trow').forEach((r) => r.addEventListener('click', () => openModal(r.dataset.id)));
  if (c.footer) {
    c.footer.hidden = false;
    c.info.textContent = `Showing ${start + 1}–${start + pageRows.length} of ${gen.length} generated`;
    renderPager(c.pager, page, totalPages, (p) => { c.setPage(p); c.render(); });
  }
}
function renderHistory() {
  renderHistTable({
    body: $('#tbody'), count: $('#hist-count'), footer: $('#hist-footer'), info: $('#hist-info'), pager: $('#hist-pager'),
    filters: histFilters, getPage: () => histPage, setPage: (p) => { histPage = p; }, render: renderHistory,
  });
}
function updateNavBadges() {
  const ab = $('#nav-acc-badge'); if (ab) ab.textContent = String(accounts.length);
}

// ============================ ACCOUNTS ======================================
function renderStats() {
  const total = accounts.length;
  const verified = accounts.filter((a) => a.emailVerified).length;
  const holding = accounts.filter((a) => Number(a.robux) > 0).length;
  const totalRobux = accounts.reduce((s, a) => s + (Number(a.robux) || 0), 0);
  const flagged = accounts.filter((a) => a.status === 'Banned' || a.robloxBanned).length;
  const today = accounts.filter((a) => a.dateAdded === todayISO()).length;
  $('#stat-total').textContent = total;
  $('#stat-total-d').textContent = '+' + today + ' today';
  $('#stat-verified').textContent = verified;
  $('#stat-verified-d').textContent = (total ? Math.round((verified / total) * 100) : 0) + '% of pool';
  $('#stat-robux').textContent = holding;
  $('#stat-robux-d').textContent = '≈ ' + fmtNum(totalRobux) + ' R$';
  $('#stat-flagged').textContent = flagged;
  $('#acc-crumb').textContent = total + ' stored';
}

// When the visible columns don't fill the width, grow the actions column and turn its icons
// into labeled buttons (else keep the compact sticky icon column).
function applyAccWide() {
  const table = document.querySelector('.acct-table');
  const rows = document.querySelector('.at-rows');
  const head = document.querySelector('.at-head');
  if (!table || !rows || !head) return;
  table.classList.remove('at-wide'); // measure with fixed columns (at-head min-width:100% hides overflow)
  let sum = 0;
  head.querySelectorAll(':scope > div').forEach((c) => { sum += c.offsetWidth; });
  const avail = rows.clientWidth - 36; // .at-rows has 18px side padding
  if (avail > 0 && avail - sum >= 180) table.classList.add('at-wide');
}
window.addEventListener('resize', applyAccWide);
function renderAccounts() {
  renderStats();
  applyAccCols();
  const body = $('#at-body');
  if (!accounts.length) {
    body.innerHTML = '<div style="padding:40px 4px;font-family:var(--a-font-mono);font-size:11.5px;color:var(--a-text-3)">No accounts yet. Generate or import some.</div>';
    $('#acc-footer-info').textContent = 'No accounts';
    updateBulk();
    return;
  }
  const list = accounts.filter((a) => matchFilters(a, accFilters))
    .sort((x, y) => (y.favorite ? 1 : 0) - (x.favorite ? 1 : 0));
  if (!list.length) {
    body.innerHTML = '<div style="padding:40px 4px;font-family:var(--a-font-mono);font-size:11.5px;color:var(--a-text-3)">No accounts match these filters.</div>';
    $('#acc-footer-info').textContent = `0 of ${accounts.length} accounts`;
    $('#acc-pager').innerHTML = '';
    updateBulk();
    return;
  }
  const totalPages = Math.max(1, Math.ceil(list.length / accPageSize));
  if (accPage > totalPages) accPage = totalPages;
  const start = (accPage - 1) * accPageSize;
  const pageAccts = list.slice(start, start + accPageSize);
  body.innerHTML = pageAccts.map((a) => {
    const on = selected.has(a.id);
    const st = statusClass(a);
    const stLabel = a.status === 'Banned' ? 'Flagged' : a.status === 'Warned' ? 'Cooling' : (a.cookie ? 'Active' : 'Idle');
    const stCls = a.status === 'Banned' ? 'flagged' : a.status === 'Warned' ? 'cooling' : (a.cookie ? 'active' : 'idle');
    const ck = cookieState(a);
    return `
    <div class="at-row${on ? ' sel' : ''}" data-id="${a.id}">
      <div class="ac-select"><div class="checkbox${on ? ' on' : ''}" data-check="${a.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div></div>
      <div class="ac-avatar"><div class="avi-lg" style="${avatarStyle(a)}">${avatarInner(a)}</div></div>
      <div class="ac-user"><span class="ac-name">${esc(a.pseudo || '(no name)')}</span><span class="ac-id">${a.userId ? 'ID ' + esc(a.userId) : 'no ID'}</span></div>
      <div class="ac-pass cell-mono tv-dim" style="font-size:11.5px">${esc(maskPass(a.password))}</div>
      <div class="ac-type"><span class="type-pill">${esc(typeOf(a))}</span></div>
      <div class="ac-created cell-mono tv-mid" style="font-size:11.5px">${esc(formatCreated(a))}</div>
      <div class="ac-region cell-mono tv-mid" style="font-size:12.5px">${esc(a.region || '—')}</div>
      <div class="ac-robux cell-mono" style="font-size:12px;color:var(--a-text)">${esc(fmtNum(a.robux))}</div>
      <div class="ac-voice">${a.voiceChat ? '<span class="vpill yes">On</span>' : '<span class="vpill no">Off</span>'}</div>
      <div class="ac-estage cell-mono tv-mid" style="font-size:11.5px">${esc(a.age != null ? String(a.age) : (a.ageRange !== 'Unknown' ? a.ageRange : '—'))}</div>
      <div class="ac-email">${a.emailVerified ? '<span class="vpill yes">Yes</span>' : '<span class="vpill no">No</span>'}</div>
      <div class="ac-age">${a.ageVerified ? '<span class="vpill yes">Yes</span>' : '<span class="vpill no">No</span>'}</div>
      <div class="ac-status"><span class="status-pill ${stCls}"><span class="sdot"></span>${stLabel}</span></div>
      <div class="ac-cookie"><span class="ck ${ck}">${cookieLabel(ck)}</span></div>
      <div class="ac-lastused cell-mono tv-dim" style="font-size:11px">${esc(timeAgo(a.lastUsed || a.dateAdded))}</div>
      <div class="ac-folder cell-mono tv-mid" style="font-size:12px">${esc(a.folder || 'Main pool')}</div>
      <div class="ac-actions"><span class="mini-btn star${a.favorite ? ' on' : ''}" data-fav="${a.id}"><svg viewBox="0 0 24 24" fill="${a.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.123 2.123 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.123 2.123 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg><span class="mb-label">Favorite</span></span><span class="mini-btn" data-pwchange="${a.id}" title="Change password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg><span class="mb-label">Change password</span></span><span class="mini-btn" data-login="${a.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/></svg><span class="mb-label">Login</span></span></div>
    </div>`;
  }).join('');
  $('#acc-footer-info').textContent = `Showing ${start + 1}–${start + pageAccts.length} of ${list.length} accounts` + (selected.size ? `   ·   ${selected.size} selected` : '');
  applyAccWide();
  renderPager($('#acc-pager'), accPage, totalPages, (p) => { accPage = p; renderAccounts(); });
  // row interactions
  $$('#at-body [data-check]').forEach((c) => c.addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(c.dataset.check); }));
  // the whole select cell toggles (bigger hitbox so it's not mistaken for a row click)
  $$('#at-body .ac-select').forEach((cell) => cell.addEventListener('click', (e) => { e.stopPropagation(); const cb = cell.querySelector('[data-check]'); if (cb) toggleSelect(cb.dataset.check); }));
  $$('#at-body [data-fav]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const a = getAcc(b.dataset.fav); if (a) { a.favorite = !a.favorite; save(); renderAccounts(); } }));
  $$('#at-body [data-login]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); loginAccount(b.dataset.login); }));
  $$('#at-body [data-open]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openModal(b.dataset.open); }));
  $$('#at-body [data-pwchange]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const a = getAcc(b.dataset.pwchange); if (!a) return;
    if (!a.cookie) { toast('No cookie for this account'); return; }
    const conf = await window.api.confirm(`Change ${a.pseudo}'s password? The new one replaces the old and the account stays usable (cookie is rotated).`, ['Change', 'Cancel']);
    if (conf !== 0) return;
    if (!requireCollab('Password change')) return;
    toast('Changing password…');
    const ok = await changeAccountPassword(a);
    save(); renderAccounts();
    toast(ok ? `Password changed ✓ (${a.pseudo})` : `Failed: ${a._pwErr || 'error'}`);
  }));
  $$('#at-body .at-row').forEach((r) => r.addEventListener('click', () => openModal(r.dataset.id)));
  updateBulk();
}

function toggleSelect(id) { if (selected.has(id)) selected.delete(id); else selected.add(id); renderAccounts(); }
function updateBulk() {
  const bulk = $('#acc-bulk');
  if (!bulk) return;
  bulk.hidden = selected.size === 0;
  $('#bulk-count').textContent = `${selected.size} account${selected.size === 1 ? '' : 's'} selected`;
}
$('#bulk-clear')?.addEventListener('click', () => { selected.clear(); renderAccounts(); });
$('#select-all')?.addEventListener('click', () => {
  if (selected.size === accounts.length) selected.clear();
  else accounts.forEach((a) => selected.add(a.id));
  renderAccounts();
});
$('#bulk-delete')?.addEventListener('click', async () => {
  if (!selected.size) return;
  if (!(await askDelete(`Delete ${selected.size} selected account(s)?`))) return;
  accounts = accounts.filter((a) => !selected.has(a.id));
  selected.clear(); save(); renderAccounts(); renderHistory();
});

// ============================ LOGIN =========================================
function loginAccount(id) {
  const a = getAcc(id); if (!a) return;
  if (!a.cookie && (!a.pseudo.trim() || !a.password)) { toast('Needs a username and password'); return; }
  a.lastUsed = new Date().toISOString(); save();
  window.api.robloxLogin({ accountId: a.id, username: a.pseudo.trim(), password: a.password, cookie: a.cookie || '' });
  toast(a.cookie ? 'Opening Roblox (cookie)…' : 'Opening Roblox…');
}

// ============================ MODAL =========================================
function setSwitch(el, on) { el.classList.toggle('on', on); el.classList.toggle('off', !on); }
function openModal(id) {
  const a = getAcc(id); if (!a) return;
  modalId = id;
  setModalTab('details');
  // reset inventory tab state for the newly opened account
  invMode = 'all'; invCat = 'all'; invAll = null;
  $$('.inv-seg').forEach((x) => x.classList.toggle('active', x.dataset.invmode === 'all'));
  const _ic = $('#inv-cats'); if (_ic) { _ic.hidden = true; _ic.innerHTML = ''; }
  const _il = $('#inv-list'); if (_il) _il.innerHTML = '<span class="act-note">Open to load…</span>';
  const _ir = $('#inv-rap'); if (_ir) _ir.textContent = '—';
  const _icn = $('#inv-count'); if (_icn) _icn.textContent = '—';
  const mav = $('#m-avatar');
  if (a.avatarUrl) { mav.textContent = ''; mav.style.background = `url('${a.avatarUrl}') center/cover`; }
  else { mav.textContent = initial(a.pseudo); mav.style.background = colorFor(a.pseudo); }
  $('#m-name').textContent = a.pseudo || '(no name)';
  $('#m-badge-active').hidden = a.status !== 'Active';
  $('#m-badge-verified').hidden = !a.ageVerified;
  $('#m-sub').innerHTML = `ID: ${esc(a.userId || '—')}&nbsp;&nbsp;·&nbsp;&nbsp;${esc(typeOf(a))}&nbsp;&nbsp;·&nbsp;&nbsp;added ${esc(a.dateAdded)}${a.region ? '&nbsp;&nbsp;·&nbsp;&nbsp;' + esc(a.region) : ''}`;
  $('#m-user').textContent = a.pseudo || '';
  $('#m-pass').textContent = a.password || '';
  $('#m-pass').classList.remove('revealed');
  $('#m-id').textContent = a.userId || '';
  $('#m-status-val').textContent = a.status;
  $('#m-agerange-val').textContent = a.ageRange;
  $('#m-note').textContent = a.notes || '';
  $('#m-display').textContent = a.displayName || '';
  $('#m-tags').textContent = formatTags(a).join(', ') || typeOf(a);
  $('#m-robux').textContent = fmtNum(a.robux);
  $('#m-voice-txt').textContent = a.voiceChat ? 'On' : 'Off';
  $('#m-estage').textContent = ageText(a);
  $('#m-added').textContent = a.dateAdded;
  $('#m-fav').textContent = a.favorite ? 'Yes' : 'No';
  $('#m-banned').textContent = (a.bannedGames || []).length;
  setSwitch($('#m-sw-email'), a.emailVerified);
  setSwitch($('#m-sw-voice'), a.voiceChat);
  setSwitch($('#m-sw-ageverif'), a.ageVerified);
  $('#m-cookie').textContent = a.cookie ? (a.cookie.slice(0, 32) + '…' + a.cookie.slice(-6)) : 'no cookie stored';
  $('#m-cookie').dataset.real = a.cookie || '';
  $('#m-cookie-status').textContent = a.cookie ? 'stored' : 'none';
  $('#m-cookie-status').style.color = a.cookie ? 'var(--a-ok)' : 'var(--a-text-3)';
  $('#m-lastlogin').textContent = 'last login ' + timeAgo(a.lastUsed);
  renderTimeline(a);
  $('#modal-scrim').hidden = false;
}
// Account lifecycle timeline (in the Activity tab): shows the events that exist, newest first.
const TL_ICONS = {
  created: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
  pw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  cookie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
  login: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/></svg>',
};
function renderTimeline(a) {
  const box = $('#act-timeline'); if (!box) return;
  const evts = [
    { t: a.dateAdded, k: 'created', label: 'Account added' },
    { t: a.pwChangedAt, k: 'pw', label: 'Password changed' },
    { t: a.cookieRefreshedAt, k: 'cookie', label: 'Cookie refreshed (keep-alive)' },
    { t: a.lastUsed, k: 'login', label: 'Last login' },
  ].filter((e) => e.t);
  if (!evts.length) { box.innerHTML = '<span class="act-note">No activity yet.</span>'; return; }
  // dateAdded is a date-only string; give it a time so sorting is stable.
  const ms = (s) => new Date(s.length <= 10 ? s + 'T00:00:00' : s).getTime();
  evts.sort((x, y) => ms(y.t) - ms(x.t));
  box.innerHTML = evts.map((e) =>
    `<div class="tl-row"><span class="tl-dot">${TL_ICONS[e.k]}</span><span class="tl-label">${e.label}</span><span class="tl-time">${timeAgo(e.t)}</span></div>`
  ).join('');
}
function closeModal() { $('#modal-scrim').hidden = true; modalId = null; }
$('#m-close')?.addEventListener('click', closeModal);
$('#m-cancel')?.addEventListener('click', closeModal);
$('#modal-scrim')?.addEventListener('click', (e) => { if (e.target === $('#modal-scrim')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal-scrim').hidden) closeModal(); });
$('#m-pass-eye')?.addEventListener('click', () => $('#m-pass').classList.toggle('revealed'));
// Editable toggles + favorite
['#m-sw-email', '#m-sw-voice', '#m-sw-ageverif'].forEach((sel) => {
  $(sel)?.addEventListener('click', () => setSwitch($(sel), !$(sel).classList.contains('on')));
});
$('#m-fav')?.addEventListener('click', () => { $('#m-fav').textContent = $('#m-fav').textContent === 'Yes' ? 'No' : 'Yes'; });
// Single-line editable fields: Enter confirms instead of inserting a newline
['m-user', 'm-pass', 'm-id', 'm-display', 'm-tags'].forEach((id) => {
  $('#' + id)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
});
$('#m-open')?.addEventListener('click', () => { if (modalId) loginAccount(modalId); });
$('#m-cookie-refresh')?.addEventListener('click', async () => {
  const a = getAcc(modalId); if (!a) { return; }
  if (!a.cookie) { toast('No stored cookie — log in first'); return; }
  toast('Reading session…');
  // Fetch profile info and Robux/RAP independently — a failing endpoint on one
  // must not block the other.
  const [info, rr] = await Promise.all([
    window.api.refreshInfo({ accountId: a.id, cookie: a.cookie }),
    window.api.robuxRap({ userId: a.userId, cookie: a.cookie }),
  ]);
  let any = false;
  if (info && info.loggedIn) { applyDetectedInfo(a, info); any = true; }
  if (rr && rr.ok) {
    if (typeof rr.robux === 'number') { a.robux = rr.robux; any = true; }
    if (typeof rr.rap === 'number') { a.rap = rr.rap; any = true; }
  }
  if (any) { save(); renderHistory(); renderAccounts(); }
  openModal(a.id);
  toast(any ? 'Updated from session' : (info && !info.loggedIn ? 'Cookie expired — log in again' : 'Nothing updated'));
});
$('#m-delete')?.addEventListener('click', async () => {
  const a = getAcc(modalId); if (!a) return;
  if (!(await askDelete(`Delete "${a.pseudo}"?`))) return;
  accounts = accounts.filter((x) => x.id !== a.id); selected.delete(a.id);
  closeModal(); save(); renderAccounts(); renderHistory();
});
$('#m-save')?.addEventListener('click', () => {
  const a = getAcc(modalId); if (!a) return;
  const txt = (id) => ($('#' + id).textContent || '').trim();
  a.pseudo = txt('m-user');
  a.password = txt('m-pass');
  a.userId = txt('m-id') || null;
  a.status = $('#m-status-val').textContent;
  a.ageRange = $('#m-agerange-val').textContent;
  a.notes = txt('m-note');
  a.displayName = txt('m-display');
  a.tags = txt('m-tags').split(',').map((t) => t.trim()).filter(Boolean);
  a.emailVerified = $('#m-sw-email').classList.contains('on');
  a.voiceChat = $('#m-sw-voice').classList.contains('on');
  a.ageVerified = $('#m-sw-ageverif').classList.contains('on');
  a.favorite = $('#m-fav').textContent.trim() === 'Yes';
  save(); toast('Saved'); renderAccounts(); renderHistory(); closeModal();
});

// ---- Modal tabs + Activity --------------------------------------------------
function setModalTab(tab) {
  $$('.modal-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  $$('.modal .tab-panel').forEach((p) => { p.hidden = p.dataset.tab !== tab; });
}
$$('.modal-tab').forEach((t) => t.addEventListener('click', () => {
  const tab = t.dataset.tab;
  if (tab === 'credentials' || tab === 'cookie') { comingSoon(t.textContent.trim()); return; }
  setModalTab(tab);
  if (tab === 'activity') loadActivity();
  if (tab === 'played') loadRecent();
  if (tab === 'inventory') loadInventory();
}));
async function loadActivity() {
  const a = getAcc(modalId); if (!a) return;
  const pdot = $('#act-pdot'), pstatus = $('#act-pstatus'), ploc = $('#act-ploc'), ptime = $('#act-ptime');
  pdot.className = 'presence-dot'; pstatus.textContent = 'Loading…'; ploc.textContent = ''; ptime.textContent = '';
  if (!a.userId) { pstatus.textContent = 'Unknown'; ploc.textContent = 'No user ID yet (enrich first)'; }
  else {
    const p = await window.api.presence({ userId: a.userId, cookie: a.cookie || '' });
    if (p && p.ok) {
      const MAP = { 0: ['Offline', ''], 1: ['Online', 'online'], 2: ['In game', 'ingame'], 3: ['In Studio', 'studio'] };
      const [label, cls] = MAP[p.type] || ['Unknown', ''];
      pdot.className = 'presence-dot ' + cls;
      pstatus.textContent = label;
      ploc.textContent = p.lastLocation || (p.type === 0 ? '—' : '');
      ptime.textContent = p.lastOnline ? ('last online ' + timeAgo(p.lastOnline)) : '';
    } else { pstatus.textContent = 'Unavailable'; ploc.textContent = (p && p.error) || 'presence error'; }
  }
}
// Recently played — its own modal tab.
async function loadRecent() {
  const a = getAcc(modalId); if (!a) return;
  const list = $('#act-recent'); if (!list) return;
  list.innerHTML = '<span class="act-note">Loading recently played…</span>';
  if (!a.cookie) { list.innerHTML = '<span class="act-note">No stored cookie — can\'t read recently played.</span>'; return; }
  const rp = await window.api.recentlyPlayed({ cookie: a.cookie });
  if (!rp || !rp.ok) { list.innerHTML = `<span class="act-note">Couldn't load (${esc((rp && rp.error) || 'error')}).</span>`; return; }
  if (!rp.games.length) { list.innerHTML = '<span class="act-note">Nothing recently played (or the sort changed).</span>'; return; }
  list.innerHTML = rp.games.map((g) => `
    <div class="recent-item" data-place="${g.rootPlaceId || ''}">
      <div class="recent-icon" style="${g.iconUrl ? `background-image:url('${g.iconUrl}')` : ''}"></div>
      <div class="recent-info"><span class="recent-name">${esc(g.name)}</span><span class="recent-players">${g.playerCount != null ? Number(g.playerCount).toLocaleString('en-US') + ' playing' : ''}</span></div>
    </div>`).join('');
  list.querySelectorAll('[data-place]').forEach((el) => el.addEventListener('click', () => { const pid = el.dataset.place; if (pid) window.api.openUrl('https://www.roblox.com/games/' + pid); }));
}
$('#act-refresh')?.addEventListener('click', loadRecent);
let invMode = 'all';  // 'all' | 'limited'
let invCat = 'all';
let invAll = null;        // cached full-inventory result for the open account
function invGridHTML(items) {
  return '<div class="inv-grid">' + items.map((it) => {
    const kind = it.kind || 'asset';
    const id = it.id || it.assetId || '';
    const thumbAttr = kind === 'bundle' ? `data-bthumb="${id}"` : kind === 'gamepass' ? `data-gthumb="${id}"` : `data-athumb="${id}"`;
    return `
    <div class="inv-card" data-kind="${kind}" data-id="${id}" title="${esc(it.name)}${it.owner ? ' · ' + esc(it.owner) : ''}${it.type ? ' · ' + esc(it.type) : ''}">
      <div class="inv-thumb" ${thumbAttr}></div>
      ${it.owner ? `<div class="inv-owner">${esc(it.owner)}</div>` : ''}
      <div class="inv-cname">${esc(it.name)}</div>
      ${(() => { const v = it.value != null ? it.value : (it.rap != null ? it.rap : null); return v != null && v > 0 ? `<div class="inv-crap">${fmtNum(v)} R$</div>` : (it.serial ? `<div class="inv-cserial">#${esc(String(it.serial))}</div>` : ''); })()}
    </div>`;
  }).join('') + '</div>';
}
function wireInvRows(listEl) {
  listEl.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', () => {
    const id = el.dataset.id; if (!id) return;
    const base = el.dataset.kind === 'bundle' ? 'https://www.roblox.com/bundles/' : el.dataset.kind === 'gamepass' ? 'https://www.roblox.com/game-pass/' : 'https://www.roblox.com/catalog/';
    window.api.openUrl(base + id);
  }));
  fillThumbs(listEl);
}
// Patch value labels onto already-rendered cards (so we don't re-fetch thumbnails).
function patchInvValues(container) {
  if (!invAll) return;
  container.querySelectorAll('.inv-card').forEach((card) => {
    const it = invAll.items.find((x) => String(x.id) === String(card.dataset.id) && (x.kind || 'asset') === card.dataset.kind);
    if (!it) return;
    const nameEl = card.querySelector('.inv-cname'); if (nameEl && it.name) nameEl.textContent = it.name;
    const v = it.value != null ? it.value : (it.rap != null ? it.rap : null);
    let el = card.querySelector('.inv-crap');
    if (v != null && v > 0) {
      const ser = card.querySelector('.inv-cserial'); if (ser) ser.remove();
      if (!el) { el = document.createElement('div'); el.className = 'inv-crap'; card.appendChild(el); }
      el.textContent = fmtNum(v) + ' R$';
    } else if (el) { el.remove(); }
  });
}
// Lazily fill thumbnails (batched by 100), keyed to the account so a fast re-open doesn't
// paint a previous account's images. Assets and bundles use different thumbnail endpoints.
async function fillThumbs(container) {
  const paint = (nodes, map) => { if (!map) return; for (const n of nodes) { const u = map[n.dataset.athumb || n.dataset.bthumb || n.dataset.gthumb]; if (u) { n.style.backgroundImage = `url('${u}')`; n.classList.add('loaded'); } } };
  const batches = [
    { nodes: [...container.querySelectorAll('[data-athumb]')], key: 'athumb', fn: window.api.assetThumbs },
    { nodes: [...container.querySelectorAll('[data-bthumb]')], key: 'bthumb', fn: window.api.bundleThumbs },
    { nodes: [...container.querySelectorAll('[data-gthumb]')], key: 'gthumb', fn: window.api.gamepassThumbs },
  ];
  for (const b of batches) {
    const ids = [...new Set(b.nodes.map((n) => n.dataset[b.key]).filter(Boolean))];
    for (let i = 0; i < ids.length; i += 100) {
      const map = await b.fn(ids.slice(i, i + 100));
      if (!container.isConnected) return; // grid was replaced (screen/account changed)
      paint(b.nodes, map);
    }
  }
}
function renderInvAll() {
  const listEl = $('#inv-list'), catsEl = $('#inv-cats');
  if (!invAll || !invAll.ok) return;
  // category chips
  const cats = Object.entries(invAll.counts).sort((a, b) => b[1] - a[1]);
  if (catsEl) {
    catsEl.hidden = false;
    catsEl.innerHTML = `<div class="inv-cat${invCat === 'all' ? ' active' : ''}" data-cat="all">All · ${fmtNum(invAll.count)}</div>` +
      cats.map(([t, n]) => `<div class="inv-cat${invCat === t ? ' active' : ''}" data-cat="${esc(t)}">${esc(t)} · ${fmtNum(n)}</div>`).join('');
    catsEl.querySelectorAll('[data-cat]').forEach((c) => c.addEventListener('click', () => { invCat = c.dataset.cat; renderInvAll(); }));
  }
  let items = invAll.items;
  if (invCat !== 'all') items = items.filter((i) => i.type === invCat);
  const valOf = (i) => (i.value != null ? i.value : (i.rap != null ? i.rap : 0));
  items = items.slice().sort((x, y) => valOf(y) - valOf(x) || String(x.name).localeCompare(String(y.name)));
  if (listEl) {
    listEl.innerHTML = items.length ? invGridHTML(items) : '<span class="act-note">No items in this category.</span>';
    wireInvRows(listEl);
  }
}
async function loadInventory() {
  const a = getAcc(modalId); if (!a) return;
  const listEl = $('#inv-list'), rapEl = $('#inv-rap'), cntEl = $('#inv-count'), cntK = $('#inv-count-k'), catsEl = $('#inv-cats');
  if (rapEl) rapEl.textContent = '…'; if (cntEl) cntEl.textContent = '…';
  if (listEl) listEl.innerHTML = '<span class="act-note">Loading inventory…</span>';
  if (catsEl) { catsEl.hidden = invMode !== 'all'; catsEl.innerHTML = ''; }
  if (!a.userId) {
    if (rapEl) rapEl.textContent = '—'; if (cntEl) cntEl.textContent = '—';
    if (listEl) listEl.innerHTML = '<span class="act-note">No user ID yet — refresh the account first.</span>';
    return;
  }
  const rapK = $('#inv-rap-k');
  if (invMode === 'limited') {
    if (rapK) rapK.textContent = 'TOTAL RAP'; if (cntK) cntK.textContent = 'LIMITEDS';
    const r = await window.api.inventory({ userId: a.userId, cookie: a.cookie || '' });
    if (!r || !r.ok) {
      if (rapEl) rapEl.textContent = '—'; if (cntEl) cntEl.textContent = '—';
      if (listEl) listEl.innerHTML = `<span class="act-note">Couldn't load inventory${a.cookie ? '' : ' (private inventories need a stored cookie)'}.</span>`;
      return;
    }
    if (rapEl) rapEl.textContent = fmtNum(r.totalRap) + ' R$';
    if (cntEl) cntEl.textContent = fmtNum(r.count) + (r.truncated ? '+' : '');
    if (!r.items.length) { if (listEl) listEl.innerHTML = '<span class="act-note">No limited items.</span>'; return; }
    const sorted = r.items.slice().sort((x, y) => (y.rap || 0) - (x.rap || 0));
    if (listEl) { listEl.innerHTML = invGridHTML(sorted); wireInvRows(listEl); }
  } else {
    if (rapK) rapK.textContent = 'VALUE'; if (cntK) cntK.textContent = 'ITEMS';
    const r = await window.api.inventoryFull({ userId: a.userId, cookie: a.cookie || '' });
    if (!r || !r.ok) {
      if (rapEl) rapEl.textContent = '—'; if (cntEl) cntEl.textContent = '—';
      if (listEl) listEl.innerHTML = `<span class="act-note">Couldn't load inventory${a.cookie ? '' : ' (private inventories need a stored cookie)'}.</span>`;
      return;
    }
    invAll = r;
    if (cntEl) cntEl.textContent = fmtNum(r.count) + (r.truncated ? '+' : '');
    if (rapEl) rapEl.textContent = '…';
    if (!r.items.length) { if (rapEl) rapEl.textContent = '—'; if (catsEl) catsEl.hidden = true; if (listEl) listEl.innerHTML = '<span class="act-note">No items found.</span>'; return; }
    renderInvAll(); // show grid + thumbnails immediately
    // Then price the whole inventory and patch the value labels + total.
    const openId = modalId;
    const vres = await window.api.inventoryValue({ items: r.items, cookie: a.cookie || '' });
    if (modalId !== openId || invMode !== 'all') return;
    if (vres && vres.ok) {
      const names = vres.names || {};
      for (const it of r.items) {
        if (it.kind === 'gamepass') continue; // keeps its own price from the game-pass fetch
        const key = (it.kind === 'bundle' ? 'Bundle' : 'Asset') + ':' + it.id;
        it.value = vres.values[key] != null ? vres.values[key] : null;
        if (names[key]) it.name = names[key]; // English name over the localized one
      }
      r.totalValue = r.items.reduce((s, it) => s + (it.value || 0), 0);
      if (rapEl) rapEl.textContent = fmtNum(r.totalValue) + ' R$';
      if (listEl) patchInvValues(listEl);
    } else if (rapEl) { rapEl.textContent = '—'; }
  }
}
$('#inv-refresh')?.addEventListener('click', () => { invAll = null; loadInventory(); });
$$('.inv-seg').forEach((s) => s.addEventListener('click', () => {
  const m = s.dataset.invmode; if (m === invMode) return;
  invMode = m; invCat = 'all';
  $$('.inv-seg').forEach((x) => x.classList.toggle('active', x === s));
  loadInventory();
}));

// ============================ DETECT / ENRICH ===============================
function applyDetectedInfo(a, info) {
  let ch = false;
  // We only reach here after users/authenticated succeeded → the cookie is alive. Mark it valid
  // so freshly generated / detected accounts aren't left as "unchecked" in Cookies.
  if (a.cookieValid !== true) { a.cookieValid = true; a.cookieCheckedAt = new Date().toISOString(); ch = true; }
  if (info.cookie && info.cookie !== a.cookie) { a.cookie = info.cookie; ch = true; }
  if (info.userId && a.userId !== info.userId) { a.userId = String(info.userId); ch = true; }
  if (info.displayName && !a.displayName) { a.displayName = info.displayName; ch = true; }
  if (typeof info.voiceChat === 'boolean') { a.voiceChat = info.voiceChat; ch = true; }
  if (info.ageRange) { a.ageRange = info.ageRange; ch = true; }
  if (typeof info.age === 'number') { a.age = info.age; ch = true; }
  if (info.birthdate) { a.birthdate = info.birthdate; ch = true; }
  if (typeof info.ageVerified === 'boolean') { a.ageVerified = info.ageVerified; ch = true; }
  if (typeof info.emailVerified === 'boolean') { a.emailVerified = info.emailVerified; ch = true; }
  if (ch) { save(); renderAccounts(); renderHistory(); }
  return ch;
}
window.api.onDetected((data) => {
  const a = getAcc(data.accountId); if (!a) return;
  if (applyDetectedInfo(a, data)) toast('Detected voice / age from session');
});

// ============================ BLOXGEN GENERATE ==============================
function isDailyLimit(r) {
  if (r.dailyLimit === -1) return false;
  if (typeof r.remainingGenerations === 'number') return r.remainingGenerations <= 0;
  return /daily limit|daily cap|no generations? left|out of generations/i.test(r.error || '');
}
// Key's plan can't make this account type — skip the key, don't retry.
function isAccessError(r) { return /does not have access|upgrade your role|not have access to|no access to/i.test(r.error || ''); }
function genMeta(left, right) { if (left != null) $('#gen-meta-left').textContent = left; if (right != null) $('#gen-meta-right').textContent = right; }
function statusPill(t) { $('#gen-status-pill').textContent = t; }

// Fill the "Generated Account" detail card from a stored account.
// `fresh` shows the NEW badge (just generated) vs. a restored last account.
function showDetailFromAccount(a, fresh) {
  const av = $('#gd-avatar');
  av.textContent = '';
  av.style.background = a.avatarUrl ? `url('${a.avatarUrl}') center/cover` : colorFor(a.pseudo);
  $('#gd-name').textContent = a.pseudo || '—';
  $('#gd-fresh').hidden = !fresh;
  $('#gd-sub').textContent = `${typeOf(a)}${a.region ? ' · ' + a.region : ''} · ${fresh ? 'just now' : formatCreated(a)}`;
  $('#gd-id').textContent = a.userId || '—';
  $('#gd-region').textContent = a.region || '—';
  $('#gd-created').textContent = formatCreated(a);
  $('#gd-email').textContent = a.emailVerified ? 'Yes' : 'No'; $('#gd-email').className = 'chip-v ' + (a.emailVerified ? 'ok' : 'no');
  $('#gd-ageverif').textContent = a.ageVerified ? 'Yes' : 'No'; $('#gd-ageverif').className = 'chip-v ' + (a.ageVerified ? 'ok' : 'no');
  $('#gd-age').textContent = ageText(a);
  $('#gd-user').textContent = a.pseudo || '—';
  $('#gd-pass').textContent = a.password || '—';
  $('#gd-robux').textContent = fmtNum(a.robux);
  $('#gd-cookie').textContent = a.cookie ? (a.cookie.slice(0, 20) + '…') : '—';
  $('#gd-cookie').dataset.real = a.cookie || '';
  $('#gd-summary').textContent = a.summary || '—';
  $('#gd-detail').dataset.id = a.id;
}

// Build a new password from the Settings prefix + length (letters+digits, Roblox-valid).
function genNewPassword() {
  const prefix = (settings.pwPrefix || '').toString();
  const len = Math.max(8, Math.min(50, Number(settings.pwLength) || 16));
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const need = Math.max(4, len - prefix.length);
  const buf = new Uint32Array(need); crypto.getRandomValues(buf);
  let rnd = ''; for (let i = 0; i < need; i++) rnd += chars[buf[i] % chars.length];
  let pw = prefix + rnd;
  if (!/[0-9]/.test(pw)) pw += '7';
  if (!/[a-zA-Z]/.test(pw)) pw += 'Rb';
  return pw;
}
// Change an account's password (keeps it usable via the rotated cookie the API returns).
async function changeAccountPassword(a) {
  if (!requireCollab('Password change')) return false;
  if (!a || !a.cookie || !a.password) return false;
  const newPw = genNewPassword();
  const r = await window.api.changePassword({ cookie: a.cookie, currentPassword: a.password, newPassword: newPw });
  if (r && r.ok) {
    a.password = newPw;
    a.pwChangedAt = new Date().toISOString();
    if (r.cookie) { a.cookie = r.cookie; a.cookieValid = true; a.cookieCheckedAt = new Date().toISOString(); window.api.setCookie({ accountId: a.id, cookie: r.cookie }); }
    return true;
  }
  a._pwErr = (r && r.error) || 'failed';
  return false;
}
function addGeneratedAccount(d, opts = {}) {
  const acc = normalize({
    pseudo: d.username, password: d.password,
    userId: d.id != null ? String(d.id) : null,
    avatarUrl: d.avatarUrl || null,
    tags: [d.type].filter(Boolean),
    notes: d.region ? 'Region: ' + d.region : '',
    cookie: d.cookie || '', region: d.region || '',
  });
  acc.robux = d.robux != null ? d.robux : undefined;
  acc.rap = d.rap != null ? d.rap : undefined;
  acc.summary = d.summary || undefined;
  accounts.unshift(acc);
  if (d.cookie) window.api.setCookie({ accountId: acc.id, cookie: d.cookie });
  save();
  histPage = 1;
  renderHistory();
  renderQuota();
  // Auto-change password (+ capture the rotated cookie) right after generation, if enabled.
  if (settings.autoChangePw && hasCollabPlan() && acc.cookie && acc.password) {
    changeAccountPassword(acc).then((ok) => { if (ok) { save(); renderHistory(); renderAccounts(); if ($('#gd-detail') && $('#gd-detail').dataset.id === acc.id) showDetailFromAccount(acc, false); } });
  }
  if (opts.silent) return acc; // Case mode handles reveal + enrichment itself
  showDetailFromAccount(acc, true); // always show the latest generated account
  if (settings.autoFetch === false) return acc; // user disabled auto profile fetch
  const refreshShown = () => { if ($('#gd-detail').dataset.id === acc.id) showDetailFromAccount(acc, $('#gd-fresh').hidden === false); };
  // Real profile: avatar, userId, and the Roblox account creation date.
  if (acc.pseudo && (!acc.avatarUrl || !acc.created || !acc.userId)) {
    window.api.enrich(acc.pseudo).then((r) => {
      if (r && r.ok) {
        if (r.avatarUrl) acc.avatarUrl = r.avatarUrl;
        if (r.userId && !acc.userId) acc.userId = r.userId;
        if (r.created && !acc.created) acc.created = r.created;
        save(); renderHistory(); renderAccounts(); refreshShown();
      }
    }).catch(() => {});
  }
  // Auto-detect (no browser login): age, age-verified, email-verified, voice.
  if (acc.cookie) {
    window.api.refreshInfo({ accountId: acc.id, cookie: acc.cookie }).then((info) => {
      if (info && info.loggedIn) { applyDetectedInfo(acc, info); refreshShown(); }
    }).catch(() => {});
    // Real Robux balance + RAP.
    window.api.robuxRap({ userId: acc.userId, cookie: acc.cookie }).then((r) => {
      if (r && r.ok) {
        if (typeof r.robux === 'number') acc.robux = r.robux;
        if (typeof r.rap === 'number') acc.rap = r.rap;
        save(); renderHistory(); renderAccounts(); refreshShown();
      }
    }).catch(() => {});
  }
  if (settings.vaultAutoAdd && acc.cookie) setTimeout(() => addToVault(getAcc(acc.id) || acc), 2500);
  return acc;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================ CASE MODE (CS:GO reveal) ======================
const RARITY = {
  common: { color: '#8b93a1', label: 'Common' },
  blue: { color: '#4b69ff', label: 'Voice' },
  purple: { color: '#8847ff', label: 'ID Verified' },
  gold: { color: '#f5b820', label: 'Robux' },
};
function rarityOf(acc) {
  if (acc.robux && acc.robux > 0) return 'gold';
  if (acc.ageVerified) return 'purple';
  if (acc.voiceChat) return 'blue';
  return 'common';
}
// Short CS:GO-style tick when a card crosses the marker (WebAudio, no assets).
let caseAudio = null;
function caseTick() {
  try {
    caseAudio = caseAudio || new (window.AudioContext || window.webkitAudioContext)();
    if (caseAudio.state === 'suspended') caseAudio.resume();
    const t = caseAudio.currentTime;
    const o = caseAudio.createOscillator(), g = caseAudio.createGain();
    o.type = 'square';
    o.frequency.value = 820 + Math.random() * 260;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(g).connect(caseAudio.destination);
    o.start(t); o.stop(t + 0.035);
  } catch { /* audio unavailable */ }
}
function randFillerRarity() { const r = Math.random(); if (r < 0.75) return 'common'; if (r < 0.9) return 'blue'; if (r < 0.98) return 'purple'; return 'gold'; }
const FAKE_A = ['Shadow', 'Frost', 'Neon', 'Turbo', 'Pixel', 'Cyber', 'Ghost', 'Rapid', 'Lunar', 'Solar', 'Vortex', 'Crimson', 'Silent', 'Golden', 'Mystic', 'Rogue', 'Blaze', 'Storm', 'Iron', 'Void', 'Toxic', 'Epic', 'Dark', 'Swift'];
const FAKE_B = ['Wolf', 'Ninja', 'Gamer', 'Knight', 'Fox', 'Hawk', 'Viper', 'Raven', 'Tiger', 'Dragon', 'Sniper', 'Phantom', 'Rider', 'Blade', 'King', 'Ace', 'Bolt', 'Slayer', 'Legend', 'Pro', 'Beast', 'Ghost', 'Reaper', 'Duck'];
function fakeName() {
  const a = FAKE_A[Math.floor(Math.random() * FAKE_A.length)];
  const b = FAKE_B[Math.floor(Math.random() * FAKE_B.length)];
  const n = Math.floor(Math.random() * 9000 + 100);
  const p = Math.random();
  if (p < 0.3) return a + b + n;
  if (p < 0.52) return a + '_' + b;
  if (p < 0.72) return b + n;
  if (p < 0.88) return 'xX' + a + b + 'Xx';
  return a.toLowerCase() + b.toLowerCase() + n;
}
async function caseReveal(acc) {
  // Fetch the attributes we colour by BEFORE the reveal (voice / ID verified / robux).
  const tasks = [];
  if (acc.cookie) {
    tasks.push(window.api.refreshInfo({ accountId: acc.id, cookie: acc.cookie }).then((info) => { if (info && info.loggedIn) applyDetectedInfo(acc, info); }).catch(() => {}));
    tasks.push(window.api.robuxRap({ userId: acc.userId, cookie: acc.cookie }).then((r) => { if (r && r.ok && typeof r.robux === 'number') acc.robux = r.robux; }).catch(() => {}));
  }
  if (acc.pseudo && (!acc.avatarUrl || !acc.userId || !acc.created)) {
    tasks.push(window.api.enrich(acc.pseudo).then((r) => { if (r && r.ok) { if (r.avatarUrl) acc.avatarUrl = r.avatarUrl; if (r.userId && !acc.userId) acc.userId = r.userId; if (r.created && !acc.created) acc.created = r.created; } }).catch(() => {}));
  }
  await Promise.all(tasks);
  save(); renderHistory(); renderAccounts(); renderQuota();
  showDetailFromAccount(acc, true); // update the Generator's "latest account" card too
  if (settings.vaultAutoAdd && acc.cookie) addToVault(acc);
  await playCase(acc, rarityOf(acc));
}
function playCase(acc, rarity) {
  return new Promise((resolve) => {
    const WIN = 46, TOTAL = 58, CARD_W = 108, PITCH = CARD_W + 10;
    // Fillers pull REAL Roblox avatars from your own accounts (shuffled); fall back to fake names.
    const pool = accounts.filter((a) => a.avatarUrl && a.id !== acc.id);
    for (let k = pool.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); const tmp = pool[k]; pool[k] = pool[j]; pool[j] = tmp; }
    let pi = 0;
    const cards = [];
    for (let i = 0; i < TOTAL; i++) {
      if (i === WIN) { cards.push({ rr: rarity, name: acc.pseudo || 'account', avatarUrl: acc.avatarUrl || null }); continue; }
      if (pool.length) { const f = pool[pi++ % pool.length]; cards.push({ rr: randFillerRarity(), name: f.pseudo, avatarUrl: f.avatarUrl }); }
      else cards.push({ rr: randFillerRarity(), name: fakeName(), avatarUrl: null });
    }
    const cardHTML = (c) => `
      <div class="case-card r-${c.rr}" style="--rc:${RARITY[c.rr].color}">
        <div class="case-av" style="${c.avatarUrl ? `background-image:url('${c.avatarUrl}')` : `background:${colorFor(c.name)}`}">${c.avatarUrl ? '' : esc(initial(c.name))}</div>
      </div>`;
    const scrim = document.createElement('div');
    scrim.className = 'case-scrim';
    scrim.innerHTML = `
      <div class="case-box">
        <div class="case-title" id="case-title">Opening account</div>
        <div class="case-viewport">
          <div class="case-marker"></div>
          <div class="case-reel" id="case-reel">${cards.map(cardHTML).join('')}</div>
        </div>
        <div class="case-result" id="case-result" hidden></div>
      </div>`;
    document.body.appendChild(scrim);
    const reel = scrim.querySelector('#case-reel');
    const viewport = scrim.querySelector('.case-viewport');
    requestAnimationFrame(() => {
      const vpW = viewport.clientWidth;
      const jitter = (Math.random() * 2 - 1) * (CARD_W * 0.34);
      const target = (WIN * PITCH + CARD_W / 2) - vpW / 2 + jitter;
      reel.style.transition = 'none';
      reel.style.transform = 'translateX(0)';
      reel.offsetHeight; // reflow
      reel.style.transition = 'transform 6.2s cubic-bezier(0.06, 0.78, 0.04, 1)';
      reel.style.transform = `translateX(${-target}px)`;
      // Tick each time a card boundary crosses the marker (reads the live transform).
      let lastIdx = -1;
      const tick = () => {
        if (done) return;
        let tx = 0;
        try { tx = new DOMMatrixReadOnly(getComputedStyle(reel).transform).m41; } catch { /* ignore */ }
        const idx = Math.round(((vpW / 2 - tx) - CARD_W / 2) / PITCH);
        if (idx !== lastIdx) { if (lastIdx !== -1) caseTick(); lastIdx = idx; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      const winCard = reel.children[WIN]; if (winCard) winCard.classList.add('won');
      const rr = RARITY[rarity];
      const attrs = [];
      if (acc.voiceChat) attrs.push('Voice');
      if (acc.ageVerified) attrs.push('ID verified');
      if (acc.robux) attrs.push(fmtNum(acc.robux) + ' R$');
      scrim.querySelector('.case-title').textContent = 'You unboxed';
      const res = scrim.querySelector('#case-result');
      res.hidden = false;
      res.innerHTML = `
        <div class="case-won-name" style="color:${rr.color}">${esc(acc.pseudo)}</div>
        <div class="case-won-sub">${rr.label}${attrs.length ? ' · ' + attrs.map(esc).join(' · ') : ''}</div>
        <div class="case-btns">
          <div class="case-btn" id="case-view">View account</div>
          <div class="case-btn primary" id="case-close">Collect</div>
        </div>`;
      const close = () => { scrim.remove(); resolve(); };
      scrim.querySelector('#case-close').addEventListener('click', close);
      scrim.querySelector('#case-view').addEventListener('click', () => { close(); openModal(acc.id); });
      scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
    };
    reel.addEventListener('transitionend', (e) => { if (e.propertyName === 'transform') finish(); }, { once: true });
    setTimeout(finish, 7200); // safety net
  });
}

async function generateOnce() {
  window.__authToken = window.__authToken || localStorage.getItem('ogalts_token') || '';
  if (window.api && window.api.setToken) window.api.setToken(window.__authToken);
  if (!window.__authToken) { toast('Sign in with Google first'); return; }
  const candidates = [{}]; // server keys — no client API key needed
  statusPill('generating…'); genMeta('requesting…', '');
  let lastErr = null;
  for (const key of candidates) {
    let r;
    try { r = await window.api.bloxgenGenerate({ type: genType, region: genRegion || undefined }); }
    catch (e) { r = { ok: false, status: 0, error: String((e && e.message) || e) }; }
    if (r.ok) {
      if (settings.caseMode) {
        const acc = addGeneratedAccount(r.data, { silent: true });
        statusPill('idle'); genMeta('case opened', '');
        await caseReveal(acc);
        return;
      }
      addGeneratedAccount(r.data);
      statusPill('idle'); genMeta('generated ' + r.data.username, '');
      toast('Generated ' + r.data.username);
      return;
    }
    if (r.status === 429) {
      // A 429 is either an ordinary cooldown OR the daily quota being spent (Bloxgen reports
      // exhaustion as a long cooldown). Ask the daily-limit endpoint which one it is.
      let exhausted = false;
      try {
        const dl = await window.api.bloxgenDailyLimit({ apiKey: key.key, type: genType });
        if (dl && dl.ok && dl.data && dl.data.dailyLimit !== -1 && typeof dl.data.remainingGenerations === 'number') exhausted = dl.data.remainingGenerations <= 0;
      } catch {}
      if (exhausted) { lastErr = { ok: false, remainingGenerations: 0, error: 'daily limit reached' }; continue; } // try next key, or report below
      const wait = (r.timeRemaining || 60000);
      const until = Date.now() + wait; statusPill('cooldown');
      const iv = setInterval(() => { const remain = until - Date.now(); genMeta('cooldown ' + fmtCooldown(remain), ''); if (remain <= 0) clearInterval(iv); }, 1000);
      genMeta('cooldown ' + fmtCooldown(wait), ''); toast('Cooldown ' + fmtCooldown(wait));
      return;
    }
    lastErr = r;
    // These are per-key problems — try the next key (in All-keys mode)
    if (isAccessError(r) || isDailyLimit(r) || r.status === 401 || r.status === 403) continue;
    break; // other error → stop trying
  }
  if (lastErr && isDailyLimit(lastErr)) { statusPill('daily limit'); genMeta(candidates.length > 1 ? 'all keys at daily limit' : 'daily limit reached', ''); toast('Daily limit reached'); return; }
  if (lastErr && isAccessError(lastErr)) { statusPill('no access'); genMeta('no key has access to this type', ''); toast(lastErr.error); return; }
  statusPill('error'); genMeta((lastErr && lastErr.error) || 'error', ''); toast('Generate failed: ' + ((lastErr && lastErr.error) || 'error'));
}

$('#btn-generate')?.addEventListener('click', async () => {
  if (generating) return;
  generating = true; $('#btn-generate').style.opacity = '0.7';
  try { await generateOnce(); } finally { generating = false; $('#btn-generate').style.opacity = ''; }
});

// ---- Dropdown menu ---------------------------------------------------------
let ddMenu = null, ddAnchor = null;
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
function closeDropdown() {
  if (ddMenu) { ddMenu.remove(); ddMenu = null; }
  if (ddAnchor) { ddAnchor.classList.remove('open'); ddAnchor = null; }
  document.removeEventListener('mousedown', ddOutside, true);
}
function ddOutside(e) { if (ddMenu && !ddMenu.contains(e.target) && ddAnchor && !ddAnchor.contains(e.target)) closeDropdown(); }
function openDropdown(anchor, items, current, onPick) {
  if (ddAnchor === anchor) { closeDropdown(); return; }
  closeDropdown();
  const menu = document.createElement('div');
  menu.className = 'dd-menu';
  menu.innerHTML = items.map((it) =>
    `<div class="dd-item${it.value === current ? ' sel' : ''}${it.soon ? ' dd-soon' : ''}" data-val="${esc(String(it.value)).replace(/"/g, '&quot;')}" data-soon="${it.soon ? '1' : ''}" style="${it.soon ? 'opacity:.45' : ''}"><span>${esc(it.label)}</span>${it.value === current && !it.soon ? '<span class="dd-check">' + CHECK_SVG + '</span>' : ''}</div>`
  ).join('');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.minWidth = r.width + 'px';
  const mh = menu.offsetHeight;
  if (window.innerHeight - r.bottom < mh + 12 && r.top > mh + 12) menu.style.top = (r.top - mh - 5) + 'px';
  else menu.style.top = (r.bottom + 5) + 'px';
  anchor.classList.add('open');
  menu.querySelectorAll('.dd-item').forEach((el) => el.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (el.dataset.soon === '1') {
      if (typeof toast === 'function') toast('Coming soon');
      closeDropdown();
      return;
    }
    onPick(el.dataset.val); closeDropdown();
  }));
  ddMenu = menu; ddAnchor = anchor;
  setTimeout(() => document.addEventListener('mousedown', ddOutside, true), 0);
}

// ---- Accounts column visibility -------------------------------------------
const ACC_COLS = [
  { key: 'pass', label: 'Password' }, { key: 'type', label: 'Type' },
  { key: 'created', label: 'Created' }, { key: 'region', label: 'Region' },
  { key: 'robux', label: 'Robux' }, { key: 'voice', label: 'Voice' },
  { key: 'estage', label: 'Est. age' }, { key: 'email', label: 'Email ver.' },
  { key: 'age', label: 'ID ver.' }, { key: 'status', label: 'Status' },
  { key: 'cookie', label: 'Cookie' }, { key: 'lastused', label: 'Last used' },
  { key: 'folder', label: 'Folder' },
];
function accColOn(key) { const c = settings.accCols || {}; return c[key] !== false; } // default: visible
function applyAccCols() {
  const t = document.querySelector('.acct-table'); if (!t) return;
  for (const c of ACC_COLS) t.classList.toggle('hide-' + c.key, !accColOn(c.key));
}
// Multi-select popup (stays open while you toggle columns).
function openColsMenu(anchor) {
  if (ddAnchor === anchor) { closeDropdown(); return; }
  closeDropdown();
  const menu = document.createElement('div');
  menu.className = 'dd-menu';
  menu.style.maxHeight = '360px';
  menu.innerHTML = ACC_COLS.map((c) =>
    `<div class="dd-item col-toggle${accColOn(c.key) ? ' sel' : ''}" data-col="${c.key}"><span>${esc(c.label)}</span><span class="dd-check">${CHECK_SVG}</span></div>`
  ).join('');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, r.right - 200) + 'px';
  menu.style.top = (r.bottom + 5) + 'px';
  menu.style.minWidth = '200px';
  anchor.classList.add('open');
  menu.querySelectorAll('.dd-item').forEach((el) => el.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    const k = el.dataset.col;
    if (!settings.accCols) settings.accCols = {};
    settings.accCols[k] = !accColOn(k);
    el.classList.toggle('sel', accColOn(k));
    applyAccCols(); applyAccWide(); saveSettings();
  }));
  ddMenu = menu; ddAnchor = anchor;
  setTimeout(() => document.addEventListener('mousedown', ddOutside, true), 0);
}
$('#acc-cols')?.addEventListener('click', () => openColsMenu($('#acc-cols')));

// Accounts page-size selector (25 / 50 / 100)
function setAccPageSizeLabel() { const l = $('#acc-pagesize-lbl'); if (l) l.textContent = accPageSize + ' / page'; }
setAccPageSizeLabel();
$('#acc-pagesize')?.addEventListener('click', () => {
  openDropdown($('#acc-pagesize'), [25, 50, 100].map((n) => ({ value: String(n), label: n + ' / page' })), String(accPageSize), (v) => {
    accPageSize = Number(v) || 25; settings.accPageSize = accPageSize; saveSettings();
    accPage = 1; setAccPageSizeLabel(); renderAccounts();
  });
});

// Type selector — real dropdown of Bloxgen types
$('#gen-type')?.addEventListener('click', () => {
  openDropdown($('#gen-type'), BLOXGEN_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })), genType, (v) => {
    genType = v; $('#gen-type .select-value').textContent = TYPE_LABEL[v] || v;
    const _b = document.getElementById('gen-cost-badge');
    if (_b) _b.textContent = priceStr(v) || '';
    $('#gen-meta-right').textContent = '';
    renderQuota();
  });
});
// Region selector — ultra-only; short label (code) in the pill, full name in the menu
$('#gen-region')?.addEventListener('click', () => {
  openDropdown($('#gen-region'), REGION_OPTS, genRegion, (v) => {
    const opt = REGION_OPTS.find((x) => x.value === v);
    if (opt && opt.soon) { if (typeof toast === 'function') toast('Coming soon'); return; }
    genRegion = v; $('#gen-region .select-value').textContent = (opt && opt.label) ? opt.label.split(' —')[0] : (v || 'Auto');
  });
});
// Key selector — real dropdown: All keys (rotate) + each stored key
$('#gen-key')?.addEventListener('click', () => {
  const keys = keyList();
  const items = [{ value: '__all__', label: 'All keys (rotate)' }, ...keys.map((k) => ({ value: k.id, label: k.label || (k.key.slice(0, 12) + '…') }))];
  openDropdown($('#gen-key'), items, genKeyId, (v) => {
    genKeyId = v;
    const k = keys.find((x) => x.id === v);
    $('#gen-key .select-value').textContent = v === '__all__' ? 'All keys (rotate)' : (k ? (k.label || k.key.slice(0, 12) + '…') : 'All keys (rotate)');
    renderQuota();
  });
});

// Modal STATUS + AGE RANGE dropdowns
const STATUS_OPTS = ['Active', 'Warned', 'Banned'];
const AGE_OPTS = ['Unknown', '9-12', '13-15', '16-17', '18-20', '21+'];
$('#m-status-val')?.closest('.select')?.addEventListener('click', function () {
  openDropdown(this, STATUS_OPTS.map((s) => ({ value: s, label: s })), $('#m-status-val').textContent, (v) => { $('#m-status-val').textContent = v; });
});
$('#m-agerange-val')?.closest('.select')?.addEventListener('click', function () {
  openDropdown(this, AGE_OPTS.map((s) => ({ value: s, label: s })), $('#m-agerange-val').textContent, (v) => { $('#m-agerange-val').textContent = v; });
});

// Generator detail actions
$('#gd-login')?.addEventListener('click', () => { const id = $('#gd-detail').dataset.id; if (id) loginAccount(id); else comingSoon('Login'); });
$('#gd-del')?.addEventListener('click', () => {
  const id = $('#gd-detail').dataset.id; if (!id) return;
  accounts = accounts.filter((a) => a.id !== id); save(); renderHistory();
  $('#gd-name').textContent = '—'; $('#gd-sub').textContent = 'Generate an account to see it here'; $('#gd-fresh').hidden = true;
});

// Copy buttons (data-copy points to an element id)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  e.stopPropagation();
  const el = document.getElementById(btn.dataset.copy);
  if (el) { const real = el.dataset.real || el.textContent; copyText(real); }
});

// ============================ GENERATION LOOPS =============================
let loops = [];
const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M6 4v16l14-8z"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
function loopKeyLabel(l) { if (l.keyId === '__all__') return 'All keys'; const k = keyList().find((x) => x.id === l.keyId); return k ? (k.label || k.key.slice(0, 8) + '…') : 'key'; }
function loopLabel(l) { return (TYPE_LABEL[l.type] || l.type) + (l.region ? ' · ' + l.region : '') + ' · ' + loopKeyLabel(l); }
function loopDotClass(l) { if (!l.running) return l.dead ? 'dead' : 'pause'; return /cooldown/i.test(l.status) ? 'cool' : 'run'; }
function renderLoops() {
  const strip = $('#loops-strip'); const list = $('#loops-list'); if (!list) return;
  if (!loops.length) { if (strip) strip.hidden = true; list.innerHTML = ''; return; }
  if (strip) strip.hidden = false;
  list.innerHTML = loops.map((l) => `
    <div class="loop-card" data-loop="${l.id}">
      <div class="loop-dot ${loopDotClass(l)}"></div>
      <div class="loop-info"><div class="loop-type">${esc(loopLabel(l))}</div><div class="loop-stat">${esc(l.status)}</div></div>
      <div class="loop-btns">
        <span class="loop-btn" data-loop-toggle="${l.id}">${l.running ? ICON_PAUSE : ICON_PLAY}</span>
        <span class="loop-btn stop" data-loop-stop="${l.id}">${ICON_X}</span>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-loop-toggle]').forEach((b) => b.addEventListener('click', () => toggleLoop(b.dataset.loopToggle)));
  list.querySelectorAll('[data-loop-stop]').forEach((b) => b.addEventListener('click', () => stopLoop(b.dataset.loopStop)));
}
function setLoopStatus(l, s) { l.status = s; renderLoops(); }
function loopWait(l, ms) { return new Promise((res) => { const start = Date.now(); const iv = setInterval(() => { if (!l.running || Date.now() - start >= ms) { clearInterval(iv); res(); } }, 200); }); }
// Human cooldown: 1230000ms -> "20m 30s", 45000ms -> "45s", 3600000ms -> "1h 00m".
function fmtCooldown(ms) {
  let s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
// Drift-free countdown: `until` is an absolute timestamp; remaining is recomputed from the
// real clock each tick (setInterval drifts badly over 20+ minutes / when the window is busy).
function loopCountdown(l, until) {
  return new Promise((res) => {
    setLoopStatus(l, `cooldown ${fmtCooldown(until - Date.now())} · ${l.count} made`);
    const iv = setInterval(() => {
      const remain = until - Date.now();
      if (!l.running || remain <= 0) { clearInterval(iv); res(); return; }
      setLoopStatus(l, `cooldown ${fmtCooldown(remain)} · ${l.count} made`);
    }, 1000);
  });
}
async function runLoop(l) {
  l.blocked = l.blocked || new Set();   // keys with no access / dead for this type (skip permanently)
  l.readyAt = l.readyAt || {};          // keyId -> timestamp the key is usable again (per-key cooldown)
  const tname = () => TYPE_LABEL[l.type] || l.type;
  while (l.running) {
    const keys = keyList();
    if (!keys.length) { l.running = false; l.dead = true; setLoopStatus(l, 'no API key'); break; }
    const scope = l.keyId === '__all__' ? keys : keys.filter((k) => k.id === l.keyId);
    const usable = scope.filter((k) => !l.blocked.has(k.id));
    if (!usable.length) {
      l.running = false; l.dead = true;
      if (l.keyId === '__all__') { setLoopStatus(l, `all keys done (daily limit / no access) · ${l.count} made`); toast(`Loop finished — all keys exhausted (${l.count} generated)`); }
      else { setLoopStatus(l, `key has no access to ${tname()}`); toast(`Loop stopped — key has no access to ${tname()}`); }
      break;
    }

    const now = Date.now();
    const ready = usable.filter((k) => (l.readyAt[k.id] || 0) <= now);
    if (!ready.length) {
      // Every usable key is cooling down — wait for the one that frees up SOONEST.
      const soonest = Math.min(...usable.map((k) => l.readyAt[k.id] || 0));
      const wait = Math.max(0, soonest - now);
      if (wait < 500) { await loopWait(l, wait); } else { await loopCountdown(l, soonest); }
      continue;
    }
    const key = ready[l._k++ % ready.length];

    setLoopStatus(l, `generating… · ${l.count} made`);
    let r;
    try { r = await window.api.bloxgenGenerate({ apiKey: key.key, type: l.type, region: l.region || undefined }); }
    catch (e) { r = { ok: false, status: 0, error: String((e && e.message) || e) }; }
    if (!l.running) break;
    if (r.ok) {
      addGeneratedAccount(r.data); l.count++; l.fails = 0;
      // A successful key often has a per-grade cooldown before its next generation.
      if (r.data && r.data.cooldown) l.readyAt[key.id] = Date.now() + r.data.cooldown;
      setLoopStatus(l, `running · ${l.count} generated`);
      await loopWait(l, 900);
    }
    else if (isAccessError(r)) {
      if (l.keyId === '__all__') { l.blocked.add(key.id); setLoopStatus(l, `skipping a key (no access) · ${l.count} made`); }
      else { l.running = false; l.dead = true; setLoopStatus(l, `stopped: ${r.error}`); break; }
    }
    else if (isDailyLimit(r)) {
      if (l.keyId === '__all__') { l.blocked.add(key.id); setLoopStatus(l, `a key hit its daily limit · ${l.count} made`); }
      else { l.running = false; l.dead = true; setLoopStatus(l, `daily limit reached · ${l.count} made`); toast(`Loop stopped — daily limit reached (${l.count} generated)`); break; }
    }
    else if (r.status === 429) {
      l.fails = 0;
      // A 429 is either an ordinary per-request cooldown OR the daily quota being spent
      // (Bloxgen reports quota exhaustion as a long cooldown, not a distinct error). Ask the
      // daily-limit endpoint which one it is, so the loop stops clearly instead of forever cooling.
      let exhausted = false;
      try {
        const dl = await window.api.bloxgenDailyLimit({ apiKey: key.key, type: l.type });
        if (dl && dl.ok && dl.data && dl.data.dailyLimit !== -1 && typeof dl.data.remainingGenerations === 'number') {
          exhausted = dl.data.remainingGenerations <= 0;
        }
      } catch {}
      if (exhausted) {
        if (l.keyId === '__all__') { l.blocked.add(key.id); setLoopStatus(l, `a key hit its daily limit · ${l.count} made`); }
        else { l.running = false; l.dead = true; setLoopStatus(l, `daily limit reached · ${l.count} made`); toast(`Loop stopped — daily limit reached (${l.count} generated)`); break; }
      } else {
        // Genuine per-key cooldown: mark THIS key, keep using the others (don't block the whole loop).
        l.readyAt[key.id] = Date.now() + (r.timeRemaining || 60000) + 300;
      }
    }
    else if (/balance|insufficient|no funds/i.test(r.error || '') || r.status === 401 || r.status === 403) {
      if (l.keyId === '__all__') { l.blocked.add(key.id); setLoopStatus(l, `skipping a key (key error) · ${l.count} made`); }
      else { l.running = false; l.dead = true; setLoopStatus(l, `stopped: ${r.error || 'key error'}`); break; }
    }
    else { l.fails = (l.fails || 0) + 1; if (l.fails >= 6) { l.running = false; l.dead = true; setLoopStatus(l, 'stopped: repeated errors'); break; } setLoopStatus(l, `retry… · ${l.count} made`); await loopWait(l, 5000); }
  }
  renderLoops();
}
function createLoop() {
  if (!(window.__authToken || localStorage.getItem('ogalts_token'))) { toast('Sign in with Google first'); return; }
  const l = { id: crypto.randomUUID(), type: genType, keyId: genKeyId, region: genRegion, running: true, count: 0, status: 'starting…', _k: 0, fails: 0, dead: false };
  loops.push(l); renderLoops(); toast('Loop started: ' + loopLabel(l)); runLoop(l);
}
function toggleLoop(id) {
  const l = loops.find((x) => x.id === id); if (!l) return;
  if (l.running) { l.running = false; setLoopStatus(l, `paused · ${l.count} made`); }
  else { l.running = true; l.dead = false; renderLoops(); runLoop(l); }
}
function stopLoop(id) { const l = loops.find((x) => x.id === id); if (l) l.running = false; loops = loops.filter((x) => x.id !== id); renderLoops(); }
$('#btn-create-loop')?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (typeof toast === 'function') toast('Coming soon'); });

// ============================ COMING SOON WIRING ============================
// Topbar placeholders (bell, info, search) on every screen
$$('.topbar .icon-btn, .topbar .top-search').forEach((el) => el.addEventListener('click', () => comingSoon('Search & alerts')));
// Generator: reset + history toolbar
// reset options removed
$('#gd-open')?.addEventListener('click', () => {
  const id = $('#gd-detail').dataset.id;
  if (id) openModal(id); else comingSoon('Open');
});
$('#hist-refresh')?.addEventListener('click', () => { histPage = 1; renderHistory(); toast('Refreshed'); });
$('#hist-download')?.addEventListener('click', () => comingSoon('Export history'));
$('#hist-delete')?.addEventListener('click', () => comingSoon('Clear history'));
// Accounts toolbar (view toggle / export are still placeholders)
const _vts = $$('.view-toggle .vt');
_vts.forEach((v, i) => v.addEventListener('click', () => { _vts.forEach((x) => x.classList.remove('active')); v.classList.add('active'); if (i === 1) comingSoon('Grid view'); }));
$('#acc-export')?.addEventListener('click', () => comingSoon('Export'));
// Bulk actions
function bulkLoginAll() {
  const ids = [...selected]; if (!ids.length) return;
  toast(`Opening ${ids.length}…`);
  ids.forEach((id, i) => setTimeout(() => loginAccount(id), i * 400));
}
async function bulkRefreshCookies() {
  const ids = [...selected].filter((id) => { const a = getAcc(id); return a && a.cookie; });
  if (!ids.length) { toast('No stored cookies in selection'); return; }
  toast(`Refreshing ${ids.length}…`);
  for (const id of ids) { const a = getAcc(id); if (!a) continue; const info = await window.api.refreshInfo({ accountId: a.id, cookie: a.cookie }); if (info) applyDetectedInfo(a, info); }
  toast('Cookies refreshed'); renderAccounts();
}
$$('#acc-bulk .bulk-btn').forEach((b) => {
  if (b.id === 'bulk-delete' || b.id === 'bulk-friend') return;
  const label = ((b.querySelector('span') || {}).textContent || '').trim();
  if (/login all/i.test(label)) b.addEventListener('click', bulkLoginAll);
  else if (/refresh cookies/i.test(label)) b.addEventListener('click', bulkRefreshCookies);
  else b.addEventListener('click', () => comingSoon(label));
});

// ---- Bulk social actions: selected accounts each friend / follow a target ----
let socialAction = 'friend'; // 'friend' | 'follow'
const SOCIAL = {
  friend: { title: 'Add as friend', desc: 'send a friend request to', btn: 'Send friend requests', verb: 'Friend requests' },
  follow: { title: 'Follow user', desc: 'follow', btn: 'Follow from selection', verb: 'Follows' },
};
function openSocialPopup(action) {
  if (!selected.size) { toast('Select accounts first'); return; }
  socialAction = action;
  const cfg = SOCIAL[action];
  const s = $('#friend-scrim'); if (!s) return;
  $('#friend-title').textContent = cfg.title;
  $('#friend-desc').innerHTML = `Every <b>${selected.size} selected</b> account will ${cfg.desc} this user.`;
  $('#friend-send-lbl').textContent = cfg.btn;
  $('#friend-status').textContent = '';
  const prog = $('#friend-progress'); if (prog) prog.hidden = true;
  const inp = $('#friend-target'); if (inp) inp.value = '';
  s.hidden = false;
  setTimeout(() => inp && inp.focus(), 40);
}
function closeFriendPopup() { const s = $('#friend-scrim'); if (s) s.hidden = true; }
$('#bulk-friend')?.addEventListener('click', () => openSocialPopup('friend'));
$('#friend-close')?.addEventListener('click', closeFriendPopup);
$('#friend-scrim')?.addEventListener('mousedown', (e) => { if (e.target.id === 'friend-scrim') closeFriendPopup(); });
$('#friend-target')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#friend-send').click(); });
$('#friend-send')?.addEventListener('click', async () => {
  const status = $('#friend-status');
  const raw = ($('#friend-target').value || '').trim();
  if (!raw) { status.textContent = 'Enter a username or ID.'; return; }
  status.textContent = 'Resolving user…';
  let targetId = /^\d+$/.test(raw) ? raw : null;
  if (!targetId) { try { const e = await window.api.enrich(raw); if (e && e.ok && e.userId) targetId = String(e.userId); } catch { /* ignore */ } }
  if (!targetId) { status.textContent = 'User not found.'; return; }
  const targets = [...selected].map(getAcc).filter((a) => a && a.cookie && a.userId && a.cookieValid !== false && String(a.userId) !== String(targetId));
  if (!targets.length) { status.textContent = 'No selected accounts with a live cookie.'; return; }
  const api = socialAction === 'follow' ? window.api.followUser : window.api.friendRequest;
  const prog = $('#friend-progress'), bar = $('#friend-bar');
  if (prog) prog.hidden = false; if (bar) bar.style.width = '0%';
  let ok = 0, cap = 0, rate = 0, fail = 0, n = 0;
  await runPool(targets, 4, async (a) => {
    let r; try { r = await api({ cookie: a.cookie, targetUserId: targetId }); } catch { r = { ok: false }; }
    if (r && r.ok) ok++;
    else if (r && r.captcha) cap++;
    else if (r && r.rateLimited) rate++;
    else fail++;
    n++; if (bar) bar.style.width = Math.round((n / targets.length) * 100) + '%';
    status.textContent = `${socialAction === 'follow' ? 'Following' : 'Sending'} ${n}/${targets.length}…`;
  });
  const parts = [`${ok} ok`];
  if (cap) parts.push(`${cap} captcha`);
  if (rate) parts.push(`${rate} rate-limited`);
  if (fail) parts.push(`${fail} failed`);
  status.textContent = 'Done — ' + parts.join(' · ');
  toast(`${SOCIAL[socialAction].verb}: ${ok}/${targets.length} ok`);
});
// ============================ FILTERS WIRING ================================
function typeOptions() { return [{ value: '__all__', label: 'All types' }, ...BLOXGEN_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))]; }
function regionOptions() { const rs = [...new Set(accounts.map((a) => a.region).filter(Boolean))].sort(); return [{ value: '__all__', label: 'All regions' }, ...rs.map((r) => ({ value: r, label: r }))]; }
function folderOptions() { const fs = [...new Set(accounts.map((a) => a.folder || 'Main pool').filter(Boolean))].sort(); return [{ value: '__all__', label: 'Any folder' }, ...fs.map((f) => ({ value: f, label: f }))]; }
function wireDropdownChip(id, getOptions, filters, key, def, onChange) {
  const el = $('#' + id); if (!el) return;
  el.addEventListener('click', () => {
    const opts = getOptions();
    openDropdown(el, opts, filters[key], (v) => {
      filters[key] = v;
      const o = opts.find((x) => x.value === v);
      el.querySelector('span').textContent = v === '__all__' ? def : (o ? o.label : v);
      el.classList.toggle('active', v !== '__all__');
      onChange();
    });
  });
}
function wireToggleChip(id, filters, key, onChange) {
  const el = $('#' + id); if (!el) return;
  el.addEventListener('click', () => { filters[key] = !filters[key]; el.classList.toggle('active', filters[key]); onChange(); });
}
const accChanged = () => { accPage = 1; renderAccounts(); };
const histChanged = () => { histPage = 1; renderHistory(); };
$('#acc-search')?.addEventListener('input', (e) => { accFilters.search = e.target.value.trim(); accChanged(); });
wireDropdownChip('acc-f-type', typeOptions, accFilters, 'type', 'All types', accChanged);
wireDropdownChip('acc-f-region', regionOptions, accFilters, 'region', 'All regions', accChanged);
wireDropdownChip('acc-f-folder', folderOptions, accFilters, 'folder', 'Any folder', accChanged);
wireToggleChip('acc-f-verified', accFilters, 'verified', accChanged);
wireToggleChip('acc-f-fav', accFilters, 'favorite', accChanged);
$('#hist-search')?.addEventListener('input', (e) => { histFilters.search = e.target.value.trim(); histChanged(); });
wireDropdownChip('hist-f-type', typeOptions, histFilters, 'type', 'All types', histChanged);
wireDropdownChip('hist-f-region', regionOptions, histFilters, 'region', 'All regions', histChanged);
wireToggleChip('hist-f-verified', histFilters, 'verified', histChanged);

// ============================ QUOTA / USER ==================================
const QUOTA_TYPES = [['alt', 'Standard'], ['+30 days old', '30d+'], ['+1 year old', '1y+'], ['5+ years old', '5y+']];
async function renderQuota() {
  const rows = $('#quota-rows'); if (!rows) return;
  const keys = keyList();
  if (!keys.length) { rows.innerHTML = '<div class="quota-empty">Add an API key in Settings</div>'; return; }
  rows.innerHTML = QUOTA_TYPES.map(([, label]) =>
    `<div class="quota-row"><div class="quota-row-top"><span class="quota-type">${label}</span><span class="quota-num">…</span></div><div class="quota-track"><div class="quota-fill" style="width:0"></div></div></div>`
  ).join('');
  const rowEls = [...rows.children];
  QUOTA_TYPES.forEach(async ([t], i) => {
    const el = rowEls[i]; if (!el) return;
    const numEl = el.querySelector('.quota-num'); const fillEl = el.querySelector('.quota-fill');
    let cap = 0, used = 0, unlimited = false, any = false;
    // Sum the daily limit across ALL keys (2 premium keys = 2× the quota).
    await Promise.all(keys.map(async (k) => {
      try {
        const r = await window.api.bloxgenDailyLimit({ apiKey: k.key, type: t });
        const d = r && r.ok && r.data; if (!d) return;
        any = true;
        if (d.dailyLimit === -1 || d.dailyLimit == null) { unlimited = true; return; }
        cap += d.dailyLimit;
        used += d.remainingGenerations != null ? Math.max(0, d.dailyLimit - d.remainingGenerations) : 0;
      } catch {}
    }));
    if (!any) { numEl.textContent = '—'; return; }
    if (unlimited) { numEl.textContent = `${used} / ∞`; return; }
    numEl.textContent = `${used} / ${cap}`;
    const track = 188;
    fillEl.style.width = (cap > 0 ? Math.min(track, Math.round((used / cap) * track)) : 0) + 'px';
  });
}

// Batch-fetch avatars/ids for accounts missing them (Roblox enrich, like before).
async function autoEnrich() {
  if (settings.autoFetch === false) return;
  const names = accounts.filter((a) => a.pseudo && (!a.userId || !a.avatarUrl)).map((a) => a.pseudo);
  if (!names.length) return;
  let map;
  try { map = await window.api.enrichBatch(names); } catch { return; }
  let changed = false;
  for (const a of accounts) {
    const r = map[(a.pseudo || '').toLowerCase()];
    if (!r || !r.ok) continue;
    if (r.userId && a.userId !== r.userId) { a.userId = r.userId; changed = true; }
    if (r.avatarUrl && a.avatarUrl !== r.avatarUrl) { a.avatarUrl = r.avatarUrl; changed = true; }
    if (r.displayName && !a.displayName) { a.displayName = r.displayName; changed = true; }
    if (r.created && !a.created) { a.created = r.created; changed = true; }
    if (r.robloxBanned) { a.robloxBanned = true; changed = true; }
  }
  if (changed) { save(); renderHistory(); renderAccounts(); }
}

// Force re-fetch userId + profile photo + display name for EVERY account (button in Accounts).
let reEnrichBusy = false;
async function reEnrichAll() {
  if (reEnrichBusy) return;
  const names = accounts.filter((a) => a.pseudo).map((a) => a.pseudo);
  if (!names.length) { toast('No accounts to enrich'); return; }
  reEnrichBusy = true;
  const btn = $('#acc-reenrich'); if (btn) btn.classList.add('disabled');
  toast(`Re-enriching ${names.length} account${names.length === 1 ? '' : 's'}…`);
  let map = {};
  try { map = await window.api.enrichBatch(names); } catch { map = {}; }
  let filled = 0;
  for (const a of accounts) {
    const r = map[(a.pseudo || '').toLowerCase()];
    if (!r || !r.ok) continue;
    let hit = false;
    if (r.userId) { if (a.userId !== r.userId) hit = true; a.userId = r.userId; }
    if (r.avatarUrl) { if (a.avatarUrl !== r.avatarUrl) hit = true; a.avatarUrl = r.avatarUrl; }
    if (r.displayName) a.displayName = r.displayName;
    if (r.created) a.created = r.created;
    if (r.robloxBanned) a.robloxBanned = true;
    if (hit) filled++;
  }
  save(); renderHistory(); renderAccounts();
  reEnrichBusy = false;
  if (btn) btn.classList.remove('disabled');
  toast(`Re-enriched — ${filled} account${filled === 1 ? '' : 's'} updated`);
}
$('#acc-reenrich')?.addEventListener('click', reEnrichAll);

// ============================ COOKIES HUB ===================================
let ckSearch = '';
let ckStatus = 'all'; // all | valid | expired | unchecked
const CK_STATUS_OPTS = [{ value: 'all', label: 'All statuses' }, { value: 'valid', label: 'Valid' }, { value: 'expired', label: 'Expired' }, { value: 'unchecked', label: 'Unchecked' }];
function ckStatusOf(a) { return a.cookieValid === true ? 'valid' : a.cookieValid === false ? 'expired' : 'unchecked'; }
function renderCookies() {
  const list = $('#ck-list'); if (!list) return;
  const withCookie = accounts.filter((a) => a.cookie);
  // Stats (whole pool, not filtered)
  const valid = withCookie.filter((a) => a.cookieValid === true).length;
  const exp = withCookie.filter((a) => a.cookieValid === false).length;
  const unk = withCookie.length - valid - exp;
  const setTxt = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  setTxt('#ck-stat-total', withCookie.length); setTxt('#ck-stat-total-d', `of ${accounts.length} accounts`);
  setTxt('#ck-stat-valid', valid); setTxt('#ck-stat-exp', exp); setTxt('#ck-stat-unk', unk);
  setTxt('#ck-crumb', `${withCookie.length} stored`);
  // Filter for the table
  const q = ckSearch.trim().toLowerCase();
  const rows = withCookie.filter((a) => {
    if (ckStatus !== 'all' && ckStatusOf(a) !== ckStatus) return false;
    if (q && !((a.pseudo || '').toLowerCase().includes(q) || String(a.userId || '').includes(q))) return false;
    return true;
  });
  if (!rows.length) {
    list.innerHTML = `<div class="ck-empty">${withCookie.length ? 'No cookies match this filter.' : 'No stored cookies yet — generate accounts or use Import cookies.'}</div>`;
    return;
  }
  const COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const REF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
  const KA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg>';
  const LOGIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/></svg>';
  list.innerHTML = rows.map((a) => {
    const st = a.cookieValid === true ? '<span class="vpill yes">valid</span>' : a.cookieValid === false ? '<span class="vpill no">expired</span>' : '<span class="ck-unknown">unchecked</span>';
    return `<div class="ck-row" data-id="${a.id}">
      <div class="avi-lg" style="${avatarStyle(a)}">${avatarInner(a)}</div>
      <span class="ck-name">${esc(a.pseudo || '(no name)')}</span>
      <span class="ck-id">${a.userId ? esc(String(a.userId)) : '—'}</span>
      <span>${st}</span>
      <span class="ck-checked">${timeAgo(a.cookieCheckedAt)}</span>
      <div class="ck-actions">
        <span class="mini-btn" data-ckcopy="${a.id}" title="Copy cookie">${COPY}</span>
        <span class="mini-btn" data-ckcheck="${a.id}" title="Check validity">${REF}</span>
        <span class="mini-btn" data-ckrefresh="${a.id}" title="Keep-alive (rotate cookie)">${KA}</span>
        <span class="mini-btn" data-cklogin="${a.id}" title="Login">${LOGIN}</span>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-ckcopy]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const a = getAcc(b.dataset.ckcopy); if (a && a.cookie) copyText(a.cookie); }));
  list.querySelectorAll('[data-ckcheck]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); checkCookie(getAcc(b.dataset.ckcheck)); }));
  list.querySelectorAll('[data-ckrefresh]').forEach((b) => b.addEventListener('click', async (e) => { e.stopPropagation(); const a = getAcc(b.dataset.ckrefresh); if (!a) return; toast('Refreshing…'); const ok = await refreshOneCookie(a); save(); renderCookies(); toast(ok ? 'Cookie refreshed ✓' : 'Refresh failed'); }));
  list.querySelectorAll('[data-cklogin]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); loginAccount(b.dataset.cklogin); }));
  list.querySelectorAll('.ck-row').forEach((r) => r.addEventListener('click', () => openModal(r.dataset.id)));
}
// Only flip the flag on a DEFINITIVE result — a rate-limit/timeout ('unknown') must not mark a
// live cookie expired (that's what nuked the whole list when checking hundreds at once).
function applyCookieStatus(a, r) {
  if (r && r.status === 'alive') a.cookieValid = true;
  else if (r && r.status === 'dead') a.cookieValid = false;
  // 'unknown' → leave a.cookieValid unchanged
  a.cookieCheckedAt = new Date().toISOString();
}
async function checkCookie(a) {
  if (!a || !a.cookie) return;
  const r = await window.api.cookieAliveCheck(a.cookie);
  applyCookieStatus(a, r);
  save(); renderCookies();
}
// Run async work over items with a small concurrency cap (avoids hammering the API).
async function runPool(items, limit, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
// Keep-alive: rotate the account's .ROBLOSECURITY (extends its life). Updates the account + the
// injected session cookie. Returns true on success.
async function refreshOneCookie(a) {
  if (!a || !a.cookie) return false;
  const r = await window.api.refreshCookie(a.cookie);
  if (r && r.ok && r.cookie) {
    a.cookie = r.cookie;
    a.cookieValid = true;
    a.cookieCheckedAt = new Date().toISOString();
    a.cookieRefreshedAt = new Date().toISOString();
    window.api.setCookie({ accountId: a.id, cookie: r.cookie }); // re-inject into the browser session
    return true;
  }
  return false;
}
async function importCookies() {
  const area = $('#ck-import-area'); const status = $('#ck-import-status');
  const raw = (area && area.value) || '';
  const cookies = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim(); if (!t) continue;
    const idx = t.indexOf('_|WARNING');
    if (idx >= 0) cookies.push(t.slice(idx));
    else if (t.length > 150) cookies.push(t);
  }
  if (!cookies.length) { if (status) status.textContent = 'No cookies found in the text.'; return; }
  if (status) status.textContent = `Importing ${cookies.length}…`;
  let added = 0, dup = 0, failed = 0;
  for (const cookie of cookies) {
    const id = await window.api.cookieIdentity(cookie);
    if (!id || !id.ok) { failed++; continue; }
    if (accounts.find((a) => (a.userId && a.userId === id.userId) || (a.cookie && a.cookie === cookie))) { dup++; continue; }
    const acc = normalize({ pseudo: id.username, userId: id.userId, displayName: id.displayName, avatarUrl: id.avatarUrl, cookie, tags: ['imported'] });
    acc.cookieValid = true; acc.cookieCheckedAt = new Date().toISOString();
    accounts.unshift(acc); added++;
    window.api.setCookie({ accountId: acc.id, cookie });
    if (settings.autoFetch !== false) {
      window.api.refreshInfo({ accountId: acc.id, cookie }).then((info) => { if (info && info.loggedIn) { applyDetectedInfo(acc, info); renderCookies(); } }).catch(() => {});
      window.api.robuxRap({ userId: acc.userId, cookie }).then((r) => { if (r && r.ok && typeof r.robux === 'number') { acc.robux = r.robux; save(); renderAccounts(); } }).catch(() => {});
    }
  }
  save(); renderAccounts(); renderCookies();
  if (status) status.textContent = `Imported ${added} · ${dup} dupe${dup === 1 ? '' : 's'} · ${failed} failed`;
  if (area) area.value = '';
  if (added) toast(`Imported ${added} account${added === 1 ? '' : 's'}`);
}
$('#ck-import-btn')?.addEventListener('click', importCookies);
// Import modal open/close
function openImportModal() { const s = $('#ck-import-scrim'); if (s) { s.hidden = false; const a = $('#ck-import-area'); if (a) setTimeout(() => a.focus(), 30); } }
function closeImportModal() { const s = $('#ck-import-scrim'); if (s) s.hidden = true; }
$('#ck-import-open')?.addEventListener('click', openImportModal);
$('#ck-import-close')?.addEventListener('click', closeImportModal);
$('#ck-import-scrim')?.addEventListener('click', (e) => { if (e.target.id === 'ck-import-scrim') closeImportModal(); });

// ===================== IMPORT FROM BLOXGEN (.txt export) =====================
// File format: one account per line as `username:password:cookie`. The cookie itself
// contains ':' (in its WARNING banner), so we split on the FIRST TWO colons only.
let bgText = '';
function bgParse(text) {
  const seen = new Set(accounts.map((a) => (a.pseudo || '').toLowerCase()).filter(Boolean));
  const out = []; let dup = 0, bad = 0;
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const p1 = line.indexOf(':'); if (p1 < 1) { bad++; continue; }
    const p2 = line.indexOf(':', p1 + 1);
    const username = line.slice(0, p1).trim();
    const password = (p2 >= 0 ? line.slice(p1 + 1, p2) : line.slice(p1 + 1)).trim();
    const cookie = p2 >= 0 ? line.slice(p2 + 1).trim() : '';
    if (!username) { bad++; continue; }
    const key = username.toLowerCase();
    if (seen.has(key)) { dup++; continue; }       // no two accounts with the same username
    seen.add(key);
    out.push({ username, password, cookie });
  }
  return { entries: out, dup, bad };
}
function bgSetFile(text, fname) {
  bgText = text || '';
  const { entries, dup, bad } = bgParse(bgText);
  const drop = $('#bg-drop'); const t = $('#bg-drop-t'); const btn = $('#bg-import-btn'); const lbl = $('#bg-import-lbl');
  if (drop) drop.classList.add('ready');
  if (t) t.innerHTML = `<b>${fname || 'file'}</b> · ${entries.length} new account${entries.length === 1 ? '' : 's'}`;
  const parts = [];
  if (dup) parts.push(`${dup} duplicate${dup === 1 ? '' : 's'} skipped`);
  if (bad) parts.push(`${bad} unreadable`);
  const st = $('#bg-import-status'); if (st) st.textContent = parts.join(' · ');
  if (btn) { btn.hidden = entries.length === 0; }
  if (lbl) lbl.textContent = `Import ${entries.length} account${entries.length === 1 ? '' : 's'}`;
}
// Verify each imported cookie so nothing is left "unchecked" in the Cookies screen.
// cookieIdentity gives validity + identity in one call when alive; for the non-ok minority we
// fall back to cookieAliveStatus (only flips to expired on a definitive 401/403) with one retry.
async function bgCheckAccount(a) {
  if (!a || !a.cookie) return;
  const id = await window.api.cookieIdentity(a.cookie);
  if (id && id.ok) {
    a.cookieValid = true;
    if (id.userId && !a.userId) a.userId = id.userId;
    if (id.avatarUrl && !a.avatarUrl) a.avatarUrl = id.avatarUrl;
    if (id.displayName && !a.displayName) a.displayName = id.displayName;
    a.cookieCheckedAt = new Date().toISOString();
    return;
  }
  let r = await window.api.cookieAliveCheck(a.cookie);
  if (r && r.status === 'unknown') { await sleep(700); r = await window.api.cookieAliveCheck(a.cookie); }
  applyCookieStatus(a, r);
}
async function importBloxgen() {
  const { entries } = bgParse(bgText);
  if (!entries.length) return;
  const btn = $('#bg-import-btn'); const st = $('#bg-import-status');
  const prog = $('#bg-progress'); const bar = $('#bg-bar');
  if (btn) btn.classList.add('disabled');
  // 1) Create every account up-front (instant) so they show immediately.
  const created = [];
  for (const e of entries) {
    const acc = normalize({ pseudo: e.username, password: e.password, cookie: e.cookie, tags: ['bloxgen', 'imported'] });
    accounts.unshift(acc); created.push(acc);
    if (e.cookie) window.api.setCookie({ accountId: acc.id, cookie: e.cookie });
  }
  save(); renderAccounts(); renderHistory();
  // 2) Check each cookie (concurrency-capped) so none stays "unchecked".
  const withCk = created.filter((a) => a.cookie);
  if (prog) prog.hidden = false;
  let done = 0, alive = 0, dead = 0;
  await runPool(withCk, 5, async (a) => {
    await bgCheckAccount(a);
    done++;
    if (a.cookieValid === true) alive++; else if (a.cookieValid === false) dead++;
    if (bar) bar.style.width = Math.round((done / withCk.length) * 100) + '%';
    if (st) st.textContent = `Checking cookies… ${done}/${withCk.length}`;
    if (done % 10 === 0) { save(); renderCookies(); renderAccounts(); }
  });
  save(); renderCookies(); renderAccounts(); renderHistory();
  // Fill userId + profile photo for everyone still missing them (esp. accounts with no/dead
  // cookie): resolved by username via one batched public lookup.
  if (st) st.textContent = 'Fetching profiles…';
  await autoEnrich();
  const unknown = withCk.length - alive - dead;
  if (st) st.textContent = `Imported ${created.length} · ${alive} valid · ${dead} expired${unknown ? ` · ${unknown} unchecked` : ''}`;
  toast(`Imported ${created.length} account${created.length === 1 ? '' : 's'}`);
  if (btn) { btn.classList.remove('disabled'); btn.hidden = true; }
  const drop = $('#bg-drop'); const t = $('#bg-drop-t');
  if (drop) drop.classList.remove('ready');
  if (t) t.innerHTML = 'Import moved to Cookies';
  bgText = '';
}
function openBloxgenModal() { const s = $('#bg-import-scrim'); if (s) s.hidden = false; }
function closeBloxgenModal() {
  const s = $('#bg-import-scrim'); if (s) s.hidden = true;
  bgText = ''; const btn = $('#bg-import-btn'); if (btn) btn.hidden = true;
  const drop = $('#bg-drop'); if (drop) drop.classList.remove('ready', 'drag');
  const t = $('#bg-drop-t'); if (t) t.innerHTML = 'Import moved to Cookies';
  const st = $('#bg-import-status'); if (st) st.textContent = '';
  const prog = $('#bg-progress'); if (prog) prog.hidden = true; const bar = $('#bg-bar'); if (bar) bar.style.width = '0%';
}
$('#acc-bloxgen-import')?.addEventListener('click', openBloxgenModal);
$('#bg-import-close')?.addEventListener('click', closeBloxgenModal);
$('#bg-import-scrim')?.addEventListener('click', (e) => { if (e.target.id === 'bg-import-scrim') closeBloxgenModal(); });
$('#bg-import-btn')?.addEventListener('click', importBloxgen);
// Drop zone: click to browse (native dialog) or drag a .txt onto it.
$('#bg-drop')?.addEventListener('click', async () => {
  const r = await window.api.importTxt();
  if (r && r.ok) bgSetFile(r.text || '', r.name || 'file');
});
$('#bg-drop')?.addEventListener('dragover', (e) => { e.preventDefault(); $('#bg-drop').classList.add('drag'); });
$('#bg-drop')?.addEventListener('dragleave', () => $('#bg-drop').classList.remove('drag'));
$('#bg-drop')?.addEventListener('drop', async (e) => {
  e.preventDefault(); $('#bg-drop').classList.remove('drag');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  try { const text = await f.text(); bgSetFile(text, f.name); } catch { const st = $('#bg-import-status'); if (st) st.textContent = 'Could not read that file.'; }
});

// Search + status filter
$('#ck-search')?.addEventListener('input', (e) => { ckSearch = e.target.value; renderCookies(); });
$('#ck-f-status')?.addEventListener('click', function () {
  openDropdown(this, CK_STATUS_OPTS, ckStatus, (v) => { ckStatus = v; const lbl = (CK_STATUS_OPTS.find((o) => o.value === v) || {}).label; this.querySelector('span').textContent = lbl; renderCookies(); });
});
$('#ck-check-all')?.addEventListener('click', async () => {
  const withCookie = accounts.filter((a) => a.cookie);
  if (!withCookie.length) { toast('No cookies'); return; }
  toast(`Checking ${withCookie.length}…`);
  let n = 0;
  await runPool(withCookie, 6, async (a) => {
    const r = await window.api.cookieAliveCheck(a.cookie);
    applyCookieStatus(a, r);
    if (++n % 20 === 0) { renderCookies(); }
  });
  save(); renderCookies();
  const valid = withCookie.filter((a) => a.cookieValid === true).length;
  toast(`Checked — ${valid} alive`);
});
// Keep-alive all: rotate every non-expired cookie to extend their lifetime.
$('#ck-refresh-all')?.addEventListener('click', async () => {
  const targets = accounts.filter((a) => a.cookie && a.cookieValid !== false);
  if (!targets.length) { toast('No live cookies to refresh'); return; }
  const conf = await window.api.confirm(`Rotate ${targets.length} cookie${targets.length === 1 ? '' : 's'} to keep them alive? The old cookies become invalid (the website updates them automatically).`, ['Refresh', 'Cancel']);
  if (conf !== 0) return;
  toast(`Refreshing ${targets.length}…`);
  let ok = 0, n = 0;
  await runPool(targets, 4, async (a) => {
    if (await refreshOneCookie(a)) ok++;
    if (++n % 15 === 0) { save(); renderCookies(); }
  });
  save(); renderCookies();
  toast(`Keep-alive done — ${ok}/${targets.length} refreshed`);
});
$('#ck-copy-all')?.addEventListener('click', () => {
  const withCookie = accounts.filter((a) => a.cookie);
  if (!withCookie.length) { toast('No cookies'); return; }
  copyText(withCookie.map((a) => `${a.pseudo}:${a.cookie}`).join('\n'));
});
// Recover cookies that were injected into the Electron session partitions by the
// old app (generated before cookie-saving existed) but never written to disk.
$('#ck-recover')?.addEventListener('click', async () => {
  const missing = accounts.filter((a) => !a.cookie);
  if (!missing.length) { toast('Every account already has a cookie'); return; }
  toast(`Scanning ${missing.length} sessions…`);
  let found = 0;
  for (const a of missing) {
    try {
      const ck = await window.api.getCookie(a.id);
      if (ck && ck.length > 10) { a.cookie = ck; a.cookieValid = undefined; found++; }
    } catch {}
  }
  if (found) { save(); renderCookies(); renderAccounts(); }
  toast(`Recovered ${found} cookie${found === 1 ? '' : 's'} from sessions`);
});

// ============================ SUPPORT =======================================
let supVersion = '';
function renderSupport() {
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  set('#sup-accounts', accounts.length);
  set('#sup-keys', keyList().length);
  set('#sup-cookies', accounts.filter((a) => a.cookie).length);
  // platform removed
  if (supVersion) { set('#sup-version', supVersion); set('#sup-foot-v', 'v' + supVersion); }
  else window.api.version().then((v) => { supVersion = v || '—'; set('#sup-version', supVersion); set('#sup-foot-v', supVersion === '—' ? '—' : 'v' + supVersion); }).catch(() => {});
}
function diagText() {
  return [
    'ogalts diagnostics',
    'version: ' + (supVersion || '?'),
    'platform: ' + (navigator.platform || '?'),
    'accounts: ' + accounts.length,
    'api keys: ' + keyList().length,
    'cookies stored: ' + accounts.filter((a) => a.cookie).length,
  ].join('\n');
}
$('#sup-copy-diag')?.addEventListener('click', () => copyText(diagText()));
$('#sup-open-data')?.addEventListener('click', () => window.api.openDataFolder());
$('#sup-export')?.addEventListener('click', async () => {
  if (!accounts.length) { toast('No accounts to export'); return; }
  try { const r = await window.api.export(accounts); toast(r && r.ok ? 'Exported accounts' : 'Export canceled'); }
  catch { toast('Export failed'); }
});
$('#sup-update')?.addEventListener('click', () => {
  const s = $('#sup-update-status'); if (s) s.textContent = 'Checking…';
  window.api.updateCheck();
});
window.api.onUpdateAvailable?.((d) => { const s = $('#sup-update-status'); if (s) s.textContent = 'Update available: v' + ((d && d.version) || '?'); });
window.api.onUpdateNone?.(() => { const s = $('#sup-update-status'); if (s) s.textContent = 'You’re up to date'; });
window.api.onUpdateError?.((d) => { const s = $('#sup-update-status'); if (s) s.textContent = 'Update check failed'; });

// ============================ INVENTORY VAULT (all accounts) ================
let vaultItems = null;      // aggregated [{...item, owner, ownerId, value}] built from the cache
let vaultCache = {};        // { [accountId]: { items:[{name,id,kind,type,rap}], scannedAt, pseudo } }
let priceCache = {};        // { "Asset:123"|"Bundle:45": { v: robuxValue, n: name } } — global, item price is the same for everyone
let vaultCacheLoaded = false;
let vaultScanning = false;
let vaultSearch = '';
let vaultSort = 'value_desc';
let vaultCat = 'all';
const invKey = (it) => (it.kind === 'bundle' ? 'Bundle' : 'Asset') + ':' + it.id;
async function loadVaultCache() {
  try { const c = await window.api.vaultLoad(); vaultCache = (c && c.accounts) ? c.accounts : {}; priceCache = (c && c.prices) ? c.prices : {}; }
  catch { vaultCache = {}; priceCache = {}; }
  vaultCacheLoaded = true;
}
function saveVaultCache() { try { window.api.vaultSave({ accounts: vaultCache, prices: priceCache }); } catch { /* ignore */ } }
function buildVaultItems() {
  vaultItems = [];
  for (const id of Object.keys(vaultCache)) {
    const entry = vaultCache[id]; if (!entry || !Array.isArray(entry.items)) continue;
    const acc = getAcc(id);
    const owner = (acc && acc.pseudo) || entry.pseudo || 'account';
    for (const it of entry.items) {
      const pc = priceCache[invKey(it)];
      const value = pc ? pc.v : (it.value != null ? it.value : null);
      vaultItems.push(Object.assign({}, it, { value, owner, ownerId: id }));
    }
  }
}
// Price every UNIQUE item across the vault that isn't cached yet — one catalog lookup per item,
// not per account. Rotates through several valid cookies so a single one's rate limit doesn't cap
// coverage. Prices are global, so this fills the shared priceCache once (value only, no name).
async function priceVault(cookies) {
  const cks = (Array.isArray(cookies) ? cookies : [cookies]).filter(Boolean);
  if (!cks.length) return;
  const need = new Map();
  for (const id of Object.keys(vaultCache)) {
    for (const it of (vaultCache[id].items || [])) {
      if (it.kind === 'gamepass') continue;
      const key = invKey(it);
      if (priceCache[key] === undefined && !need.has(key)) need.set(key, { id: it.id, kind: it.kind });
    }
  }
  const list = [...need.values()];
  if (!list.length) return;
  let ci = 0;
  for (let i = 0; i < list.length; i += 100) {
    const cookie = cks[ci++ % cks.length];
    const r = await window.api.inventoryValue({ items: list.slice(i, i + 100), cookie });
    if (r && r.ok) for (const key of Object.keys(r.values)) priceCache[key] = { v: r.values[key] };
  }
}
// Fetch ONE account's inventory items (prices come from the shared priceCache, not per account).
async function fetchAccountInventory(acc) {
  const inv = await window.api.inventoryFull({ userId: acc.userId, cookie: acc.cookie });
  if (!inv || !inv.ok) return null;
  // Store items raw; prices are resolved once, globally, via priceVault()/priceCache.
  return inv.items.map((it) => ({ name: it.name, id: it.id, kind: it.kind || 'asset', type: it.type, value: it.value != null ? it.value : null, rap: it.rap != null ? it.rap : null }));
}
async function addToVault(acc) {
  if (!acc || !acc.cookie) return;
  try {
    if (!vaultCacheLoaded) await loadVaultCache(); // never overwrite the file with an empty cache
    if (!acc.userId && acc.pseudo) { // a freshly generated account may not have its id yet
      try { const e = await window.api.enrich(acc.pseudo); if (e && e.ok && e.userId) acc.userId = e.userId; } catch { /* ignore */ }
    }
    if (!acc.userId) return;
    const items = await fetchAccountInventory(acc);
    if (!items) return;
    vaultCache[acc.id] = { items, scannedAt: new Date().toISOString(), pseudo: acc.pseudo };
    await priceVault(acc.cookie); // price any new unique items into the global cache
    saveVaultCache();
    if (currentScreen === 'vault') { buildVaultItems(); renderVault(); }
    else if (items.length) toast(`Vault +${items.length} items · ${acc.pseudo || ''}`);
  } catch { /* ignore */ }
}
const VAULT_SORTS = [
  { value: 'value_desc', label: 'Value ↓' },
  { value: 'value_asc', label: 'Value ↑' },
  { value: 'name', label: 'Name A→Z' },
  { value: 'owner', label: 'By account' },
];
function vaultVal(i) { return i.value != null ? i.value : (i.rap != null ? i.rap : 0); }
function sortVault(items) {
  const arr = items.slice();
  if (vaultSort === 'value_desc') arr.sort((a, b) => vaultVal(b) - vaultVal(a));
  else if (vaultSort === 'value_asc') arr.sort((a, b) => vaultVal(a) - vaultVal(b));
  else if (vaultSort === 'name') arr.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  else if (vaultSort === 'owner') arr.sort((a, b) => String(a.owner).localeCompare(String(b.owner)) || vaultVal(b) - vaultVal(a));
  return arr;
}
// Scannable = has cookie + userId and the cookie isn't KNOWN-expired (valid or not-yet-checked).
function vaultScannable() { return accounts.filter((a) => a.cookie && a.userId && a.cookieValid !== false); }
function renderVault() {
  if (!vaultCacheLoaded) { loadVaultCache().then(() => { buildVaultItems(); renderVault(); }); return; }
  if (!vaultItems) buildVaultItems();
  const st = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  const withCk = vaultScannable();
  st('#vault-accts', withCk.length);
  setSwitch($('#vault-auto'), !!settings.vaultAutoAdd);
  const listEl = $('#vault-list');
  if (!vaultItems.length) {
    st('#vault-items', 0); st('#vault-value', '0'); st('#vault-lim', 0); st('#vault-items-d', 'across 0 accounts'); st('#vault-crumb', 'all accounts');
    if (listEl) listEl.innerHTML = `<div class="ck-empty">${withCk.length ? 'Click <b>Scan all</b> to load every cookie account’s inventory here.' : 'No accounts have a stored cookie yet.'}</div>`;
    return;
  }
  const totalVal = vaultItems.reduce((s, i) => s + (i.value || 0), 0);
  const owners = new Set(vaultItems.map((i) => i.ownerId));
  const lim = vaultItems.filter((i) => i.rap != null).length;
  st('#vault-items', fmtNum(vaultItems.length));
  st('#vault-items-d', `across ${owners.size} account${owners.size === 1 ? '' : 's'}`);
  st('#vault-value', fmtNum(totalVal));
  st('#vault-lim', fmtNum(lim));
  st('#vault-crumb', `${fmtNum(vaultItems.length)} items`);
  const q = vaultSearch.trim().toLowerCase();
  let items = vaultItems.filter((it) => {
    if (vaultCat !== 'all' && it.type !== vaultCat) return false;
    if (q && !(it.name || '').toLowerCase().includes(q) && !(it.owner || '').toLowerCase().includes(q)) return false;
    return true;
  });
  items = sortVault(items);
  const CAP = 800;
  const shown = items.slice(0, CAP);
  if (listEl) {
    listEl.innerHTML = shown.length
      ? invGridHTML(shown) + (items.length > CAP ? `<div class="ck-empty">Showing first ${CAP} of ${fmtNum(items.length)} — narrow with search.</div>` : '')
      : '<div class="ck-empty">No items match.</div>';
    wireInvRows(listEl);
  }
}
async function scanAllVault() {
  if (vaultScanning) return;
  const withCk = vaultScannable();
  if (!withCk.length) { toast('No accounts with a valid/unchecked cookie'); return; }
  if (!vaultCacheLoaded) await loadVaultCache();
  vaultScanning = true;
  const prog = $('#vault-progress'), bar = $('#vault-bar'), st = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  if (prog) prog.hidden = false; if (bar) bar.style.width = '0%';
  st('#vault-status', 'scanning…');
  let n = 0;
  // Independent cookies → scan several accounts in parallel (bounded, to stay under rate limits).
  await runPool(withCk, 3, async (a) => {
    try {
      const items = await fetchAccountInventory(a);
      if (items) vaultCache[a.id] = { items, scannedAt: new Date().toISOString(), pseudo: a.pseudo };
    } catch { /* skip account */ }
    n++;
    if (bar) bar.style.width = Math.round((n / withCk.length) * 92) + '%';
    st('#vault-status', `scanning ${n}/${withCk.length}`);
    buildVaultItems();
    st('#vault-items', fmtNum(vaultItems.length));
    st('#vault-value', fmtNum(vaultItems.reduce((s, i) => s + (i.value || 0), 0)));
  });
  // One global pricing pass for all unique items, rotating cookies to avoid rate-limit caps.
  st('#vault-status', 'pricing items…');
  if (bar) bar.style.width = '96%';
  try { await priceVault(withCk.map((a) => a.cookie)); } catch { /* ignore */ }
  vaultScanning = false;
  saveVaultCache();
  if (prog) prog.hidden = true;
  st('#vault-status', 'scanned');
  buildVaultItems();
  renderVault();
}
$('#vault-scan')?.addEventListener('click', scanAllVault);
$('#vault-auto')?.addEventListener('click', () => { settings.vaultAutoAdd = !settings.vaultAutoAdd; setSwitch($('#vault-auto'), settings.vaultAutoAdd); saveSettings(); toast(settings.vaultAutoAdd ? 'Generated accounts will auto-add to the vault' : 'Auto-add off'); });
$('#vault-search')?.addEventListener('input', (e) => { vaultSearch = e.target.value; renderVault(); });
$('#vault-sort')?.addEventListener('click', function () {
  openDropdown(this, VAULT_SORTS, vaultSort, (v) => { vaultSort = v; this.querySelector('span').textContent = (VAULT_SORTS.find((o) => o.value === v) || {}).label; renderVault(); });
});
$('#vault-f-cat')?.addEventListener('click', function () {
  const counts = {}; (vaultItems || []).forEach((i) => { counts[i.type] = (counts[i.type] || 0) + 1; });
  const opts = [{ value: 'all', label: 'All types' }, ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, c]) => ({ value: t, label: `${t} (${c})` }))];
  openDropdown(this, opts, vaultCat, (v) => { vaultCat = v; this.querySelector('span').textContent = v === 'all' ? 'All types' : v; renderVault(); });
});

// ============================ WHAT'S NEW ====================================
// Add an entry per released version. Shown once, automatically, after an update.
const CHANGELOG = {
  '1.6.0': [
    '🟦 New “Roblox” theme — the Creator Hub look (Settings → Appearance).',
    '📥 Import account — use Cookies → Import cookies (Cookie-Editor). Beta: use at your own risk.',
    '🔄 Auto cookie keep-alive — schedule background cookie rotation (Settings → Security), with a Run-now button.',
    '🧩 Custom Accounts table — pick which columns to show, choose 25/50/100 per page, and actions become full labeled buttons (Favorite / Change password / Login) when there’s room.',
    '🗂️ Collapsible sidebar — collapse to an icon rail with hover tooltips and a quota fly-out.',
    '⏱️ Account activity timeline — when each account was added, password-changed, cookie-refreshed and last logged in (Activity tab); Recently played is now its own tab.',
    '♻️ Re-enrich all — refresh every account’s avatar and ID in one click.',
    '🔑 Password settings — a dedicated category (auto-change on generate, prefix + length) and a cleaner, wider Settings layout.',
  ],
  '1.5.0': [
    '🎨 Themes — pick from Forge, Light, Airbnb, Apple or Arc in Settings → Appearance.',
    '🎮 Games tab — search a game and see which of your accounts have played it (badges + recently played), with live presence.',
    '🔑 Cookie keep-alive — rotate cookies to extend their life, per account or all at once, in the Cookies screen. Generated accounts are auto-marked valid.',
    '🤝 Bulk “Add as friend” — select accounts and friend a target user in one click, with a detailed result (ok / captcha / rate-limited / failed).',
    '💰 Inventory value is now accurate across all accounts (prices cached globally) and the vault scans faster.',
    '🐧 Runs on Linux too (AppImage) — same automatic updates as Windows.',
  ],
};
function showWhatsNew(version, notes) {
  if (document.querySelector('.wn-scrim')) return;
  const scrim = document.createElement('div');
  scrim.className = 'wn-scrim';
  scrim.innerHTML = `
    <div class="wn-modal">
      <div class="wn-head"><span class="wn-title">What’s new</span><span class="wn-ver">v${esc(version)}</span></div>
      <ul class="wn-list">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      <div class="wn-foot"><div class="set-btn primary" id="wn-close">Got it</div></div>
    </div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.querySelector('#wn-close').addEventListener('click', close);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
}
async function checkWhatsNew() {
  let version; try { version = await window.api.version(); } catch { return; }
  if (settings.lastSeenVersion !== version) {
    const notes = CHANGELOG[version];
    if (notes) showWhatsNew(version, notes);
    settings.lastSeenVersion = version; saveSettings();
  }
}
// Manual trigger from Settings → About.
$('#set-whatsnew')?.addEventListener('click', async () => {
  const v = await window.api.version().catch(() => null);
  const keys = Object.keys(CHANGELOG);
  const ver = (v && CHANGELOG[v]) ? v : keys[0];
  if (ver && CHANGELOG[ver]) showWhatsNew(ver, CHANGELOG[ver]); else toast('No changelog yet');
});

// ============================ GAMES (who played what) =======================
// gamesCache = { accounts: { [id]: { universes: {uid:{badges}}, recent:[uid], pseudo } }, places: {placeId:uid} }
let gamesCache = { accounts: {}, places: {} };
let gamesCacheLoaded = false;
let gamesScanning = false;
let selectedGame = null; // { universeId, name, iconUrl }
let gamesAcTimer = null;
async function loadGamesCache() {
  try { const c = await window.api.gamesLoad(); gamesCache = (c && c.accounts) ? { accounts: c.accounts, places: c.places || {} } : { accounts: {}, places: {} }; }
  catch { gamesCache = { accounts: {}, places: {} }; }
  gamesCacheLoaded = true;
}
function saveGamesCache() { try { window.api.gamesSave(gamesCache); } catch { /* ignore */ } }
function renderGames() {
  if (!gamesCacheLoaded) { loadGamesCache().then(renderGames); return; }
  const scannable = accounts.filter((a) => a.cookie && a.userId && a.cookieValid !== false);
  const scanned = Object.keys(gamesCache.accounts).length;
  const st = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  st('#games-stat-scanned', scanned); st('#games-stat-scanned-d', `of ${scannable.length} accounts`);
  renderGamesResults();
}
// --- search + autocomplete ---
$('#games-q')?.addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(gamesAcTimer);
  const ac = $('#games-ac');
  if (q.length < 2) { if (ac) { ac.hidden = true; ac.innerHTML = ''; } return; }
  gamesAcTimer = setTimeout(async () => {
    const res = await window.api.searchGames(q);
    if (!ac) return;
    if (!res || !res.length) { ac.hidden = false; ac.innerHTML = '<div class="games-ac-empty">No games found.</div>'; return; }
    ac.hidden = false;
    ac.innerHTML = res.filter((g) => g.universeId).map((g) => `
      <div class="games-ac-row" data-uid="${g.universeId}" data-name="${esc(g.name)}" data-icon="${g.iconUrl || ''}">
        <div class="games-ac-ico" style="${g.iconUrl ? `background-image:url('${g.iconUrl}')` : ''}"></div>
        <span class="games-ac-nm">${esc(g.name)}</span>
      </div>`).join('');
    ac.querySelectorAll('.games-ac-row').forEach((r) => r.addEventListener('click', () => {
      selectGame({ universeId: r.dataset.uid, name: r.dataset.name, iconUrl: r.dataset.icon || null });
    }));
  }, 260);
});
document.addEventListener('mousedown', (e) => { const ac = $('#games-ac'); if (ac && !ac.hidden && !e.target.closest('.games-search')) { ac.hidden = true; } });
function selectGame(g) {
  selectedGame = g;
  const ac = $('#games-ac'); if (ac) { ac.hidden = true; ac.innerHTML = ''; }
  $('#games-q').value = g.name;
  const sel = $('#games-sel'); if (sel) sel.hidden = false;
  const ico = $('#gsel-icon'); if (ico) ico.style.backgroundImage = g.iconUrl ? `url('${g.iconUrl}')` : '';
  $('#gsel-name').textContent = g.name;
  $('#gsel-sub').textContent = 'universe ' + g.universeId;
  $('#games-status').textContent = 'ready to scan';
  renderGamesResults();
}
// --- scan: badges (+ place→universe) and recently-played, per account ---
async function scanGames() {
  if (gamesScanning) return;
  if (!gamesCacheLoaded) await loadGamesCache();
  const scannable = accounts.filter((a) => a.cookie && a.userId && a.cookieValid !== false);
  if (!scannable.length) { toast('No accounts with a valid/unchecked cookie'); return; }
  gamesScanning = true;
  const prog = $('#games-progress'), bar = $('#games-bar'), st = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  if (prog) prog.hidden = false; if (bar) bar.style.width = '0%';
  st('#games-status', 'scanning…');
  let n = 0;
  const pendingPlaces = new Set();
  await runPool(scannable, 3, async (a) => {
    const entry = { universes: {}, recent: [], pseudo: a.pseudo };
    try {
      const b = await window.api.userBadges({ userId: a.userId, cookie: a.cookie });
      if (b && b.ok && b.places) entry._places = b.places; // {placeId:count} resolved after
    } catch { /* ignore */ }
    try {
      const rp = await window.api.recentlyPlayed({ cookie: a.cookie });
      if (rp && rp.ok) for (const g of rp.games) if (g.universeId) entry.recent.push(String(g.universeId));
    } catch { /* ignore */ }
    // note unknown places for batch resolution
    for (const pid of Object.keys(entry._places || {})) if (!gamesCache.places[pid]) pendingPlaces.add(pid);
    gamesCache.accounts[a.id] = entry;
    n++;
    if (bar) bar.style.width = Math.round((n / scannable.length) * 80) + '%';
    st('#games-status', `scanning ${n}/${scannable.length}`);
  });
  // resolve all unknown badge places → universes (batched)
  st('#games-status', 'resolving games…'); if (bar) bar.style.width = '88%';
  const list = [...pendingPlaces];
  for (let i = 0; i < list.length; i += 100) {
    try { const map = await window.api.placesUniverses(list.slice(i, i + 100)); Object.assign(gamesCache.places, map); } catch { /* ignore */ }
  }
  // fold badge places into per-account universe badge counts
  for (const id of Object.keys(gamesCache.accounts)) {
    const e = gamesCache.accounts[id];
    e.universes = {};
    for (const pid of Object.keys(e._places || {})) {
      const uid = gamesCache.places[pid];
      if (!uid) continue;
      e.universes[uid] = { badges: (e.universes[uid] ? e.universes[uid].badges : 0) + e._places[pid] };
    }
    delete e._places;
  }
  gamesScanning = false;
  saveGamesCache();
  if (prog) prog.hidden = true;
  st('#games-status', 'scanned');
  renderGames();
}
$('#games-scan')?.addEventListener('click', scanGames);
function renderGamesResults() {
  const listEl = $('#games-list'); if (!listEl) return;
  const st = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  if (!selectedGame) { listEl.innerHTML = '<div class="ck-empty">Search a game above, then <b>Scan accounts</b> to see who played it.</div>'; return; }
  const uid = String(selectedGame.universeId);
  const rows = [];
  let totalBadges = 0;
  for (const id of Object.keys(gamesCache.accounts)) {
    const e = gamesCache.accounts[id];
    const u = e.universes && e.universes[uid];
    const recent = Array.isArray(e.recent) && e.recent.includes(uid);
    if (!u && !recent) continue;
    const acc = getAcc(id);
    const badges = u ? u.badges : 0;
    totalBadges += badges;
    rows.push({ id, pseudo: (acc && acc.pseudo) || e.pseudo || 'account', avatarUrl: acc && acc.avatarUrl, badges, recent, acc });
  }
  rows.sort((a, b) => b.badges - a.badges || (b.recent - a.recent));
  st('#games-stat-played', rows.length);
  st('#games-stat-badges', fmtNum(totalBadges));
  st('#games-crumb', `${rows.length} accounts played`);
  if (!Object.keys(gamesCache.accounts).length) { listEl.innerHTML = '<div class="ck-empty">Not scanned yet — click <b>Scan accounts</b>.</div>'; return; }
  if (!rows.length) { listEl.innerHTML = '<div class="ck-empty">None of your scanned accounts have played this game (via badges or recently-played).</div>'; return; }
  listEl.innerHTML = rows.map((r) => `
    <div class="games-row" data-id="${r.id}">
      <div class="avi-lg" style="${r.acc ? avatarStyle(r.acc) : ''}">${r.acc ? avatarInner(r.acc) : ''}</div>
      <span class="games-nm">${esc(r.pseudo)}</span>
      <span class="games-badges">${r.badges ? r.badges + ' badge' + (r.badges === 1 ? '' : 's') : '—'}</span>
      <span class="games-when" data-presence="${r.id}">tap to check</span>
      <div class="games-src">${r.recent ? '<span class="g-chip recent">recent</span>' : ''}${r.badges ? '<span class="g-chip">badge</span>' : ''}</div>
    </div>`).join('');
  listEl.querySelectorAll('.games-row').forEach((row) => row.addEventListener('click', () => openModal(row.dataset.id)));
  // live presence for each shown account (are they in THIS game right now?)
  st('#games-stat-now', 0);
  let now = 0;
  rows.forEach(async (r) => {
    if (!r.acc || !r.acc.cookie) return;
    try {
      const p = await window.api.presence({ userId: r.acc.userId, cookie: r.acc.cookie });
      const cell = listEl.querySelector(`[data-presence="${r.id}"]`);
      if (p && p.ok) {
        const inThis = p.type === 2 && String(p.universeId || '') === uid;
        if (inThis) { now++; st('#games-stat-now', now); }
        if (cell) cell.textContent = p.type === 2 ? (inThis ? 'in this game' : 'in another game') : (p.type === 1 ? 'online' : (p.type === 3 ? 'in studio' : 'offline'));
        const srcEl = listEl.querySelector(`.games-row[data-id="${r.id}"] .games-src`);
        if (inThis && srcEl && !srcEl.querySelector('.now')) srcEl.insertAdjacentHTML('afterbegin', '<span class="g-chip now">now</span>');
      }
    } catch { /* ignore */ }
  });
}

// ============================ SETTINGS ======================================
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

function updateGenKeyLabel() {
  const el = $('#gen-key .select-value'); if (!el) return;
  const keys = keyList();
  if (!keys.length) { genKeyId = '__all__'; el.textContent = 'No API key'; return; }
  if (genKeyId !== '__all__' && !keys.find((k) => k.id === genKeyId)) genKeyId = '__all__';
  const k = keys.find((x) => x.id === genKeyId);
  el.textContent = genKeyId === '__all__' ? 'All keys (rotate)' : (k ? (k.label || k.key.slice(0, 12) + '…') : 'All keys (rotate)');
}

function renderKeys() {
  const list = $('#keys-list'); if (!list) return;
  const keys = settings.bloxgenKeys || [];
  if (!keys.length) { list.innerHTML = '<div class="keys-empty">No keys yet — add one to generate accounts.</div>'; return; }
  list.innerHTML = keys.map((k) => `
    <div class="key-row" data-kid="${k.id}">
      <input class="set-input k-label" data-f="label" value="${escAttr(k.label || '')}" placeholder="Label" />
      <input class="set-input k-key mono" data-f="key" type="password" value="${escAttr(k.key || '')}" placeholder="API key (server)" />
      <span class="key-bal" data-bal>—</span>
      <div class="key-del" data-del>${TRASH_SVG}</div>
    </div>`).join('');
  list.querySelectorAll('.key-row').forEach((row) => {
    const kid = row.dataset.kid;
    row.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => {
      const k = settings.bloxgenKeys.find((x) => x.id === kid); if (!k) return;
      k[inp.dataset.f] = inp.value; saveSettings(); updateGenKeyLabel();
    }));
    row.querySelector('[data-del]').addEventListener('click', () => {
      settings.bloxgenKeys = settings.bloxgenKeys.filter((x) => x.id !== kid);
      saveSettings(); renderKeys(); updateGenKeyLabel();
    });
    const k = settings.bloxgenKeys.find((x) => x.id === kid);
    if (k && k.key && k.key.trim()) {
      window.api.bloxgenBalance(k.key).then((r) => {
        const el = row.querySelector('[data-bal]'); if (!el) return;
        if (r && r.ok) { el.textContent = Number(r.balance).toLocaleString('en-US') + ' cr'; el.classList.remove('err'); }
        else { el.textContent = 'invalid'; el.classList.add('err'); }
      }).catch(() => {});
    }
  });
}

async function renderSecurity() {
  const area = $('#set-sec-area'); if (!area) return;
  let st; try { st = await window.api.secureStatus(); } catch { st = {}; }
  if (st && st.encEnabled) {
    area.innerHTML = '<div class="sec-on"><span class="sec-badge">🔒 Master password is on</span><div class="set-btn danger" id="sec-remove"><span>Remove</span></div></div>';
    $('#sec-remove').addEventListener('click', async () => {
      const r = await window.api.removeMasterPassword(accounts);
      if (r && r.ok) { toast('Master password removed'); renderSecurity(); } else toast('Failed: ' + ((r && r.error) || ''));
    });
  } else {
    area.innerHTML = '<div class="sec-form"><input class="set-input" id="sec-pw" type="password" placeholder="New master password (min 4)" style="flex:1 1 0" /><div class="set-btn primary" id="sec-set"><span>Set password</span></div></div>';
    $('#sec-set').addEventListener('click', async () => {
      const pw = $('#sec-pw').value;
      const r = await window.api.setMasterPassword(pw, accounts);
      if (r && r.ok) { toast('Master password set'); renderSecurity(); } else toast('Failed: ' + ((r && r.error) || 'error'));
    });
  }
}

function renderSettings() {
  renderKeys();
  renderSecurity();
  const th = THEME_IDS.includes(settings.theme) ? settings.theme : 'dark';
  $$('#theme-seg .theme-opt').forEach((o) => o.classList.toggle('active', o.dataset.theme === th));
  setSwitch($('#set-autofetch'), settings.autoFetch !== false);
  setSwitch($('#set-confirm'), settings.confirmDelete !== false);
  setSwitch($('#set-casemode'), !!settings.caseMode);
  setSwitch($('#set-autopw'), !!settings.autoChangePw);
  if ($('#set-pwprefix')) $('#set-pwprefix').value = settings.pwPrefix || '';
  if ($('#set-pwlen')) $('#set-pwlen').value = settings.pwLength || 16;
  setSwitch($('#set-autobackup'), !!settings.autoBackup);
  window.api.version().then((v) => { const el = $('#set-version'); if (el) el.textContent = ''; }).catch(() => {});
}

function applyTheme(theme) {
  const t = THEME_IDS.includes(theme) ? theme : 'dark';
  if (t === 'dark') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  settings.theme = t; saveSettings();
  $$('#theme-seg .theme-opt').forEach((o) => o.classList.toggle('active', o.dataset.theme === t));
  try { window.api.setTheme(t); } catch {}
}
$$('#theme-seg .theme-opt').forEach((o) => o.addEventListener('click', () => applyTheme(o.dataset.theme)));

// Collapse the sidebar to an icon rail (button under Daily quotas)
function applySidebarCollapsed() {
  const sb = document.querySelector('.sidebar'); if (!sb) return;
  sb.classList.toggle('collapsed', false); // collapse disabled
  const b = $('#side-collapse'); if (b) b.title = settings.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
}
$('#side-collapse')?.addEventListener('click', () => {
  settings.sidebarCollapsed = !settings.sidebarCollapsed;
  saveSettings(); applySidebarCollapsed();
});
applySidebarCollapsed();

// Collapsed rail: hover the mini gauge to preview Daily quotas in a flyout (portaled to body
// so the sidebar's overflow:hidden doesn't clip it).
let quotaPop = null;
function openQuotaPop() {
  if (quotaPop) return;
  const mini = $('#quota-mini'); if (!mini) return;
  const pop = document.createElement('div');
  pop.className = 'quota-pop';
  pop.innerHTML = '<span class="quota-label">DAILY QUOTAS</span><div class="quota-rows">' + (($('#quota-rows') && $('#quota-rows').innerHTML) || '') + '</div>';
  document.body.appendChild(pop);
  const r = mini.getBoundingClientRect();
  pop.style.left = (r.right + 8) + 'px';
  pop.style.top = Math.max(8, Math.min(window.innerHeight - pop.offsetHeight - 8, r.top + r.height / 2 - pop.offsetHeight / 2)) + 'px';
  quotaPop = pop;
}
function closeQuotaPop() { if (quotaPop) { quotaPop.remove(); quotaPop = null; } }
$('#quota-mini')?.addEventListener('mouseenter', openQuotaPop);
$('#quota-mini')?.addEventListener('mouseleave', closeQuotaPop);

// Collapsed rail: floating tooltip with the screen name on hover (portaled to body).
let railTip = null;
function hideRailTip() { if (railTip) { railTip.remove(); railTip = null; } }
function showRailTip(item, text) {
  const sb = document.querySelector('.sidebar');
  if (!sb || !sb.classList.contains('collapsed') || !text) return;
  hideRailTip();
  const tip = document.createElement('div');
  tip.className = 'rail-tip'; tip.textContent = text;
  document.body.appendChild(tip);
  const r = item.getBoundingClientRect();
  tip.style.left = (r.right + 10) + 'px';
  tip.style.top = Math.max(6, r.top + r.height / 2 - tip.offsetHeight / 2) + 'px';
  railTip = tip;
}
$$('.sidebar .nav-item').forEach((it) => {
  const lbl = it.querySelector('.nav-label');
  const soon = it.querySelector('.nav-soon');
  const text = lbl ? lbl.textContent + (soon ? ' · soon' : '') : '';
  it.addEventListener('mouseenter', () => showRailTip(it, text));
  it.addEventListener('mouseleave', hideRailTip);
  it.addEventListener('click', hideRailTip);
});

// ---- Cookie keep-alive scheduler -------------------------------------------
const KA_OPTS = [{ v: 30, l: 'every 30 min' }, { v: 60, l: 'every 1h' }, { v: 180, l: 'every 3h' }, { v: 360, l: 'every 6h' }, { v: 720, l: 'every 12h' }];
let keepAliveTimer = null, keepAliveRunning = false;
function kaMinutes() { return [30, 60, 180, 360, 720].includes(settings.keepAliveMin) ? settings.keepAliveMin : 180; }
function kaLabel() { const o = KA_OPTS.find((x) => x.v === kaMinutes()); return o ? o.l : ('every ' + kaMinutes() + ' min'); }
function refreshKeepAliveUI() {
  const sw = $('#set-keepalive'); if (sw) setSwitch(sw, !!settings.keepAliveEnabled);
  const lbl = $('#set-keepalive-lbl'); if (lbl) lbl.textContent = kaLabel();
  const last = $('#set-keepalive-last'); if (last) last.textContent = settings.keepAliveLast ? timeAgo(settings.keepAliveLast) : 'never';
}
async function runKeepAlive() {
  if (keepAliveRunning) return;
  const targets = accounts.filter((a) => a.cookie && a.cookieValid !== false);
  if (!targets.length) { toast('Keep-alive: no cookies to refresh'); return; }
  keepAliveRunning = true;
  let ok = 0;
  await runPool(targets, 4, async (a) => { if (await refreshOneCookie(a)) ok++; });
  settings.keepAliveLast = new Date().toISOString(); saveSettings();
  save(); renderCookies(); renderAccounts(); refreshKeepAliveUI();
  keepAliveRunning = false;
  toast(`Keep-alive: refreshed ${ok}/${targets.length} cookie${targets.length === 1 ? '' : 's'}`);
}
function startKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  if (settings.keepAliveEnabled) keepAliveTimer = setInterval(runKeepAlive, kaMinutes() * 60 * 1000);
}
$('#set-keepalive')?.addEventListener('click', () => {
  settings.keepAliveEnabled = !settings.keepAliveEnabled; saveSettings();
  refreshKeepAliveUI(); startKeepAlive();
  if (settings.keepAliveEnabled) toast('Keep-alive on · ' + kaLabel());
});
$('#set-keepalive-int')?.addEventListener('click', () => {
  openDropdown($('#set-keepalive-int'), KA_OPTS.map((o) => ({ value: String(o.v), label: o.l })), String(kaMinutes()), (v) => {
    settings.keepAliveMin = Number(v) || 180; saveSettings(); refreshKeepAliveUI(); startKeepAlive();
  });
});
$('#set-keepalive-now')?.addEventListener('click', () => runKeepAlive());
refreshKeepAliveUI();
startKeepAlive();

// Settings sub-tabs
$$('.set-nav-item').forEach((n) => n.addEventListener('click', () => {
  const t = n.dataset.set;
  $$('.set-nav-item').forEach((x) => x.classList.toggle('active', x === n));
  $$('.set-pane').forEach((p) => { p.hidden = p.dataset.set !== t; });
}));

$('#key-add')?.addEventListener('click', () => { settings.bloxgenKeys.push({ id: crypto.randomUUID(), label: '', key: '' }); saveSettings(); renderKeys(); });
$('#set-autofetch')?.addEventListener('click', () => { settings.autoFetch = !(settings.autoFetch !== false); setSwitch($('#set-autofetch'), settings.autoFetch); saveSettings(); });
$('#set-confirm')?.addEventListener('click', () => { settings.confirmDelete = !(settings.confirmDelete !== false); setSwitch($('#set-confirm'), settings.confirmDelete); saveSettings(); });
$('#set-casemode')?.addEventListener('click', () => { settings.caseMode = !settings.caseMode; setSwitch($('#set-casemode'), settings.caseMode); saveSettings(); });
$('#set-autopw')?.addEventListener('click', () => { if (!requireCollab('Password settings')) return; settings.autoChangePw = !settings.autoChangePw; setSwitch($('#set-autopw'), settings.autoChangePw); saveSettings(); });
$('#set-pwprefix')?.addEventListener('input', (e) => { settings.pwPrefix = e.target.value; saveSettings(); });
$('#set-pwlen')?.addEventListener('input', (e) => { settings.pwLength = Math.max(8, Math.min(50, Number(e.target.value) || 16)); saveSettings(); });
// Preview the case animation with a fake account (random rarity) — no generation needed.
$('#set-case-test')?.addEventListener('click', () => {
  const fake = { id: '__preview__', pseudo: 'PreviewUser' + Math.floor(Math.random() * 9000 + 1000), avatarUrl: null };
  const roll = Math.random();
  if (roll < 0.4) { /* common */ }
  else if (roll < 0.65) fake.voiceChat = true;
  else if (roll < 0.85) fake.ageVerified = true;
  else fake.robux = Math.floor(Math.random() * 5000 + 1);
  playCase(fake, rarityOf(fake));
});
$('#set-autobackup')?.addEventListener('click', () => { settings.autoBackup = !settings.autoBackup; setSwitch($('#set-autobackup'), settings.autoBackup); saveSettings(); window.api.setConfig({ autoBackup: settings.autoBackup }); });
$('#set-openfolder')?.addEventListener('click', () => window.api.openDataFolder());
$('#set-export')?.addEventListener('click', () => window.api.export(accounts).then((r) => { if (r && r.ok) toast('Exported'); }));
$('#set-import')?.addEventListener('click', async () => {
  const r = await window.api.importTxt(); if (!r || !r.ok) return;
  let added = 0;
  for (const raw of (r.text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const i = line.indexOf(':');
    const u = i >= 0 ? line.slice(0, i).trim() : line;
    const p = i >= 0 ? line.slice(i + 1).trim() : '';
    if (!u) continue;
    accounts.unshift(normalize({ pseudo: u, password: p })); added++;
  }
  if (added) { save(); renderAccounts(); renderHistory(); autoEnrich(); toast('Imported ' + added + ' account' + (added === 1 ? '' : 's')); }
});
$('#set-logoutall')?.addEventListener('click', async () => {
  const r = await window.api.confirm('Log out all Roblox sessions? Stored cookies are kept.', ['Log out', 'Cancel']);
  if (r !== 0) return;
  const n = await window.api.logoutAll(accounts.map((a) => a.id));
  toast('Logged out ' + n + ' session' + (n === 1 ? '' : 's'));
});
$('#set-update')?.addEventListener('click', () => { window.api.updateCheck(); toast('Checking for updates…'); });
window.api.onUpdateAvailable && window.api.onUpdateAvailable((d) => toast('Update available: v' + d.version));
window.api.onUpdateNone && window.api.onUpdateNone(() => toast('You are up to date'));
window.api.onUpdateDownloaded && window.api.onUpdateDownloaded(() => toast('Update ready — restart to install'));
window.api.onUpdateError && window.api.onUpdateError(() => toast('Update error'));

// ============================ BOOT ==========================================
function normalizeLoadResult(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.accounts)) return res.accounts;
  return [];
}
async function boot() {
  window.__authToken = localStorage.getItem('ogalts_token') || '';
  window.__staffToken = localStorage.getItem('ogalts_staff_token') || '';
  if (window.api && window.api.setToken) window.api.setToken(window.__authToken);
  if (window.api && window.api.setStaffToken) window.api.setStaffToken(window.__staffToken);
  let res;
  try { res = await window.api.load(); } catch (e) { toast('Load error: ' + e.message); res = []; }
  if (res && res.locked) { await showUnlock(); return; }
  accounts = normalizeLoadResult(res).map(normalize);
  showScreen('generator');
  renderHistory(); renderQuota();
  if (typeof renderAccounts === 'function') renderAccounts();
  // set initial selector labels
  $('#gen-type .select-value').textContent = TYPE_LABEL[genType];
  const _c = priceStr(genType) || costStr(genType);
  $('#gen-meta-right').textContent = '';
  const badge = document.getElementById('gen-cost-badge');
  if (badge) badge.textContent = _c;
  if (keyList().length) $('#gen-key .select-value').textContent = 'All keys (rotate)';
  else $('#gen-key .select-value').textContent = 'No API key';
  const last = accounts.find(isBloxgen);
  if (last) showDetailFromAccount(last, false);
  try { window.api.setTheme(THEME_IDS.includes(settings.theme) ? settings.theme : 'dark'); } catch {}
  autoEnrich();
  checkWhatsNew();
}

// Minimal unlock overlay for master-password-protected data
function showUnlock() {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'scrim';
    ov.innerHTML = `<div style="width:340px;background:var(--a-surface);border-radius:16px;outline:1px solid var(--a-line);padding:24px;display:flex;flex-direction:column;gap:14px">
      <div style="font-size:16px;font-weight:600;color:var(--a-text)">Unlock ogalts</div>
      <div style="font-family:var(--a-font-mono);font-size:11px;color:var(--a-text-3)">Master password required</div>
      <input id="unlock-pw" type="password" placeholder="Password" style="height:40px;padding:0 12px;border-radius:8px;background:var(--a-surface-2);border:1px solid var(--a-line);color:var(--a-text);font-family:var(--a-font-ui);font-size:13px;outline:none" />
      <div id="unlock-err" style="font-size:11px;color:var(--a-danger);min-height:14px"></div>
      <div class="btn-save" id="unlock-go" style="justify-content:center"><span>Unlock</span></div>
    </div>`;
    document.body.appendChild(ov);
    const pw = ov.querySelector('#unlock-pw');
    pw.focus();
    async function tryUnlock() {
      const r = await window.api.unlock(pw.value);
      if (r && r.ok) { accounts = (r.accounts || []).map(normalize); ov.remove(); showScreen('generator'); renderHistory(); renderQuota(); $('#gen-type .select-value').textContent = TYPE_LABEL[genType]; autoEnrich(); resolve(); }
      else { ov.querySelector('#unlock-err').textContent = 'Wrong password'; pw.value = ''; pw.focus(); }
    }
    ov.querySelector('#unlock-go').addEventListener('click', tryUnlock);
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  });
}

boot();


/* Import account modal → Cookies */
document.getElementById('bg-goto-cookies')?.addEventListener('click', () => {
  const scrim = document.getElementById('bg-import-scrim');
  if (scrim) scrim.hidden = true;
  document.querySelector('.nav-item[data-screen="cookies"]')?.click();
  setTimeout(() => document.getElementById('ck-import-open')?.click(), 200);
});


/* ===== Auth / Staff / Google ===== */
window.__pendingGoogleCred = null;

async function refreshAuthUI() {
  const token = localStorage.getItem('ogalts_token');
  window.api.setToken(token || '');
  const out = document.getElementById('auth-logged-out');
  const inn = document.getElementById('auth-logged-in');
  if (!token) {
    if (out) out.style.display = '';
    if (inn) inn.style.display = 'none';
    return;
  }
  try {
    const me = await window.api.authMe();
    if (!me || !me.ok) {
      window.api.setToken('');
      if (out) out.style.display = '';
      if (inn) inn.style.display = 'none';
      return;
    }
    if (me.staff) {
      if (out) out.style.display = 'none';
      if (inn) inn.style.display = '';
      const lab = document.getElementById('auth-username-label');
      if (lab) lab.textContent = 'Staff: ' + (me.username || '');
      const bal = document.getElementById('auth-balance');
      if (bal) bal.textContent = '—';
      const sp = document.getElementById('sup-staff-panel');
      if (sp) sp.style.display = '';
      return;
    }
    if (out) out.style.display = 'none';
    if (inn) inn.style.display = '';
    const u = me.user || {};
    window.__userCollabPlan = u.collabPlan || null;
    const pwLock = document.getElementById('pw-collab-lock');
    if (pwLock) pwLock.style.display = window.__userCollabPlan ? 'none' : '';
    const pwPane = document.querySelector('.set-pane[data-set="password"]');
    if (pwPane) {
      pwPane.querySelectorAll('.set-btn, .switch, input').forEach((el) => {
        if (window.__userCollabPlan) { el.style.opacity = ''; el.style.pointerEvents = ''; }
        else { el.style.opacity = '0.45'; el.style.pointerEvents = 'none'; }
      });
    }
    const lab = document.getElementById('auth-username-label');
    if (lab) lab.textContent = u.username || 'user';
    const bal = document.getElementById('auth-balance');
    if (bal) bal.textContent = (Number(u.balance) || 0).toFixed(3);
    // reload accounts for this user
    if (typeof loadAccounts === 'function') {
      try { await loadAccounts(); } catch (_) {}
    } else if (window.api && window.api.load) {
      try {
        const list = normalizeLoadResult(await window.api.load());
        accounts = list.map(normalize);
        if (typeof renderAccounts === 'function') renderAccounts();
        if (typeof renderHistory === 'function') renderHistory();
      } catch (_) {}
    }
  } catch (_) {}
}

async function finishGoogleLogin(credential, username) {
  const r = await window.api.authGoogle(credential, username);
  if (r && r.needUsername) {
    window.__pendingGoogleCred = credential;
    const box = document.getElementById('username-pick');
    if (box) box.style.display = '';
    if (typeof toast === 'function') toast('Choose a username to continue');
    return;
  }
  if (!r || !r.ok) {
    if (typeof toast === 'function') toast((r && r.error) || 'Google login failed');
    return;
  }
  window.api.setToken(r.token);
  window.__pendingGoogleCred = null;
  const box = document.getElementById('username-pick');
  if (box) box.style.display = 'none';
  await refreshAuthUI();
  if (typeof toast === 'function') toast('Signed in as ' + (r.user && r.user.username));
  location.reload();
}

async function initGoogleBtn() {
  try {
    const cfg = await fetch('/api/config/public').then((r) => r.json());
    if (cfg && cfg.googleClientId) window.GOOGLE_CLIENT_ID = cfg.googleClientId;
  } catch (_) {}
  const clientId = window.GOOGLE_CLIENT_ID || '';
  if (!clientId || !window.google || !google.accounts) return;
  const slot = document.getElementById('google-btn-slot');
  if (!slot) return;
  google.accounts.id.initialize({
    client_id: clientId,
    callback: (resp) => finishGoogleLogin(resp.credential),
  });
  google.accounts.id.renderButton(slot, { theme: 'outline', size: 'medium', width: 220 });
}

document.getElementById('auth-username-go')?.addEventListener('click', () => {
  const u = document.getElementById('auth-username')?.value || '';
  if (!window.__pendingGoogleCred) return;
  finishGoogleLogin(window.__pendingGoogleCred, u.trim());
});
document.getElementById('auth-logout')?.addEventListener('click', () => {
  window.api.setToken('');
  location.reload();
});
document.getElementById('sup-staff-login')?.addEventListener('click', () => {
  const s = document.getElementById('staff-scrim');
  if (s) s.hidden = false;
});
document.getElementById('staff-close')?.addEventListener('click', () => {
  const s = document.getElementById('staff-scrim');
  if (s) s.hidden = true;
});
document.getElementById('staff-go')?.addEventListener('click', async () => {
  const username = document.getElementById('staff-user')?.value || '';
  const password = document.getElementById('staff-pass')?.value || '';
  const r = await window.api.authStaff(username, password);
  if (!r || !r.ok) {
    if (typeof toast === 'function') toast((r && r.error) || 'Staff login failed');
    return;
  }
  window.api.setStaffToken(r.token);
  document.getElementById('staff-scrim').hidden = true;
  document.getElementById('sup-staff-panel').style.display = '';
  if (typeof toast === 'function') toast('Staff logged in');
  await refreshAuthUI();
});
document.getElementById('sup-staff-panel')?.addEventListener('click', async () => {
  const s = document.getElementById('staff-panel-scrim');
  if (s) s.hidden = false;
  const list = document.getElementById('staff-user-list');
  const r = await window.api.staffUsers();
  if (list && r && r.ok) {
    list.innerHTML = (r.users || []).map((u) =>
      `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <span>${u.username}</span><span>£${(Number(u.balance)||0).toFixed(3)}</span></div>`
    ).join('') || '<div>No users yet</div>';
  }
});
document.getElementById('staff-panel-close')?.addEventListener('click', () => {
  document.getElementById('staff-panel-scrim').hidden = true;
});
document.getElementById('staff-bal-go')?.addEventListener('click', async () => {
  const username = document.getElementById('staff-bal-user')?.value || '';
  const amount = parseFloat(document.getElementById('staff-bal-amt')?.value || '');
  const r = await window.api.staffBalance({ username, amount });
  if (!r || !r.ok) {
    if (typeof toast === 'function') toast((r && r.error) || 'Failed');
    return;
  }
  if (typeof toast === 'function') toast(username + ' balance: £' + Number(r.balance).toFixed(3));
  document.getElementById('sup-staff-panel')?.click();
});

window.addEventListener('load', () => {
  setTimeout(initGoogleBtn, 800);
  setTimeout(refreshAuthUI, 500);
});


/* Staff modal close — works when clicking X or SVG */
document.getElementById('staff-scrim')?.addEventListener('click', (e) => {
  if (e.target.id === 'staff-scrim' || e.target.closest('#staff-close')) {
    document.getElementById('staff-scrim').hidden = true;
  }
});
document.getElementById('staff-panel-scrim')?.addEventListener('click', (e) => {
  if (e.target.id === 'staff-panel-scrim' || e.target.closest('#staff-panel-close')) {
    document.getElementById('staff-panel-scrim').hidden = true;
  }
});
document.getElementById('collab-buy-scrim')?.addEventListener('click', (e) => {
  if (e.target.id === 'collab-buy-scrim' || e.target.closest('#collab-buy-close')) {
    document.getElementById('collab-buy-scrim').hidden = true;
  }
});

document.querySelectorAll('.collab-buy').forEach((btn) => {
  btn.addEventListener('click', () => {
    const plan = btn.getAttribute('data-plan');
    const labels = { basic: 'Basic (£5)', premium: 'Premium (£10)', elite: 'Elite (£18)' };
    const desc = document.getElementById('collab-buy-desc');
    if (desc) desc.textContent = 'To buy ' + (labels[plan] || plan) + ', join the support Discord and open a ticket. Staff will activate your plan after payment.';
    const s = document.getElementById('collab-buy-scrim');
    if (s) s.hidden = false;
  });
});

async function openDiscordInvite() {
  try {
    const cfg = await fetch('/api/config/public').then((r) => r.json());
    const url = (cfg && cfg.discordInvite) || '';
    if (!url) { if (typeof toast === 'function') toast('Discord invite not configured'); return; }
    window.open(url, '_blank');
  } catch (_) {
    if (typeof toast === 'function') toast('Could not load Discord link');
  }
}
document.getElementById('discord-join-btn')?.addEventListener('click', openDiscordInvite);
document.getElementById('collab-buy-discord')?.addEventListener('click', openDiscordInvite);


document.getElementById('staff-collab-go')?.addEventListener('click', async () => {
  const username = document.getElementById('staff-collab-user')?.value || '';
  const plan = document.getElementById('staff-collab-plan')?.value || '';
  const r = await window.api.staffCollab({ username: username.trim(), plan: plan || null });
  if (!r || !r.ok) { if (typeof toast === 'function') toast((r && r.error) || 'Failed'); return; }
  if (typeof toast === 'function') toast('Plan set: ' + (r.collabPlan || 'none') + (r.referralCode ? (' code ' + r.referralCode) : ''));
});




async function renderEarnServers() {
  const box = document.getElementById('earn-servers');
  if (!box) return;
  const signedIn = !!(window.__authToken || localStorage.getItem('ogalts_token'));
  try {
    const cfg = await fetch('/api/config/public').then((r) => r.json());
    const servers = (cfg && cfg.collabServers) || [];
    if (!servers.length) {
      box.innerHTML = '<div class="set-desc">No Discord servers listed yet. Collab owners get their server featured here.</div>';
      return;
    }
    box.innerHTML = servers.map((s) => {
      const earn = Number(s.earn) || 0.1;
      const letter = String(s.label || 'D').trim().charAt(0).toUpperCase();
      const inv = (s.invite || '').replace(/"/g, '');
      return `<div class="earn-dc-card" data-sid="${s.id}">
        <div class="earn-dc-icon">${letter}</div>
        <div class="earn-dc-body">
          <div class="earn-dc-name">${(s.label || 'Discord').replace(/</g, '')}</div>
          <div class="earn-dc-earn">Earn £${earn.toFixed(2)} for joining</div>
        </div>
        <button type="button" class="earn-dc-join" data-invite="${inv}" data-earn-id="${s.id}" data-earn-amt="${earn}">JOIN</button>
      </div>`;
    }).join('');
    box.querySelectorAll('.earn-dc-join').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const token = window.__authToken || localStorage.getItem('ogalts_token') || '';
        if (!token) {
          if (typeof toast === 'function') toast('Sign in with Google first');
          return;
        }
        const invite = btn.getAttribute('data-invite') || '';
        const id = btn.getAttribute('data-earn-id');
        btn.disabled = true;
        btn.textContent = '…';
        try {
          // 1) Already verified in server → pay
          let r = await window.api.earnDiscordCheck({ serverId: id });
          if (r && r.ok) {
            if (typeof toast === 'function') toast('+£' + Number(r.credited).toFixed(3) + ' balance');
            const bal = document.getElementById('auth-balance');
            if (bal) bal.textContent = Number(r.balance).toFixed(3);
            btn.textContent = 'CLAIMED';
            return;
          }
          if (r && r.error && /already claimed/i.test(r.error)) {
            if (typeof toast === 'function') toast(r.error);
            btn.textContent = 'CLAIMED';
            return;
          }
          // 2) Need Discord OAuth only (do NOT open invite at the same time)
          if (r && r.needDiscord) {
            if (typeof toast === 'function') toast('Opening Discord to verify you are in the server…');
            window.location.href =
              '/api/auth/discord/start?serverId=' + encodeURIComponent(id) +
              '&token=' + encodeURIComponent(token);
            return;
          }
          if (typeof toast === 'function') toast((r && r.error) || 'Could not claim');
          btn.disabled = false;
          btn.textContent = 'JOIN';
        } catch (e) {
          if (typeof toast === 'function') toast(String(e.message || e));
          btn.disabled = false;
          btn.textContent = 'JOIN';
        }
      });
    });
  } catch (e) {
    box.innerHTML = '<div class="set-desc">Could not load servers</div>';
  }
}

// Handle return from Discord OAuth (?earn=ok|error|not_in_server)
(function handleEarnQuery() {
  try {
    const q = new URLSearchParams(location.search);
    const earn = q.get('earn');
    if (!earn) return;
    if (earn === 'ok') {
      const amount = q.get('amount');
      const balance = q.get('balance');
      if (typeof toast === 'function') toast('Discord verified — +£' + Number(amount || 0).toFixed(3));
      const bal = document.getElementById('auth-balance');
      if (bal && balance != null) bal.textContent = Number(balance).toFixed(3);
    } else if (earn === 'not_in_server') {
      const inv = q.get('invite');
      const sid = q.get('serverId') || '';
      if (typeof toast === 'function') {
        toast('Not in that server yet. Join Discord, then press JOIN again to claim.');
      }
      // Only open invite — user verifies again with JOIN after joining
      if (inv) {
        setTimeout(() => window.open(decodeURIComponent(inv), '_blank'), 600);
      }
      try { sessionStorage.setItem('earn_pending_server', sid); } catch (_) {}
    } else if (earn === 'linked') {
      if (typeof toast === 'function') toast('Discord linked');
    } else if (earn === 'error') {
      if (typeof toast === 'function') toast(q.get('msg') || 'Earn failed');
    }
    // clean URL
    history.replaceState({}, '', location.pathname);
    setTimeout(() => {
      document.querySelector('.nav-item[data-screen="earn"]')?.click();
    }, 400);
  } catch (_) {}
})();

document.querySelector('.nav-item[data-screen="earn"]')?.addEventListener('click', () => setTimeout(renderEarnServers, 100));





/* ===== Staff / Collab modals — fixed open & close (hidden attr only) ===== */
(function staffModalsFix() {
  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = false;
    el.removeAttribute('hidden');
    // clear any leftover inline display from older builds
    el.style.display = '';
    el.style.removeProperty('display');
  }
  function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = true;
    el.setAttribute('hidden', '');
    el.style.removeProperty('display');
  }
  window.openStaffLogin = () => openModal('staff-scrim');
  window.closeStaffLogin = () => closeModal('staff-scrim');
  window.openStaffPanel = () => openModal('staff-panel-scrim');
  window.closeStaffPanel = () => closeModal('staff-panel-scrim');
  window.openCollabBuy = () => openModal('collab-buy-scrim');
  window.closeCollabBuy = () => closeModal('collab-buy-scrim');

  // Open Staff login (Support → Staff login)
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('#sup-staff-login');
    if (t) {
      e.preventDefault();
      e.stopPropagation();
      openModal('staff-scrim');
    }
  }, true);

  // Open staff panel
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('#sup-staff-panel');
    if (t) {
      e.preventDefault();
      openModal('staff-panel-scrim');
    }
  }, true);

  // Close buttons + backdrop (delegation)
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#staff-close')) {
      e.preventDefault();
      e.stopPropagation();
      closeModal('staff-scrim');
      return;
    }
    if (e.target.closest && e.target.closest('#staff-panel-close')) {
      e.preventDefault();
      e.stopPropagation();
      closeModal('staff-panel-scrim');
      return;
    }
    if (e.target.closest && e.target.closest('#collab-buy-close')) {
      e.preventDefault();
      e.stopPropagation();
      closeModal('collab-buy-scrim');
      return;
    }
    // backdrop click
    if (e.target && e.target.id === 'staff-scrim') closeModal('staff-scrim');
    if (e.target && e.target.id === 'staff-panel-scrim') closeModal('staff-panel-scrim');
    if (e.target && e.target.id === 'collab-buy-scrim') closeModal('collab-buy-scrim');
  }, true);

  // Staff LOGIN button
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('#staff-go');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const username = (document.getElementById('staff-user') && document.getElementById('staff-user').value || '').trim();
    const password = (document.getElementById('staff-pass') && document.getElementById('staff-pass').value) || '';
    if (!username || !password) {
      if (typeof toast === 'function') toast('Enter username and password');
      else alert('Enter username and password');
      return;
    }
    if (!window.api || !window.api.authStaff) {
      alert('API not loaded');
      return;
    }
    btn.style.opacity = '0.6';
    try {
      const r = await window.api.authStaff(username, password);
      if (!r || !r.ok) {
        if (typeof toast === 'function') toast((r && r.error) || 'Staff login failed');
        else alert((r && r.error) || 'Staff login failed');
        return;
      }
      window.api.setStaffToken(r.token);
      closeModal('staff-scrim');
      const panelBtn = document.getElementById('sup-staff-panel');
      if (panelBtn) panelBtn.style.display = '';
      if (typeof toast === 'function') toast('Staff logged in');
      openModal('staff-panel-scrim');
      // load users list
      try {
        const list = document.getElementById('staff-user-list');
        const users = await window.api.staffUsers();
        if (list && users && users.ok) {
          list.innerHTML = (users.users || []).map((u) =>
            '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)">' +
            '<span>' + (u.username || '') + '</span><span>£' + (Number(u.balance) || 0).toFixed(3) + '</span></div>'
          ).join('') || '<div>No users yet</div>';
        }
      } catch (_) {}
    } catch (err) {
      if (typeof toast === 'function') toast(String(err.message || err));
      else alert(String(err.message || err));
    } finally {
      btn.style.opacity = '';
    }
  }, true);

  // Collab buy open
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.collab-buy');
    if (!btn) return;
    const plan = btn.getAttribute('data-plan');
    const labels = { basic: 'Basic (£5)', premium: 'Premium (£10)', elite: 'Elite (£18)' };
    const desc = document.getElementById('collab-buy-desc');
    if (desc) {
      desc.textContent = 'To buy ' + (labels[plan] || plan) + ' for your Discord server: join support Discord, open a ticket, and staff will activate your plan after payment.';
    }
    openModal('collab-buy-scrim');
  }, true);
})();


/* Staff balance + collab — document capture so buttons work even if HTML was after scripts */
document.addEventListener('click', async (e) => {
  const balBtn = e.target.closest && e.target.closest('#staff-bal-go');
  if (balBtn) {
    e.preventDefault();
    e.stopPropagation();
    const username = ((document.getElementById('staff-bal-user') || {}).value || '').trim();
    const amountRaw = ((document.getElementById('staff-bal-amt') || {}).value || '').trim();
    const amount = parseFloat(amountRaw);
    if (!username) {
      if (typeof toast === 'function') toast('Enter username');
      return;
    }
    if (!Number.isFinite(amount)) {
      if (typeof toast === 'function') toast('Enter a valid amount (e.g. 0.5 or 5)');
      return;
    }
    if (!window.api || !window.api.staffBalance) {
      alert('API missing');
      return;
    }
    balBtn.style.opacity = '0.6';
    try {
      const r = await window.api.staffBalance({ username, amount });
      if (!r || !r.ok) {
        if (typeof toast === 'function') toast((r && r.error) || 'Failed to update balance');
        else alert((r && r.error) || 'Failed');
        return;
      }
      if (typeof toast === 'function') toast(username + ' → £' + Number(r.balance).toFixed(3));
      // refresh list
      try {
        const list = document.getElementById('staff-user-list');
        const users = await window.api.staffUsers();
        if (list && users && users.ok) {
          list.innerHTML = (users.users || []).map((u) =>
            '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)">' +
            '<span>' + (u.username || '') + '</span><span>£' + (Number(u.balance) || 0).toFixed(3) + '</span></div>'
          ).join('') || '<div>No users yet</div>';
        }
      } catch (_) {}
    } catch (err) {
      if (typeof toast === 'function') toast(String(err.message || err));
    } finally {
      balBtn.style.opacity = '';
    }
    return;
  }

  const collabBtn = e.target.closest && e.target.closest('#staff-collab-go');
  if (collabBtn) {
    e.preventDefault();
    e.stopPropagation();
    const username = ((document.getElementById('staff-collab-user') || {}).value || '').trim();
    const plan = ((document.getElementById('staff-collab-plan') || {}).value || '');
    if (!username) {
      if (typeof toast === 'function') toast('Enter username');
      return;
    }
    try {
      const r = await window.api.staffCollab({ username, plan: plan || null });
      if (!r || !r.ok) {
        if (typeof toast === 'function') toast((r && r.error) || 'Failed');
        return;
      }
      if (typeof toast === 'function') toast('Plan for ' + username + ': ' + (r.collabPlan || 'none'));
    } catch (err) {
      if (typeof toast === 'function') toast(String(err.message || err));
    }
  }
}, true);


/* ===== Staff panel actions (global — called from onclick) ===== */
window.staffUpdateBalance = async function staffUpdateBalance() {
  const status = document.getElementById('staff-bal-status');
  const setStatus = (msg, ok) => {
    if (status) {
      status.textContent = msg;
      status.style.color = ok ? '#4ADE80' : '#FF5C7A';
    }
    if (typeof toast === 'function') toast(msg);
    else console.log('[staff]', msg);
  };
  const username = ((document.getElementById('staff-bal-user') || {}).value || '').trim();
  const amountRaw = ((document.getElementById('staff-bal-amt') || {}).value || '').trim();
  const amount = parseFloat(amountRaw);
  if (!username) return setStatus('Enter a username');
  if (!Number.isFinite(amount)) return setStatus('Enter a valid amount (e.g. 0.5)');
  if (!window.__staffToken && !localStorage.getItem('ogalts_staff_token')) {
    return setStatus('Staff not logged in — use Staff login first');
  }
  // ensure token loaded
  window.__staffToken = window.__staffToken || localStorage.getItem('ogalts_staff_token') || '';
  try {
    const r = await window.api.staffBalance({ username, amount });
    if (!r || !r.ok) return setStatus((r && r.error) || 'Failed (Forbidden = re-login as staff)');
    setStatus((r.username || username) + ' balance → £' + Number(r.balance).toFixed(3), true);
    // refresh list
    try {
      const list = document.getElementById('staff-user-list');
      const users = await window.api.staffUsers();
      if (list && users && users.ok) {
        list.innerHTML = (users.users || []).map((u) =>
          '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)">' +
          '<span>' + (u.username || '') + '</span><span>£' + (Number(u.balance) || 0).toFixed(3) + '</span></div>'
        ).join('') || '<div>No users yet</div>';
      }
    } catch (_) {}
  } catch (e) {
    setStatus(String(e.message || e));
  }
};

window.staffSetPlan = async function staffSetPlan() {
  const status = document.getElementById('staff-collab-status');
  const setStatus = (msg, ok) => {
    if (status) {
      status.textContent = msg;
      status.style.color = ok ? '#4ADE80' : '#FF5C7A';
    }
    if (typeof toast === 'function') toast(msg);
  };
  const username = ((document.getElementById('staff-collab-user') || {}).value || '').trim();
  const plan = ((document.getElementById('staff-collab-plan') || {}).value || '');
  if (!username) return setStatus('Enter a username');
  window.__staffToken = window.__staffToken || localStorage.getItem('ogalts_staff_token') || '';
  if (!window.__staffToken) return setStatus('Staff not logged in — use Staff login first');
  try {
    const r = await window.api.staffCollab({ username, plan: plan || null });
    if (!r || !r.ok) return setStatus((r && r.error) || 'Failed');
    setStatus((r.username || username) + ' plan → ' + (r.collabPlan || 'none'), true);
  } catch (e) {
    setStatus(String(e.message || e));
  }
};


/* Create loop → coming soon */
document.addEventListener('click', (e) => {
  const t = e.target.closest && (e.target.closest('#btn-loop') || e.target.closest('[data-loop]') || e.target.closest('#gen-loop'));
  if (!t) {
    // text match
    const el = e.target.closest('.tb-btn, .set-btn, .gen-btn, button, .btn');
    if (el && /create\s*loop/i.test(el.textContent || '')) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof toast === 'function') toast('Coming soon');
      return;
    }
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (typeof toast === 'function') toast('Coming soon');
}, true);

document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('#btn-create-loop')) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof toast === 'function') toast('Coming soon');
  }
}, true);


/* ===== Stock page ===== */
const STOCK_LABELS = {
  'alt': 'Standard',
  '+30 days old': 'Aged · 30d+',
  '+1 year old': 'Aged · 1y+',
  '5+ years old': 'Aged · 5y+',
  '18+ age verified': '18+ verified',
  'dump': 'Robux accounts',
};
async function refreshStock() {
  const grid = document.getElementById('stock-grid');
  const st = document.getElementById('stock-status');
  if (!grid) return;
  try {
    const r = await fetch('/api/pool/status').then((x) => x.json());
    const by = (r && r.byType) || {};
    const prices = (window.GEN_UI_PRICE || GEN_UI_PRICE || {});
    grid.innerHTML = Object.keys(STOCK_LABELS).map((t) => {
      const row = by[t] || { have: 0, min: 0 };
      const have = row.have || 0;
      const price = (typeof priceStr === 'function' ? priceStr(t) : '') || '';
      const color = have > 0 ? '#4ADE80' : '#FF5C7A';
      return `<div class="card" style="padding:16px">
        <div style="font-weight:650;margin-bottom:6px">${STOCK_LABELS[t]}</div>
        <div style="font-size:28px;font-weight:700;color:${color}">${have}</div>
        <div class="set-desc" style="margin-top:6px">in stock${price ? ' · ' + price + ' each' : ''}</div>
      </div>`;
    }).join('');
    if (st) st.textContent = (r.size || 0) + ' total · live';
  } catch (e) {
    grid.innerHTML = '<div class="set-desc">Could not load stock</div>';
    if (st) st.textContent = 'error';
  }
}
let stockTimer = null;
document.querySelector('.nav-item[data-screen="stock"]')?.addEventListener('click', () => {
  refreshStock();
  if (stockTimer) clearInterval(stockTimer);
  stockTimer = setInterval(refreshStock, 5000);
});

async function loadTypeDescs() {
  const box = document.getElementById('type-desc-list');
  if (!box) return;
  try {
    const cfg = await fetch('/api/config/public').then((r) => r.json());
    const descs = (cfg && cfg.typeDescs) || {};
    const labels = (cfg && cfg.typeLabels) || STOCK_LABELS;
    const order = ['alt', '+30 days old', '+1 year old', '5+ years old', '18+ age verified', 'dump'];
    box.innerHTML = order.map((t) => {
      const text = descs[t] || 'No description set (TYPE_DESC env).';
      return `<div style="padding:10px 12px;border:1px solid rgba(255,255,255,.06);border-radius:10px">
        <div style="font-weight:650;margin-bottom:4px">${labels[t] || t}</div>
        <div class="set-desc" style="margin:0;line-height:1.45">${text}</div>
      </div>`;
    }).join('');
  } catch {
    box.innerHTML = '<div class="set-desc">Could not load type info</div>';
  }
}
document.querySelector('.nav-item[data-screen="support"]')?.addEventListener('click', () => setTimeout(loadTypeDescs, 100));

/* Top up */
document.getElementById('auth-topup')?.addEventListener('click', () => {
  const s = document.getElementById('topup-scrim');
  if (s) { s.hidden = false; s.style.removeProperty('display'); }
});
document.getElementById('topup-close')?.addEventListener('click', () => {
  const s = document.getElementById('topup-scrim');
  if (s) { s.hidden = true; }
});
document.getElementById('topup-scrim')?.addEventListener('click', (e) => {
  if (e.target.id === 'topup-scrim') e.target.hidden = true;
});
document.getElementById('topup-discord')?.addEventListener('click', async () => {
  try {
    const cfg = await fetch('/api/config/public').then((r) => r.json());
    const url = (cfg && cfg.discordInvite) || '';
    if (url) window.open(url, '_blank');
    else if (typeof toast === 'function') toast('Discord invite not set');
  } catch {
    if (typeof toast === 'function') toast('Could not open Discord');
  }
});
