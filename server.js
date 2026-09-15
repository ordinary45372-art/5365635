require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL;

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'accounts.json');
const VAULT_FILE = path.join(DATA_DIR, 'vault.json');
const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const POOL_FILE = path.join(DATA_DIR, 'pool.json');
const BLOXGEN = 'https://core.bloxgen.net';

const BLOXGEN_TYPES = ['alt', '+30 days old', '+1 year old', '5+ years old', 'dump'];

const SERVER_KEYS = String(process.env.BLOXGEN_API_KEYS || process.env.BLOXGEN_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

function envMin(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const POOL_MIN_BY_TYPE = {
  'alt': envMin('POOL_MIN_ALT', 0),
  '+30 days old': envMin('POOL_MIN_30D', 0),
  '+1 year old': envMin('POOL_MIN_1Y', 0),
  '5+ years old': envMin('POOL_MIN_5Y', 0),
  'dump': envMin('POOL_MIN_DUMP', 0),
};

const POOL_MIN_FALLBACK = envMin('POOL_MIN', 0);
if (POOL_MIN_FALLBACK > 0 && Object.values(POOL_MIN_BY_TYPE).every((n) => n === 0)) {
  for (const t of BLOXGEN_TYPES) POOL_MIN_BY_TYPE[t] = POOL_MIN_FALLBACK;
}

const POOL_REGION = process.env.POOL_REGION || '';
const POOL_INTERVAL_MS = Math.max(15000, parseInt(process.env.POOL_INTERVAL_MS || '45000', 10) || 45000);
let poolBusy = false;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadPool() {
  try {
    await ensureDataDir();
    const raw = await fs.readFile(POOL_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function savePool(pool) {
  await ensureDataDir();
  await fs.writeFile(POOL_FILE, JSON.stringify(pool, null, 2));
}

function pickServerKey() {
  if (!SERVER_KEYS.length) return null;
  return SERVER_KEYS[Math.floor(Math.random() * SERVER_KEYS.length)];
}

async function bloxgenGenerateOnce(apiKey, type, region) {
  const body = { apiKey, type };
  if (region) body.region = region;
  const r = await fetch(`${BLOXGEN}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  if (json && json.success && json.data) return { ok: true, data: json.data };
  return {
    ok: false,
    status: r.status,
    error: (json && json.message) || `HTTP ${r.status}`,
    timeRemaining: json && json.timeRemaining,
    dailyLimit: json && json.dailyLimit,
    remainingGenerations: json && json.remainingGenerations,
  };
}

function makePoolPassword() {
  let digits = '';
  for (let i = 0; i < 5; i++) digits += String(Math.floor(Math.random() * 10));
  return 'ogalts' + digits;
}

async function changeRobloxPassword(cookie, currentPassword, newPassword) {
  if (!cookie || !currentPassword || !newPassword) return { ok: false, error: 'missing' };
  try {
    const url = 'https://auth.roblox.com/v2/user/passwords/change';
    const base = {
      Cookie: '.ROBLOSECURITY=' + cookie,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const body = JSON.stringify({ currentPassword, newPassword });
    let r = await fetch(url, { method: 'POST', headers: base, body });
    if (r.status === 403) {
      const tok = r.headers.get('x-csrf-token');
      if (tok) r = await fetch(url, { method: 'POST', headers: Object.assign({}, base, { 'x-csrf-token': tok }), body });
    }
    if (r.status === 429) return { ok: false, rateLimited: true, error: 'rate limited' };
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      return {
        ok: false,
        error: (j && j.errors && j.errors[0] && j.errors[0].message) || ('HTTP ' + r.status),
      };
    }
    let neu = null;
    if (typeof r.headers.getSetCookie === 'function') {
      for (const c of r.headers.getSetCookie() || []) {
        if (c && /\.ROBLOSECURITY=/.test(c)) neu = (c.match(/\.ROBLOSECURITY=([^;]+)/) || [])[1];
      }
    } else {
      const sc = r.headers.get('set-cookie');
      if (sc && /\.ROBLOSECURITY=/.test(sc)) neu = (sc.match(/\.ROBLOSECURITY=([^;]+)/) || [])[1];
    }
    return { ok: true, cookie: neu || null };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function preparePoolAccount(data, type) {
  const cookie = data.cookie || data.Cookie || data.roblosecurity || '';
  const oldPass = data.password || data.Password || '';
  if (!cookie || !oldPass) {
    console.log('[pool] discard — missing cookie or password');
    return null;
  }
  const newPass = makePoolPassword();
  const ch = await changeRobloxPassword(cookie, oldPass, newPass);
  if (!ch.ok) {
    console.log('[pool] discard — password reset failed:', ch.error || 'unknown');
    return null;
  }
  const out = Object.assign({}, data, {
    password: newPass,
    cookie: ch.cookie || cookie,
    _pooledAt: Date.now(),
    _poolType: type,
    id: data.id || crypto.randomUUID(),
  });
  console.log('[pool] password reset ok →', newPass, 'user=', data.username || data.user || '?');
  return out;
}

async function refillPool() {
  if (poolBusy) return;
  if (!SERVER_KEYS.length) return;
  poolBusy = true;
  try {
    let pool = await loadPool();
    for (const type of BLOXGEN_TYPES) {
      const min = POOL_MIN_BY_TYPE[type] || 0;
      if (min <= 0) continue;
      const have = pool.filter((a) => (a._poolType || a.type) === type).length;
      const need = min - have;
      if (need <= 0) continue;
      console.log(`[pool] ${type}: ${have}/${min}, generating ${need}`);
      for (let i = 0; i < need; i++) {
        const key = pickServerKey();
        if (!key) break;
        const r = await bloxgenGenerateOnce(key, type, POOL_REGION || undefined);
        if (!r.ok) {
          console.log('[pool] generate failed for', type, ':', r.error || r.status);
          if (r.status === 429) return;
          break;
        }
        const prepared = await preparePoolAccount(r.data, type);
        if (!prepared) continue;
        pool.push(prepared);
        await savePool(pool);
        console.log('[pool] added', type, prepared.username || prepared.user || 'account', 'size=', pool.length);
      }
    }
  } catch (e) {
    console.error('[pool]', e.message);
  } finally {
    poolBusy = false;
  }
}

async function claimFromPool(preferredType) {
  let pool = await loadPool();
  if (!pool.length) return null;
  let idx = 0;
  if (preferredType) {
    const i = pool.findIndex((a) => (a._poolType || a.type) === preferredType);
    if (i >= 0) idx = i;
  }
  const [acc] = pool.splice(idx, 1);
  await savePool(pool);
  setTimeout(() => refillPool().catch(() => {}), 500);
  return acc;
}

// Rest of routes + listen (must be present)
eval(fsSync.readFileSync(path.join(__dirname, 'server-routes.js'), 'utf8'));
