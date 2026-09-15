require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

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
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || '';
let mongoClient = null;
let mongoDb = null;

async function getDb() {
  if (!MONGODB_URI) return null;
  if (mongoDb) return mongoDb;
  mongoClient = new MongoClient(MONGODB_URI, { maxPoolSize: 5 });
  await mongoClient.connect();
  mongoDb = mongoClient.db(process.env.MONGODB_DB || 'ogalts');
  console.log('[db] MongoDB connected — data survives Render restarts');
  return mongoDb;
}

async function storeGet(key, fallback) {
  try {
    const db = await getDb();
    if (db) {
      const doc = await db.collection('store').findOne({ _id: key });
      if (doc && doc.data !== undefined) return doc.data;
      return fallback;
    }
  } catch (e) {
    console.error('[db] get', key, e.message);
  }
  await ensureDataDir();
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, key + '.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function storeSet(key, data) {
  try {
    const db = await getDb();
    if (db) {
      await db.collection('store').updateOne(
        { _id: key },
        { $set: { data, updatedAt: new Date() } },
        { upsert: true }
      );
      return;
    }
  } catch (e) {
    console.error('[db] set', key, e.message);
  }
  await ensureDataDir();
  await fs.writeFile(path.join(DATA_DIR, key + '.json'), JSON.stringify(data, null, 2));
}



app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}


const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

function parseStaffLogins() {
  const out = [];
  for (const n of [1, 2, 3]) {
    const raw = process.env['STAFFLOGIN' + n] || '';
    if (!raw.includes(',')) continue;
    const i = raw.indexOf(',');
    const user = raw.slice(0, i).trim();
    const pass = raw.slice(i + 1).trim();
    if (user && pass) out.push({ user, pass });
  }
  return out;
}
const STAFF_LOGINS = parseStaffLogins();

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function signToken(payload) {
  const body = b64url(JSON.stringify(Object.assign({ exp: Date.now() + 30 * 864e5 }, payload)));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig !== expect) return null;
  try {
    const data = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}

function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.body && req.body.token) || '';
  return verifyToken(token);
}

async function verifyGoogleIdToken(credential) {
  if (!credential) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    const j = await r.json();
    if (!j || !j.sub) return null;
    if (GOOGLE_CLIENT_ID && j.aud && j.aud !== GOOGLE_CLIENT_ID) return null;
    return { googleId: j.sub, email: j.email || '', name: j.name || '' };
  } catch {
    return null;
  }
}

async function usersCol() {
  const db = await getDb();
  if (!db) return null;
  return db.collection('users');
}

async function findUserByGoogle(googleId) {
  const col = await usersCol();
  if (!col) return null;
  return col.findOne({ googleId });
}

async function findUserByUsername(username) {
  const col = await usersCol();
  if (!col) return null;
  return col.findOne({ username: String(username || '').toLowerCase() });
}

async function upsertGoogleUser(profile, username) {
  const col = await usersCol();
  if (!col) throw new Error('Database not connected');
  const existing = await col.findOne({ googleId: profile.googleId });
  if (existing) return existing;
  const uname = String(username || '').trim().toLowerCase();
  if (!uname || uname.length < 3) throw new Error('Username required (min 3 chars)');
  if (!/^[a-z0-9_]+$/.test(uname)) throw new Error('Username: letters, numbers, underscore only');
  const taken = await col.findOne({ username: uname });
  if (taken) throw new Error('Username taken');
  const doc = {
    googleId: profile.googleId,
    email: profile.email,
    name: profile.name,
    username: uname,
    balance: 0,
    createdAt: new Date(),
  };
  await col.insertOne(doc);
  return doc;
}

async function loadPool() {
  const data = await storeGet('pool', []);
  return Array.isArray(data) ? data : [];
}

async function savePool(pool) {
  await storeSet('pool', Array.isArray(pool) ? pool : []);
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
        if (!prepared) {
          continue;
        }
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
  // Only return the requested type — never fall back to another type
  if (preferredType) {
    const i = pool.findIndex((a) => (a._poolType || a.type) === preferredType);
    if (i < 0) return null;
    const [acc] = pool.splice(i, 1);
    await savePool(pool);
    setTimeout(() => refillPool().catch(() => {}), 500);
    return acc;
  }
  const [acc] = pool.splice(0, 1);
  await savePool(pool);
  setTimeout(() => refillPool().catch(() => {}), 500);
  return acc;
}

async function fetchJSON(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const opts = Object.assign({ signal: ctrl.signal }, options);
    opts.headers = Object.assign(
      { Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
      options && options.headers
    );
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function computeAge(y, m, d) {
  const now = new Date();
  let age = now.getFullYear() - y;
  const mo = now.getMonth() + 1;
  if (mo < m || (mo === m && now.getDate() < d)) age--;
  return age;
}

function ageBucket(age) {
  return age >= 21 ? '21+' : age >= 18 ? '18-20' : age >= 16 ? '16-17' : age >= 13 ? '13-15' : age >= 9 ? '9-12' : 'Unknown';
}

async function cookieAliveStatus(cookie) {
  if (!cookie) return 'dead';
  try {
    const r = await fetch('https://users.roblox.com/v1/users/authenticated', {
      headers: { Cookie: '.ROBLOSECURITY=' + cookie, Accept: 'application/json' },
    });
    if (r.status === 401 || r.status === 403) return 'dead';
    if (!r.ok) return 'unknown';
    const j = await r.json().catch(() => null);
    return (j && j.id) ? 'alive' : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function authPost(url, body, cookie, extra = {}) {
  const base = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    ...extra,
  };
  if (cookie) base.Cookie = '.ROBLOSECURITY=' + cookie;
  const send = (tok) =>
    fetch(url, {
      method: 'POST',
      headers: tok ? { ...base, 'X-CSRF-TOKEN': tok } : base,
      body: JSON.stringify(body),
    });
  let res = await send();
  if (res.status === 403) {
    const tok = res.headers.get('x-csrf-token');
    if (tok) res = await send(tok);
  }
  return res;
}async function detectViaCookie(cookie) {
  if (!cookie) return { loggedIn: false };
  const headers = { Cookie: '.ROBLOSECURITY=' + cookie };
  const me = await fetchJSON('https://users.roblox.com/v1/users/authenticated', { headers });
  if (!me || !me.id) return { loggedIn: false };
  const out = { loggedIn: true, userId: String(me.id), displayName: me.displayName || me.name || '' };
  const voice = await fetchJSON('https://voice.roblox.com/v1/settings', { headers });
  if (voice && typeof voice.isVoiceEnabled === 'boolean') out.voiceChat = voice.isVoiceEnabled;
  const bd = await fetchJSON('https://accountinformation.roblox.com/v1/birthdate', { headers });
  if (bd && bd.birthYear) {
    const age = computeAge(bd.birthYear, bd.birthMonth || 1, bd.birthDay || 1);
    out.age = age;
    out.ageRange = ageBucket(age);
    out.birthdate = `${bd.birthYear}-${String(bd.birthMonth || 1).padStart(2, '0')}-${String(bd.birthDay || 1).padStart(2, '0')}`;
  }
  const av = await fetchJSON('https://apis.roblox.com/age-verification-service/v1/age-verification/verified-age', { headers });
  if (av) {
    if (typeof av.isVerified === 'boolean') out.ageVerified = av.isVerified;
    else if (av.verifiedAge != null) out.ageVerified = true;
  }
  const email = await fetchJSON('https://accountsettings.roblox.com/v1/email', { headers });
  if (email && typeof email.verified === 'boolean') {
    out.emailVerified = email.verified;
    out.emailMasked = email.emailAddress || '';
  }
  return out;
}

app.post('/api/accounts/load', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || !u.uid) return res.json([]);
    const data = await storeGet('accounts:' + u.uid, []);
    res.json(Array.isArray(data) ? data : []);
  } catch {
    res.json([]);
  }
});

app.post('/api/accounts/save', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || !u.uid) return res.json({ ok: false, error: 'Not logged in' });
    const accounts = (req.body && req.body.accounts) || req.body || [];
    await storeSet('accounts:' + u.uid, Array.isArray(accounts) ? accounts : []);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/accounts/export', async (req, res) => {
  res.json({ ok: true, data: req.body.accounts || [] });
});

app.post('/api/accounts/import-txt', (req, res) => {
  res.status(501).json({ error: 'Use the browser file input in the UI' });
});

app.post('/api/game/resolve', async (req, res) => {
  const id = String(req.body.id || req.body.rawId || '').trim();
  if (!/^\d+$/.test(id)) return res.json({ ok: false, error: 'Invalid ID' });
  let universeId = null;
  const uni = await fetchJSON(`https://apis.roblox.com/universes/v1/places/${id}/universe`);
  if (uni && uni.universeId) universeId = uni.universeId;
  const candidate = universeId || id;
  const games = await fetchJSON(`https://games.roblox.com/v1/games?universeIds=${candidate}`);
  const name = games && Array.isArray(games.data) && games.data[0] && games.data[0].name;
  if (name) return res.json({ ok: true, id, name });
  res.json({ ok: false, error: 'Game not found' });
});

app.post('/api/roblox/enrich', async (req, res) => {
  const name = String(req.body.username || '').trim();
  if (!name) return res.json({ ok: false, error: 'Empty username' });
  const lookup = await fetchJSON('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [name], excludeBannedUsers: false }),
  });
  const user = lookup && Array.isArray(lookup.data) && lookup.data[0];
  if (!user) return res.json({ ok: false, error: 'User not found' });
  const userId = user.id;
  const details = await fetchJSON(`https://users.roblox.com/v1/users/${userId}`);
  const thumb = await fetchJSON(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=48x48&format=Png&isCircular=false`);
  const avatarUrl = thumb && Array.isArray(thumb.data) && thumb.data[0] && thumb.data[0].imageUrl;
  res.json({
    ok: true,
    userId: String(userId),
    username: user.name || name,
    displayName: (details && details.displayName) || user.displayName || user.name || name,
    created: details && details.created ? String(details.created).slice(0, 10) : null,
    robloxBanned: !!(details && details.isBanned),
    avatarUrl: avatarUrl || null,
  });
});

app.post('/api/roblox/enrich-batch', async (req, res) => {
  const names = (Array.isArray(req.body.usernames) ? req.body.usernames : []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!names.length) return res.json({});
  const out = {};
  for (let i = 0; i < names.length; i += 100) {
    const chunk = names.slice(i, i + 100);
    const lookup = await fetchJSON('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: chunk, excludeBannedUsers: false }),
    });
    const data = lookup && Array.isArray(lookup.data) ? lookup.data : [];
    const ids = [];
    for (const u of data) {
      const key = String(u.requestedUsername || u.name || '').toLowerCase();
      if (!key) continue;
      out[key] = { ok: true, userId: String(u.id), displayName: u.displayName || u.name || '', created: null, robloxBanned: false, avatarUrl: null };
      ids.push(u.id);
    }
    if (ids.length) {
      const thumb = await fetchJSON(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids.join(',')}&size=48x48&format=Png&isCircular=false`);
      const byId = {};
      for (const t of (thumb && Array.isArray(thumb.data) ? thumb.data : [])) byId[String(t.targetId)] = t.imageUrl;
      for (const key of Object.keys(out)) {
        const r = out[key];
        if (r.userId && byId[r.userId]) r.avatarUrl = byId[r.userId];
      }
    }
  }
  const entries = Object.values(out).filter((r) => r.userId);
  for (let i = 0; i < entries.length; i += 5) {
    await Promise.all(entries.slice(i, i + 5).map(async (r) => {
      const d = await fetchJSON(`https://users.roblox.com/v1/users/${r.userId}`);
      if (d) { r.created = d.created ? String(d.created).slice(0, 10) : null; r.robloxBanned = !!d.isBanned; }
    }));
  }
  res.json(out);
});

app.post('/api/bloxgen/balance', async (req, res) => {
  const apiKey = req.body.apiKey || pickServerKey() || '';
  if (!apiKey) return res.json({ ok: false, error: 'No API key (set BLOXGEN_API_KEYS on server)' });
  const r = await fetchJSON(`${BLOXGEN}/api/balance?apiKey=${encodeURIComponent(apiKey)}`);
  if (r && r.success && r.data) return res.json({ ok: true, balance: r.data.balance });
  res.json({ ok: false, error: (r && r.message) || 'Could not fetch balance' });
});

app.post('/api/bloxgen/daily-limit', async (req, res) => {
  const { apiKey, type } = req.body || {};
  const key = apiKey || pickServerKey() || '';
  let url = `${BLOXGEN}/api/daily-limit?apiKey=${encodeURIComponent(key)}`;
  if (type) url += `&type=${encodeURIComponent(type)}`;
  const r = await fetchJSON(url);
  if (r && r.success && r.data) return res.json({ ok: true, data: r.data });
  res.json({ ok: false, error: (r && r.message) || 'Could not fetch daily limit' });
});

app.post('/api/bloxgen/generate', async (req, res) => {
  const { type } = req.body || {};
  const genType = type || 'alt';

  try {
    const pooled = await claimFromPool(genType);
    if (pooled) {
      const data = Object.assign({}, pooled);
      delete data._pooledAt;
      delete data._poolType;
      return res.json({ ok: true, data, fromPool: true });
    }
  } catch (e) {
    console.error('[claim]', e.message);
  }

  setTimeout(() => refillPool().catch(() => {}), 200);
  return res.json({
    ok: false,
    status: 0,
    error: 'Out of stock',
  });
});app.post('/api/roblox/cookie-identity', async (req, res) => {
  try {
    const { cookie } = req.body;
    if (!cookie) return res.json({ ok: false });
    const me = await fetchJSON('https://users.roblox.com/v1/users/authenticated', { headers: { Cookie: '.ROBLOSECURITY=' + cookie } });
    if (!me || !me.id) return res.json({ ok: false });
    const thumb = await fetchJSON(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${me.id}&size=48x48&format=Png&isCircular=false`);
    res.json({ ok: true, userId: String(me.id), username: me.name || '', displayName: me.displayName || me.name || '', avatarUrl: thumb?.data?.[0]?.imageUrl || null });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/roblox/cookie-alive-check', async (req, res) => {
  const status = await cookieAliveStatus(req.body.cookie);
  res.json({ status, alive: status === 'alive' });
});

app.post('/api/roblox/age-info', async (req, res) => {
  try {
    const { cookie } = req.body;
    if (!cookie) return res.json({ ok: false, error: 'No cookie' });
    const bd = await fetchJSON('https://accountinformation.roblox.com/v1/birthdate', { headers: { Cookie: '.ROBLOSECURITY=' + cookie } });
    if (!bd || !bd.birthYear) return res.json({ ok: false, error: 'No birthdate' });
    const age = computeAge(bd.birthYear, bd.birthMonth || 1, bd.birthDay || 1);
    res.json({ ok: true, age, ageRange: ageBucket(age), birthdate: `${bd.birthYear}-${String(bd.birthMonth || 1).padStart(2, '0')}-${String(bd.birthDay || 1).padStart(2, '0')}` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/roblox/refresh-info', async (req, res) => {
  const { cookie } = req.body || {};
  if (cookie) return res.json(Object.assign({}, await detectViaCookie(cookie), { cookie }));
  res.json({ loggedIn: false, cookie: null });
});

app.post('/api/roblox/detect', async (req, res) => {
  res.json(await detectViaCookie(req.body.cookie));
});

app.post('/api/roblox/presence', async (req, res) => {
  try {
    const { userId, cookie } = req.body || {};
    const id = Number(userId);
    if (!id) return res.json({ ok: false, error: 'No userId' });
    const r = await authPost('https://presence.roblox.com/v1/presence/users', { userIds: [id] }, cookie);
    if (!r.ok) return res.json({ ok: false, error: 'HTTP ' + r.status });
    const j = await r.json();
    const p = j?.userPresences?.[0];
    if (!p) return res.json({ ok: false, error: 'No presence' });
    res.json({ ok: true, type: p.userPresenceType, lastLocation: p.lastLocation || '', placeId: p.placeId || null, rootPlaceId: p.rootPlaceId || null, universeId: p.universeId || null, lastOnline: p.lastOnline || null });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/roblox/robux-rap', async (req, res) => {
  try {
    const { userId, cookie } = req.body || {};
    if (!userId) return res.json({ ok: false, error: 'no userId' });
    const headers = cookie ? { Cookie: '.ROBLOSECURITY=' + cookie } : {};
    const econ = await fetchJSON(`https://economy.roblox.com/v1/users/${userId}/currency`, { headers });
    const robux = econ && typeof econ.robux === 'number' ? econ.robux : null;
    let totalRap = 0, limitedCount = 0;
    try {
      let c = '', p = 0;
      do {
        const u = `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?limit=100&sortOrder=Asc${c ? '&cursor=' + encodeURIComponent(c) : ''}`;
        const r = await fetchJSON(u, { headers });
        if (!r || !Array.isArray(r.data)) break;
        for (const it of r.data) { const v = typeof it.recentAveragePrice === 'number' ? it.recentAveragePrice : 0; totalRap += v; limitedCount++; }
        c = r.nextPageCursor || ''; p++;
      } while (c && p < 10);
    } catch {}
    res.json({ ok: true, robux, totalRap, limitedCount });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/roblox/inventory', async (req, res) => {
  try {
    const { userId, cookie } = req.body || {};
    if (!userId) return res.json({ ok: false, error: 'no userId' });
    const headers = cookie ? { Cookie: '.ROBLOSECURITY=' + cookie } : {};
    const items = []; let totalRap = 0, cursor = '', pages = 0;
    do {
      const u = `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?limit=100&sortOrder=Asc${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
      const r = await fetchJSON(u, { headers });
      if (!r || !Array.isArray(r.data)) break;
      for (const it of r.data) {
        const v = typeof it.recentAveragePrice === 'number' ? it.recentAveragePrice : 0;
        totalRap += v;
        items.push({ name: it.name || '(item)', kind: 'asset', id: it.assetId, rap: v });
      }
      cursor = r.nextPageCursor || ''; pages++;
    } while (cursor && pages < 10);
    res.json({ ok: true, totalRap, items, truncated: !!cursor });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const INV_TYPES = 'Hat,HairAccessory,FaceAccessory,NeckAccessory,ShoulderAccessory,FrontAccessory,BackAccessory,WaistAccessory,TShirt,Shirt,Pants,Face,Head,Gear,EmoteAnimation,Animation,Decal,Model,Plugin,MeshPart,Audio,Package';

app.post('/api/roblox/inventory-full', async (req, res) => {
  try {
    const { userId, cookie } = req.body || {};
    if (!userId) return res.json({ ok: false, error: 'no userId' });
    const headers = cookie ? { Cookie: '.ROBLOSECURITY=' + cookie } : {};
    const rap = {}; let limitedCount = 0, totalRap = 0;
    try {
      let c = '', p = 0;
      do {
        const u = `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?limit=100&sortOrder=Asc${c ? '&cursor=' + encodeURIComponent(c) : ''}`;
        const r = await fetchJSON(u, { headers });
        if (!r || !Array.isArray(r.data)) break;
        for (const it of r.data) { const v = typeof it.recentAveragePrice === 'number' ? it.recentAveragePrice : 0; rap[it.assetId] = v; limitedCount++; totalRap += v; }
        c = r.nextPageCursor || ''; p++;
      } while (c && p < 10);
    } catch {}
    const items = []; const counts = {}; let cursor = '', pages = 0;
    try {
      do {
        const u = `https://inventory.roblox.com/v2/users/${userId}/inventory?assetTypes=${INV_TYPES}&limit=100&sortOrder=Asc${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
        const r = await fetchJSON(u, { headers });
        if (!r || !Array.isArray(r.data)) { if (!items.length && !limitedCount) return res.json({ ok: false, error: 'inventory unavailable (private?)' }); break; }
        for (const it of r.data) {
          const type = it.assetType || it.type || 'Other';
          counts[type] = (counts[type] || 0) + 1;
          items.push({ name: it.name || '(item)', kind: 'asset', id: it.assetId, type, rap: rap[it.assetId] != null ? rap[it.assetId] : null });
        }
        cursor = r.nextPageCursor || ''; pages++;
      } while (cursor && pages < 15);
    } catch (e) {
      if (!items.length && !limitedCount) return res.json({ ok: false, error: String(e.message || e) });
    }
    try {
      let c = '', p = 0;
      do {
        const u = `https://catalog.roblox.com/v1/users/${userId}/bundles?limit=100&sortOrder=Asc${c ? '&cursor=' + encodeURIComponent(c) : ''}`;
        const r = await fetchJSON(u, { headers });
        if (!r || !Array.isArray(r.data)) break;
        for (const b of r.data) { counts.Bundle = (counts.Bundle || 0) + 1; items.push({ name: b.name || '(bundle)', kind: 'bundle', id: b.id, type: 'Bundle', rap: null }); }
        c = r.nextPageCursor || ''; p++;
      } while (c && p < 5);
    } catch {}
    res.json({ ok: true, totalRap, limitedCount, count: items.length, counts, items, truncated: !!cursor });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/roblox/asset-thumbs', async (req, res) => {
  const ids = (Array.isArray(req.body.assetIds) ? req.body.assetIds : []).filter(Boolean).slice(0, 100);
  if (!ids.length) return res.json({});
  const r = await fetchJSON(`https://thumbnails.roblox.com/v1/assets?assetIds=${ids.join(',')}&size=150x150&format=Png&isCircular=false`);
  const map = {};
  if (r && Array.isArray(r.data)) for (const t of r.data) if (t.imageUrl && t.state === 'Completed') map[t.targetId] = t.imageUrl;
  res.json(map);
});

app.post('/api/roblox/bundle-thumbs', async (req, res) => {
  const ids = (Array.isArray(req.body.bundleIds) ? req.body.bundleIds : []).filter(Boolean).slice(0, 100);
  if (!ids.length) return res.json({});
  const body = ids.map((id) => ({ type: 'BundleThumbnail', targetId: Number(id), size: '150x150', format: 'Png' }));
  const r = await fetchJSON('https://thumbnails.roblox.com/v1/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const map = {};
  if (r && Array.isArray(r.data)) for (const t of r.data) if (t.imageUrl && t.state === 'Completed') map[t.targetId] = t.imageUrl;
  res.json(map);
});

app.post('/api/roblox/gamepass-thumbs', async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter(Boolean).slice(0, 100);
  if (!ids.length) return res.json({});
  const r = await fetchJSON(`https://thumbnails.roblox.com/v1/game-passes?gamePassIds=${ids.join(',')}&size=150x150&format=Png&isCircular=false`);
  const map = {};
  if (r && Array.isArray(r.data)) for (const t of r.data) if (t.imageUrl && t.state === 'Completed') map[t.targetId] = t.imageUrl;
  res.json(map);
});

app.post('/api/roblox/inventory-value', async (req, res) => {
  const its = Array.isArray(req.body.items) ? req.body.items : [];
  let total = 0;
  for (const it of its) if (it && typeof it.rap === 'number') total += it.rap;
  res.json({ ok: true, value: total });
});

app.post('/api/roblox/search-games', async (req, res) => {
  const q = String(req.body.query || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const sid = '00000000-0000-0000-0000-000000000000';
    const url = `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(q)}&pageType=Games&sessionId=${sid}`;
    const result = await fetchJSON(url);
    if (!result || !Array.isArray(result.searchResults)) return res.json([]);
    const games = [];
    for (const grp of result.searchResults) {
      for (const c of (grp.contents || [])) {
        if ((c.universeId || c.rootPlaceId) && c.name) {
          games.push({ universeId: c.universeId, rootPlaceId: c.rootPlaceId, name: c.name });
        }
        if (games.length >= 10) break;
      }
      if (games.length >= 10) break;
    }
    const uids = games.map((g) => g.universeId).filter(Boolean);
    const icons = {};
    if (uids.length) {
      const t = await fetchJSON(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${uids.join(',')}&size=50x50&format=Png&isCircular=false`);
      for (const it of (t && Array.isArray(t.data) ? t.data : [])) {
        if (it.imageUrl) icons[String(it.targetId)] = it.imageUrl;
      }
    }
    res.json(games.map((g) => ({
      id: String(g.rootPlaceId || g.universeId || ''),
      universeId: g.universeId ? String(g.universeId) : '',
      rootPlaceId: g.rootPlaceId ? String(g.rootPlaceId) : null,
      name: g.name,
      iconUrl: icons[String(g.universeId)] || null,
    })));
  } catch (e) {
    console.error('search-games', e.message);
    res.json([]);
  }
});app.post('/api/roblox/user-badges', async (req, res) => {
  const { userId, cookie } = req.body || {};
  if (!userId) return res.json({ ok: false, error: 'no userId' });
  const headers = cookie ? { Cookie: '.ROBLOSECURITY=' + cookie } : {};
  const places = {};
  let cursor = '', pages = 0;
  try {
    do {
      const u = `https://badges.roblox.com/v1/users/${userId}/badges?limit=100&sortOrder=Desc${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
      const r = await fetchJSON(u, { headers });
      if (!r || !Array.isArray(r.data)) { if (!pages) return res.json({ ok: false, error: 'badges unavailable' }); break; }
      for (const b of r.data) {
        const pid = b.awarder && b.awarder.id;
        if (pid) places[pid] = (places[pid] || 0) + 1;
      }
      cursor = r.nextPageCursor || '';
      pages++;
    } while (cursor && pages < 10);
    res.json({ ok: true, places });
  } catch (e) {
    res.json({ ok: false, error: String((e && e.message) || e) });
  }
});

app.post('/api/roblox/places-universes', async (req, res) => {
  const placeIds = (Array.isArray(req.body.placeIds) ? req.body.placeIds : []).filter(Boolean).slice(0, 100);
  if (!placeIds.length) return res.json({});
  const map = {};
  for (const id of placeIds) {
    const uni = await fetchJSON(`https://apis.roblox.com/universes/v1/places/${id}/universe`);
    if (uni && uni.universeId) map[id] = uni.universeId;
  }
  res.json(map);
});

app.post('/api/roblox/recently-played', async (req, res) => {
  res.json({ ok: true, games: [] });
});

app.post('/api/roblox/refresh-cookie', async (req, res) => {
  const { cookie } = req.body || {};
  if (!cookie) return res.json({ ok: false, error: 'No cookie' });
  const status = await cookieAliveStatus(cookie);
  res.json({ ok: status === 'alive', cookie: status === 'alive' ? cookie : null });
});

app.post('/api/roblox/friend-request', async (req, res) => {
  const { cookie, userId } = req.body || {};
  if (!cookie || !userId) return res.json({ ok: false, error: 'missing cookie or userId' });
  try {
    const r = await authPost(`https://friends.roblox.com/v1/users/${userId}/request-friendship`, {}, cookie);
    const j = await r.json().catch(() => null);
    res.json({ ok: r.ok, data: j });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/roblox/follow-user', async (req, res) => {
  const { cookie, userId } = req.body || {};
  if (!cookie || !userId) return res.json({ ok: false, error: 'missing cookie or userId' });
  try {
    const r = await authPost(`https://friends.roblox.com/v1/users/${userId}/follow`, {}, cookie);
    const j = await r.json().catch(() => null);
    res.json({ ok: r.ok, data: j });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/roblox/change-password', async (req, res) => {
  const { cookie, currentPassword, newPassword } = req.body || {};
  const r = await changeRobloxPassword(cookie, currentPassword, newPassword);
  res.json(r);
});

app.post('/api/vault/load', async (req, res) => {
  try {
    const data = await storeGet('vault', { accounts: {} });
    res.json(data && typeof data === 'object' ? data : { accounts: {} });
  } catch {
    res.json({ accounts: {} });
  }
});

app.post('/api/vault/save', async (req, res) => {
  try {
    await storeSet('vault', req.body || { accounts: {} });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/games/load', async (req, res) => {
  try {
    const data = await storeGet('games', { accounts: {}, places: {} });
    res.json(data && typeof data === 'object' ? data : { accounts: {}, places: {} });
  } catch {
    res.json({ accounts: {}, places: {} });
  }
});

app.post('/api/games/save', async (req, res) => {
  try {
    await storeSet('games', req.body || { accounts: {}, places: {} });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/roblox/set-cookie', (req, res) => res.json({ ok: true }));
app.post('/api/roblox/get-cookie', (req, res) => res.json(null));
app.post('/api/secure/status', (req, res) => res.json({ encEnabled: false, unlocked: true }));
app.post('/api/secure/unlock', (req, res) => res.json({ ok: true }));
app.post('/api/secure/set', (req, res) => res.json({ ok: true }));
app.post('/api/secure/remove', (req, res) => res.json({ ok: true }));
app.post('/api/theme/set', (req, res) => res.json({ ok: true }));
app.post('/api/overlay/dim', (req, res) => res.json({ ok: true }));
app.post('/api/app/version', (req, res) => res.json('1.0.0-web'));
app.post('/api/config/set', (req, res) => res.json({ ok: true }));

app.get('/api/pool/status', async (req, res) => {
  const pool = await loadPool();
  const byType = {};
  for (const t of BLOXGEN_TYPES) {
    byType[t] = {
      have: pool.filter((a) => (a._poolType || a.type) === t).length,
      min: POOL_MIN_BY_TYPE[t] || 0,
    };
  }
  res.json({ size: pool.length, byType, serverKeys: SERVER_KEYS.length, region: POOL_REGION || 'auto' });
});

app.post('/api/pool/status', async (req, res) => {
  const pool = await loadPool();
  const byType = {};
  for (const t of BLOXGEN_TYPES) {
    byType[t] = {
      have: pool.filter((a) => (a._poolType || a.type) === t).length,
      min: POOL_MIN_BY_TYPE[t] || 0,
    };
  }
  res.json({ size: pool.length, byType, serverKeys: SERVER_KEYS.length, region: POOL_REGION || 'auto' });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

if (KEEP_ALIVE_URL) {
  const ping = () => {
    try {
      const url = new URL(KEEP_ALIVE_URL);
      const lib = url.protocol === 'https:' ? https : http;
      const r = lib.get(KEEP_ALIVE_URL, (res) => { res.on('data', () => {}); res.on('end', () => {}); });
      r.on('error', (err) => console.error('[keep-alive]', err.message));
      r.setTimeout(10000, () => r.destroy());
    } catch (err) {
      console.error('[keep-alive] bad URL', err.message);
    }
  };
  setTimeout(ping, 15000);
  setInterval(ping, 60000);
  console.log(`[keep-alive] will ping ${KEEP_ALIVE_URL} every 60s`);
} else {
  console.log('[keep-alive] KEEP_ALIVE_URL not set – skipping');
}

if (!MONGODB_URI) {
  console.log('[db] MONGODB_URI not set — using ephemeral disk (data lost on restart)');
} else {
  getDb().catch((e) => console.error('[db] connect failed', e.message));
}

if (SERVER_KEYS.length) {
  console.log(`[pool] ${SERVER_KEYS.length} server key(s), mins=${JSON.stringify(POOL_MIN_BY_TYPE)}`);
  setTimeout(() => refillPool().catch(() => {}), 8000);
  setInterval(() => refillPool().catch(() => {}), POOL_INTERVAL_MS);
} else {
  console.log('[pool] BLOXGEN_API_KEYS not set — pool disabled');
}



app.get('/api/config/public', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || '' });
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential, username } = req.body || {};
    const profile = await verifyGoogleIdToken(credential);
    if (!profile) return res.json({ ok: false, error: 'Invalid Google login' });
    let user = await findUserByGoogle(profile.googleId);
    if (!user) {
      if (!username) return res.json({ ok: false, needUsername: true, error: 'Choose a username' });
      user = await upsertGoogleUser(profile, username);
    }
    const token = signToken({ uid: String(user._id), googleId: user.googleId, username: user.username, role: 'user' });
    res.json({
      ok: true,
      token,
      user: { username: user.username, email: user.email, balance: Number(user.balance) || 0 },
    });
  } catch (e) {
    res.json({ ok: false, error: e.message || 'Login failed' });
  }
});

app.post('/api/auth/me', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u) return res.json({ ok: false });
    if (u.role === 'staff') {
      return res.json({ ok: true, staff: true, username: u.username });
    }
    const col = await usersCol();
    let doc = null;
    if (col) {
      try {
        const { ObjectId } = require('mongodb');
        doc = await col.findOne({ _id: new ObjectId(u.uid) });
      } catch (_) {}
      if (!doc && u.username) doc = await col.findOne({ username: u.username });
      if (!doc && u.googleId) doc = await col.findOne({ googleId: u.googleId });
    }
    if (!doc) return res.json({ ok: true, user: { username: u.username, balance: 0 } });
    res.json({ ok: true, user: { username: doc.username, email: doc.email, balance: Number(doc.balance) || 0 } });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/auth/staff', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const match = STAFF_LOGINS.find((s) => s.user === username && s.pass === password);
    if (!match) return res.json({ ok: false, error: 'Invalid staff login' });
    const token = signToken({ uid: 'staff:' + username, username, role: 'staff' });
    res.json({ ok: true, token, staff: true, username });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/staff/users', async (req, res) => {
  const u = authUser(req);
  if (!u || u.role !== 'staff') return res.json({ ok: false, error: 'Forbidden' });
  try {
    const col = await usersCol();
    if (!col) return res.json({ ok: false, error: 'No database' });
    const list = await col.find({}).project({ username: 1, email: 1, balance: 1, createdAt: 1 }).sort({ username: 1 }).limit(500).toArray();
    res.json({
      ok: true,
      users: list.map((x) => ({
        username: x.username,
        email: x.email || '',
        balance: Number(x.balance) || 0,
      })),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/staff/balance', async (req, res) => {
  const u = authUser(req);
  if (!u || u.role !== 'staff') return res.json({ ok: false, error: 'Forbidden' });
  try {
    const { username, amount, set } = req.body || {};
    const uname = String(username || '').trim().toLowerCase();
    const col = await usersCol();
    if (!col) return res.json({ ok: false, error: 'No database' });
    const doc = await col.findOne({ username: uname });
    if (!doc) return res.json({ ok: false, error: 'User not found' });
    let next = Number(doc.balance) || 0;
    const amt = Number(amount);
    if (!Number.isFinite(amt)) return res.json({ ok: false, error: 'Invalid amount' });
    if (set) next = amt;
    else next = next + amt;
    if (next < 0) next = 0;
    await col.updateOne({ username: uname }, { $set: { balance: Math.round(next * 100) / 100 } });
    res.json({ ok: true, username: uname, balance: Math.round(next * 100) / 100 });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});


app.listen(PORT, () => {
  console.log(`RBXFORGE web running on port ${PORT}`);
});