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

const BLOXGEN_TYPES = ['alt', '+30 days old', '+1 year old', '5+ years old', '18+ age verified', 'dump'];

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
  '18+ age verified': envMin('POOL_MIN_18', 0),
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

app.post('/api/discord/interactions', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    if (!verifyDiscordInteraction(raw, signature, timestamp)) {
      console.error('[discord-interactions] bad signature', {
        hasKey: !!(process.env.DISCORD_PUBLIC_KEY || '').trim(),
        hasSig: !!signature,
        hasTs: !!timestamp,
        bodyLen: raw.length,
      });
      return res.status(401).end('invalid request signature');
    }
    const body = JSON.parse(raw);
    // 1 = PING — Discord endpoint verification
    if (body.type === 1) {
      console.log('[discord-interactions] PING ok');
      return res.status(200).json({ type: 1 });
    }
    // 3 = MESSAGE_COMPONENT (report buttons → open staff note modal)
    if (body.type === 3) {
      const customId = (body.data && body.data.custom_id) || '';
      const parts = customId.split(':');
      if (parts[0] === 'rpt' && parts.length >= 3) {
        const action = parts[1];
        const rid = parts.slice(2).join(':');
        if (action === 'unable' || action === 'resolved') {
          const title = action === 'unable' ? 'Unable to help' : 'Issue resolved';
          return res.json({
            type: 9,
            data: {
              custom_id: ('rptmodal:' + action + ':' + rid).slice(0, 100),
              title: title.slice(0, 45),
              components: [{
                type: 1,
                components: [{
                  type: 4,
                  custom_id: 'staff_note',
                  label: 'More info (optional)',
                  style: 2,
                  required: false,
                  max_length: 500,
                  placeholder: 'Why / extra notes for the user…',
                }],
              }],
            },
          });
        }
      }
      return res.json({ type: 4, data: { content: 'Unknown button', flags: 64 } });
    }
    // 5 = MODAL_SUBMIT (staff optional note + set status)
    if (body.type === 5) {
      const customId = (body.data && body.data.custom_id) || '';
      const parts = customId.split(':');
      if (parts[0] === 'rptmodal' && parts.length >= 3) {
        const action = parts[1];
        const rid = parts.slice(2).join(':');
        const status = action === 'unable' ? 'unable_to_help' : (action === 'resolved' ? 'resolved' : null);
        let staffNote = '';
        const rows = (body.data && body.data.components) || [];
        for (const row of rows) {
          for (const c of (row.components || [])) {
            if (c.custom_id === 'staff_note') staffNote = String(c.value || '').trim().slice(0, 500);
          }
        }
        if (status) {
          try {
            const col = await reportsCol();
            const { ObjectId } = require('mongodb');
            const staffName = (body.member && body.member.user && (body.member.user.username || body.member.user.global_name)) || 'staff';
            await col.updateOne(
              { _id: new ObjectId(rid) },
              { $set: { status, staffNote, resolvedAt: new Date(), resolvedBy: staffName } }
            );
            discordLog('Report updated', [
              '**id:** ' + rid,
              '**status:** ' + status,
              '**staff:** ' + staffName,
              staffNote ? ('**note:** ' + staffNote) : null,
            ], 0x98A1B0);
          } catch (e) {
            console.error('[report-modal]', e.message);
            return res.json({ type: 4, data: { content: 'Failed: ' + e.message, flags: 64 } });
          }
          const label = status === 'unable_to_help' ? 'Unable to help' : 'Issue resolved';
          return res.json({
            type: 4,
            data: {
              content: 'Marked as **' + label + '**' + (staffNote ? '\nNote: ' + staffNote : ''),
              flags: 64,
            },
          });
        }
      }
      return res.json({ type: 4, data: { content: 'Unknown modal', flags: 64 } });
    }
    return res.json({ type: 4, data: { content: 'Ignored', flags: 64 } });
  } catch (e) {
    console.error('[discord-interactions]', e.message);
    return res.status(500).end();
  }
});

app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}


const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

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


const TYPE_DESCS = {
  'alt': process.env.TYPE_DESC_ALT || process.env.TYPE_DESC_STANDARD || '',
  '+30 days old': process.env.TYPE_DESC_30D || '',
  '+1 year old': process.env.TYPE_DESC_1Y || '',
  '5+ years old': process.env.TYPE_DESC_5Y || '',
  '18+ age verified': process.env.TYPE_DESC_18 || '',
  'dump': process.env.TYPE_DESC_ROBUX || process.env.TYPE_DESC_DUMP || '',
};

const GEN_PRICE = {
  'alt': 0.001,
  '+30 days old': 0.005,
  '+1 year old': 0.01,
  '5+ years old': 0.02,
  '18+ age verified': 0.03,
  'dump': 0.04,
};
const COLLAB_PLANS = {
  basic: { price: 5, earn: 0.10, label: 'Basic' },
  premium: { price: 10, earn: 0.25, label: 'Premium' },
  elite: { price: 18, earn: 0.50, label: 'Elite' },
};
function envStr(key) {
  let v = process.env[key];
  if (v == null || v === '') return '';
  v = String(v).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).trim();
  return v;
}
const DISCORD_INVITE = envStr('DISCORD_INVITE');
const DISCORD_CLIENT_ID = envStr('DISCORD_CLIENT_ID') || envStr('DISCORD_ID');
const DISCORD_CLIENT_SECRET = envStr('DISCORD_CLIENT_SECRET') || envStr('DISCORD_SECRET');
const DISCORD_REDIRECT = envStr('DISCORD_REDIRECT') || envStr('DISCORD_REDIRECT_URI');
console.log('[discord] oauth config', {
  clientId: DISCORD_CLIENT_ID ? (DISCORD_CLIENT_ID.slice(0, 6) + '…') : '(missing)',
  secret: DISCORD_CLIENT_SECRET ? ('set, len=' + DISCORD_CLIENT_SECRET.length) : '(missing)',
  redirect: DISCORD_REDIRECT || '(missing)',
});


const DISCORD_LOG_WEBHOOK = String(process.env.DISCORD_LOG_WEBHOOK || '').trim();
const DISCORD_REPORT_WEBHOOK = String(process.env.DISCORD_REPORT_WEBHOOK || '').trim();

const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || '').trim();
const DISCORD_PUBLIC_KEY = String(process.env.DISCORD_PUBLIC_KEY || '').trim();
const DISCORD_REPORT_CHANNEL_ID = String(process.env.DISCORD_REPORT_CHANNEL_ID || '').trim();

function verifyDiscordInteraction(rawBody, signature, timestamp) {
  const pub = String(process.env.DISCORD_PUBLIC_KEY || DISCORD_PUBLIC_KEY || '').trim();
  if (!pub || !signature || !timestamp) {
    console.error('[discord-verify] missing public key or headers');
    return false;
  }
  try {
    const nacl = require('tweetnacl');
    const message = Buffer.from(String(timestamp) + rawBody);
    const sig = Buffer.from(String(signature), 'hex');
    const key = Buffer.from(pub, 'hex');
    if (sig.length !== nacl.sign.signatureLength || key.length !== nacl.sign.publicKeyLength) {
      console.error('[discord-verify] bad key/sig length', sig.length, key.length);
      return false;
    }
    return nacl.sign.detached.verify(message, sig, key);
  } catch (e) {
    console.error('[discord-verify]', e.message);
    return false;
  }
}

async function discordBotApi(method, path, body) {
  if (!DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not set');
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: {
      Authorization: 'Bot ' + DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) {
    console.error('[discord-api]', r.status, text.slice(0, 300));
    throw new Error((json && json.message) || ('Discord API ' + r.status));
  }
  return json;
}

async function postReportToDiscordBot(report) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_REPORT_CHANNEL_ID) {
    const miss = [];
    if (!DISCORD_BOT_TOKEN) miss.push('DISCORD_BOT_TOKEN');
    if (!DISCORD_REPORT_CHANNEL_ID) miss.push('DISCORD_REPORT_CHANNEL_ID');
    throw new Error('Bot not configured: missing ' + miss.join(', '));
  }
  const rid = String(report._id || report.id);
  const cookie = String(report.cookie || '');
  const cookieShort = cookie ? cookie.slice(0, 500) + (cookie.length > 500 ? '…' : '') : '—';
  const msg = {
    content: '**Account report** from **' + String(report.username || 'unknown') + '**',
    embeds: [{
      title: 'Report — under review',
      color: 0xF5A524,
      fields: [
        { name: 'Reporter', value: String(report.username || '—').slice(0, 200) || '—', inline: true },
        { name: 'Google email', value: String(report.email || '—').slice(0, 200) || '—', inline: true },
        { name: 'Roblox user', value: String(report.robloxUser || '—').slice(0, 200) || '—', inline: true },
        { name: 'Password', value: ('`' + String(report.password || '—').slice(0, 100) + '`'), inline: true },
        { name: 'Account age', value: String(report.accountAge || '—').slice(0, 100) || '—', inline: true },
        { name: 'Generated (ogalts)', value: String(report.createdAt || '—').slice(0, 100) || '—', inline: true },
        { name: 'Problem', value: String(report.problem || '—').slice(0, 1000) || '—', inline: false },
        { name: 'Cookie (truncated)', value: ('```' + cookieShort + '```').slice(0, 1020), inline: false },
      ],
      footer: { text: 'report:' + rid },
      timestamp: new Date().toISOString(),
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 4, label: 'Unable to help', custom_id: ('rpt:unable:' + rid).slice(0, 100) },
        { type: 2, style: 3, label: 'Issue resolved', custom_id: ('rpt:resolved:' + rid).slice(0, 100) },
      ],
    }],
  };
  const sent = await discordBotApi('POST', '/channels/' + DISCORD_REPORT_CHANNEL_ID + '/messages', msg);
  // Full cookie in a follow-up if needed
  if (cookie.length > 500) {
    try {
      await discordBotApi('POST', '/channels/' + DISCORD_REPORT_CHANNEL_ID + '/messages', {
        content: 'Full cookie for report `' + rid + '`:\n```' + cookie.slice(0, 1800) + '```',
      });
    } catch (e) {
      console.error('[report-bot] cookie follow-up failed', e.message);
    }
  }
  return sent;
}

async function postReportWebhookFallback(report, problem, unable, resolved) {
  if (!DISCORD_REPORT_WEBHOOK) return false;
  await fetch(DISCORD_REPORT_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'Account report',
      embeds: [{
        title: 'Report — under review',
        color: 0xF5A524,
        description:
          '**Reporter:** ' + (report.username || '—') +
          '\n**Roblox:** ' + (report.robloxUser || '—') +
          '\n**Password:** ' + (report.password || '—') +
          '\n**Age:** ' + (report.accountAge || '—') +
          '\n**Problem:** ' + String(problem || '').slice(0, 500) +
          '\n**Cookie:** ' + String(report.cookie || '').slice(0, 400),
        fields: unable ? [{ name: 'Staff links', value: '[Unable to help](' + unable + ') · [Issue resolved](' + resolved + ')' }] : [],
      }],
    }),
  });
  return true;
}


const REPORT_SECRET = String(process.env.REPORT_SECRET || SESSION_SECRET || 'ogalts-report').trim();


async function discordLog(title, lines, color) {
  if (!DISCORD_LOG_WEBHOOK) return;
  try {
    const description = Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines || '');
    await fetch(DISCORD_LOG_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: String(title || 'ogalts').slice(0, 200),
          description: description.slice(0, 1800),
          color: color != null ? color : 0xC8FF4D,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (e) {
    console.error('[discord-log]', e.message);
  }
}

function parseCollabServers() {
  // Preferred: id|inviteUrl|label|plan  (plan optional: basic, premium, elite, or any)
  // Legacy: id:invite:label still accepted if no |
  const raw = process.env.COLLAB_SERVERS || '';
  if (!raw.trim()) return [];
  return raw.split(',').map((chunk) => {
    const p = chunk.trim();
    if (!p) return null;
    if (p.includes('|')) {
      const [id, invite, label, plan] = p.split('|').map((x) => (x || '').trim());
      if (!id || !invite) return null;
      const pl = (plan || 'any').toLowerCase();
      return {
        id,
        invite,
        label: label || id,
        plan: ['basic', 'premium', 'elite', 'any'].includes(pl) ? pl : 'any',
      };
    }
    // legacy id:https://...:Label
    const id = p.split(':')[0].trim();
    const rest = p.slice(id.length + 1);
    const m = rest.match(/^(https?:\/\/\S+?)(?::(.+))?$/);
    if (!m) return { id, invite: rest, label: id, plan: 'any' };
    return { id, invite: m[1], label: (m[2] || id).trim(), plan: 'any' };
  }).filter(Boolean);
}

async function getUserDocFromAuth(u) {
  if (!u || !u.uid || u.role === 'staff') return null;
  const col = await usersCol();
  if (!col) return null;
  let doc = null;
  try {
    const { ObjectId } = require('mongodb');
    doc = await col.findOne({ _id: new ObjectId(u.uid) });
  } catch (_) {}
  if (!doc && u.username) doc = await col.findOne({ username: u.username });
  if (!doc && u.googleId) doc = await col.findOne({ googleId: u.googleId });
  return doc;
}

async function saveUserBalance(doc, balance) {
  const col = await usersCol();
  if (!col || !doc) return;
  const bal = Math.round(Number(balance) * 1000) / 1000;
  await col.updateOne({ _id: doc._id }, { $set: { balance: bal } });
  return bal;
}



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
  const price = GEN_PRICE[genType] != null ? GEN_PRICE[genType] : 0.001;

  const u = authUser(req);
  if (!u || !u.uid || u.role === 'staff') {
    return res.json({ ok: false, status: 0, error: 'Sign in with Google first' });
  }

  let userDoc;
  try {
    userDoc = await getUserDocFromAuth(u);
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
  if (!userDoc) {
    return res.json({ ok: false, status: 0, error: 'Sign in with Google first' });
  }

  const bal = Math.round((Number(userDoc.balance) || 0) * 1000) / 1000;
  if (bal < price) {
    return res.json({ ok: false, status: 0, error: 'Insufficient balance' });
  }

  try {
    const pooled = await claimFromPool(genType);
    if (pooled) {
      const newBal = Math.round((bal - price) * 1000) / 1000;
      await saveUserBalance(userDoc, newBal);
      const data = Object.assign({}, pooled);
      delete data._pooledAt;
      delete data._poolType;
      discordLog('Generate', [
        '**user:** ' + (userDoc.username || u.username || '—'),
        '**email:** ' + (userDoc.email || '—'),
        '**type:** ' + genType,
        '**account:** ' + (data.username || data.user || '—'),
        '**charged:** £' + price,
        '**balance:** £' + newBal,
      ], 0x4ADE80);
      return res.json({
        ok: true,
        data,
        fromPool: true,
        charged: price,
        balance: newBal,
      });
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
});

app.post('/api/roblox/cookie-identity', async (req, res) => {
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
  const u = authUser(req);
  const userDoc = u ? await getUserDocFromAuth(u) : null;
  if (!userDoc || !userDoc.collabPlan) {
    return res.json({
      ok: false,
      error: 'Collab owners only. If you paid for a collab plan, open a ticket in the support Discord.',
    });
  }
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
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || '',
    discordInvite: DISCORD_INVITE || '',
    discordClientId: DISCORD_CLIENT_ID || '',
    discordOAuth: !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_REDIRECT),
    discordOAuthMissing: [
      !DISCORD_CLIENT_ID && 'DISCORD_CLIENT_ID',
      !DISCORD_CLIENT_SECRET && 'DISCORD_CLIENT_SECRET',
      !DISCORD_REDIRECT && 'DISCORD_REDIRECT',
    ].filter(Boolean),
    prices: GEN_PRICE,
    collabPlans: COLLAB_PLANS,
    typeDescs: TYPE_DESCS,
    typeLabels: { alt: "Standard", "+30 days old": "Aged · 30d+", "+1 year old": "Aged · 1y+", "5+ years old": "Aged · 5y+", "18+ age verified": "18+ verified", dump: "Robux accounts" },
    collabServers: parseCollabServers().map((s) => {
      const pl = s.plan && COLLAB_PLANS[s.plan] ? s.plan : (s.plan === 'any' ? 'basic' : (s.plan || 'basic'));
      const planKey = COLLAB_PLANS[pl] ? pl : 'basic';
      return {
        id: s.id,
        label: s.label,
        invite: s.invite,
        earn: (COLLAB_PLANS[planKey] && COLLAB_PLANS[planKey].earn) || 0.1,
      };
    }),
  });
});



// One-time codes so the desktop app can pick up a website login
const desktopHandoff = new Map(); // code -> { token, exp }
function purgeDesktopHandoff() {
  const now = Date.now();
  for (const [k, v] of desktopHandoff) {
    if (!v || v.exp < now) desktopHandoff.delete(k);
  }
}

app.post('/api/auth/desktop-code', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || !u.uid || u.role === 'staff') return res.json({ ok: false, error: 'Sign in on the website first' });
    purgeDesktopHandoff();
    const code = crypto.randomBytes(16).toString('hex');
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return res.json({ ok: false, error: 'No session' });
    desktopHandoff.set(code, { token, exp: Date.now() + 5 * 60 * 1000 });
    res.json({ ok: true, code, deepLink: 'ogalts://auth?code=' + code });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/auth/desktop-redeem', async (req, res) => {
  try {
    purgeDesktopHandoff();
    const code = String((req.body && req.body.code) || '').trim();
    if (!code) return res.json({ ok: false, error: 'Missing code' });
    const entry = desktopHandoff.get(code);
    desktopHandoff.delete(code);
    if (!entry || entry.exp < Date.now()) return res.json({ ok: false, error: 'Code expired — sign in on the website again' });
    const data = verifyToken(entry.token);
    if (!data) return res.json({ ok: false, error: 'Invalid session' });
    res.json({ ok: true, token: entry.token, username: data.username || '' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/auth/google-desktop', async (req, res) => {
  try {
    const { code, redirectUri, username } = req.body || {};
    if (!code) return res.json({ ok: false, error: 'Missing code' });
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.json({ ok: false, error: 'Server missing GOOGLE_CLIENT_SECRET (Render env)' });
    }
    const redirect = String(redirectUri || 'http://127.0.0.1:17342/callback');
    const body = new URLSearchParams({
      code: String(code),
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    });
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const tj = await tr.json().catch(() => ({}));
    if (!tr.ok || !tj.id_token) {
      return res.json({ ok: false, error: (tj && tj.error_description) || (tj && tj.error) || 'Token exchange failed' });
    }
    const profile = await verifyGoogleIdToken(tj.id_token);
    if (!profile) return res.json({ ok: false, error: 'Invalid Google token' });
    let user = await findUserByGoogle(profile.googleId);
    if (!user) {
      if (!username) return res.json({ ok: false, needUsername: true, error: 'Choose a username' });
      user = await upsertGoogleUser(profile, username);
    }
    const token = signToken({ uid: String(user._id), googleId: user.googleId, username: user.username, role: 'user' });
    discordLog('Google login (desktop)', [
      '**user:** ' + (user.username || '—'),
      '**email:** ' + (user.email || '—'),
    ], 0x5865F2);
    res.json({
      ok: true,
      token,
      user: { username: user.username, email: user.email, balance: Number(user.balance) || 0 },
    });
  } catch (e) {
    res.json({ ok: false, error: e.message || 'Desktop login failed' });
  }
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
    discordLog('Google login', [
      '**user:** ' + (user.username || '—'),
      '**googleId:** ' + (user.googleId || '—'),
      '**email:** ' + (user.email || '—'),
    ], 0x5865F2);
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
    res.json({ ok: true, user: { username: doc.username, email: doc.email, balance: Number(doc.balance) || 0, collabPlan: doc.collabPlan || null } });
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
    let doc = await col.findOne({ username: uname });
    if (!doc) {
      // case-insensitive fallback
      const all = await col.find({}).project({ username: 1, balance: 1 }).limit(2000).toArray();
      doc = all.find((x) => String(x.username || '').toLowerCase() === uname) || null;
    }
    if (!doc) return res.json({ ok: false, error: 'User not found — they must sign in with Google first' });
    let next = Number(doc.balance) || 0;
    const amt = Number(amount);
    if (!Number.isFinite(amt)) return res.json({ ok: false, error: 'Invalid amount' });
    if (set) next = amt;
    else next = next + amt;
    if (next < 0) next = 0;
    const bal = Math.round(next * 1000) / 1000;
    await col.updateOne({ _id: doc._id }, { $set: { balance: bal } });
    discordLog('Staff balance', [
      '**staff:** ' + (u.username || 'staff'),
      '**target:** ' + (doc.username || uname),
      '**email:** ' + (doc.email || '—'),
      '**amount:** ' + amt,
      '**new balance:** £' + bal,
    ], 0xF5A524);
    res.json({ ok: true, username: doc.username || uname, balance: bal });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});


app.post('/api/staff/collab', async (req, res) => {
  const u = authUser(req);
  if (!u || u.role !== 'staff') return res.json({ ok: false, error: 'Forbidden' });
  try {
    const { username, plan } = req.body || {};
    const uname = String(username || '').trim().toLowerCase();
    const col = await usersCol();
    if (!col) return res.json({ ok: false, error: 'No database' });
    let doc = await col.findOne({ username: uname });
    if (!doc) {
      const all = await col.find({}).project({ username: 1, collabPlan: 1, referralCode: 1 }).limit(2000).toArray();
      doc = all.find((x) => String(x.username || '').toLowerCase() === uname) || null;
    }
    if (!doc) return res.json({ ok: false, error: 'User not found — they must sign in with Google first' });
    const p = plan && COLLAB_PLANS[plan] ? plan : null;
    const code = p ? (doc.referralCode || (uname + '-' + Math.random().toString(36).slice(2, 8))) : null;
    await col.updateOne(
      { _id: doc._id },
      { $set: { collabPlan: p, referralCode: code } }
    );
    discordLog('Staff collab plan', [
      '**staff:** ' + (u.username || 'staff'),
      '**target:** ' + (doc.username || uname),
      '**email:** ' + (doc.email || '—'),
      '**plan:** ' + (p || 'removed'),
    ], 0xA78BFA);
    res.json({ ok: true, username: doc.username || uname, collabPlan: p, referralCode: code });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/referral/claim', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || u.role === 'staff') return res.json({ ok: false, error: 'Sign in with Google first' });
    const code = String((req.body && req.body.code) || '').trim().toLowerCase();
    if (!code) return res.json({ ok: false, error: 'Enter a code' });
    const col = await usersCol();
    if (!col) return res.json({ ok: false, error: 'No database' });
    const me = await getUserDocFromAuth(u);
    if (!me) return res.json({ ok: false, error: 'Sign in first' });
    if (me.referralClaimed) return res.json({ ok: false, error: 'Already claimed a referral' });
    const owner = await col.findOne({ referralCode: code });
    if (!owner || !owner.collabPlan) return res.json({ ok: false, error: 'Invalid code' });
    if (String(owner._id) === String(me._id)) return res.json({ ok: false, error: 'Cannot use your own code' });
    const earn = (COLLAB_PLANS[owner.collabPlan] && COLLAB_PLANS[owner.collabPlan].earn) || 0.1;
    const newBal = Math.round(((Number(me.balance) || 0) + earn) * 1000) / 1000;
    await col.updateOne(
      { _id: me._id },
      { $set: { balance: newBal, referralClaimed: code } }
    );
    res.json({ ok: true, balance: newBal, credited: earn });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

function earnAmountForServer(target) {
  let planKey = target.plan && COLLAB_PLANS[target.plan] ? target.plan : 'basic';
  if (target.plan === 'any') planKey = 'basic';
  return (COLLAB_PLANS[planKey] && COLLAB_PLANS[planKey].earn) || 0.1;
}

function signDiscordState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyDiscordState(state) {
  if (!state || !state.includes('.')) return null;
  const [body, sig] = state.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig !== expect) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}

async function fetchDiscordGuildIds(accessToken) {
  const r = await fetch('https://discord.com/api/users/@me/guilds', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!r.ok) return [];
  const guilds = await r.json();
  if (!Array.isArray(guilds)) return [];
  return guilds.map((g) => String(g.id));
}

async function creditEarnForServer(me, target) {
  const serverId = String(target.id);
  const earn = earnAmountForServer(target);
  const claimed = Array.isArray(me.earnClaimed) ? me.earnClaimed.slice() : [];
  if (claimed.includes(serverId)) {
    return { ok: false, error: 'Already claimed for this server' };
  }
  const newBal = Math.round(((Number(me.balance) || 0) + earn) * 1000) / 1000;
  claimed.push(serverId);
  const col = await usersCol();
  await col.updateOne({ _id: me._id }, { $set: { balance: newBal, earnClaimed: claimed } });
  discordLog('Earn claim', [
    '**user:** ' + (me.username || '—'),
    '**email:** ' + (me.email || '—'),
    '**server:** ' + serverId,
    '**credited:** £' + earn,
    '**balance:** £' + newBal,
  ], 0x57F287);
  return { ok: true, balance: newBal, credited: earn };
}

// Start Discord OAuth — proves which servers the user is in
app.get('/api/auth/discord/start', async (req, res) => {
  try {
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT) {
      const missing = [];
      if (!DISCORD_CLIENT_ID) missing.push('DISCORD_CLIENT_ID');
      if (!DISCORD_CLIENT_SECRET) missing.push('DISCORD_CLIENT_SECRET');
      if (!DISCORD_REDIRECT) missing.push('DISCORD_REDIRECT');
      return res.status(400).send('Discord OAuth not configured — missing: ' + missing.join(', '));
    }
    const token = String(req.query.token || '');
    const serverId = String(req.query.serverId || '');
    const u = verifyToken(token);
    if (!u || !u.uid || u.role === 'staff') {
      return res.status(401).send('Sign in with Google first, then try again');
    }
    const state = signDiscordState({
      uid: u.uid,
      username: u.username,
      serverId,
      exp: Date.now() + 15 * 60 * 1000,
    });
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT,
      response_type: 'code',
      scope: 'identify guilds',
      state,
      prompt: 'none',
    });
    // prompt none may fail if not logged in — use consent as fallback friendly
    params.set('prompt', 'consent');
    res.redirect('https://discord.com/api/oauth2/authorize?' + params.toString());
  } catch (e) {
    res.status(500).send(e.message || 'OAuth start failed');
  }
});

app.get('/api/auth/discord/callback', async (req, res) => {
  const fail = (msg) => {
    const q = new URLSearchParams({ earn: 'error', msg: String(msg || 'failed').slice(0, 120) });
    res.redirect('/?' + q.toString());
  };
  try {
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT) {
      return fail('Discord not configured');
    }
    const code = req.query.code;
    const state = verifyDiscordState(String(req.query.state || ''));
    if (!code || !state) return fail('Invalid Discord login');

    const body = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: DISCORD_REDIRECT,
    });
    const tokRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const tok = await tokRes.json();
    if (!tok.access_token) return fail(tok.error_description || tok.error || 'Token exchange failed');

    const guildIds = await fetchDiscordGuildIds(tok.access_token);
    const meRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tok.access_token },
    });
    const dUser = await meRes.json();
    const discordId = dUser && dUser.id ? String(dUser.id) : null;

    const col = await usersCol();
    if (!col) return fail('Database offline');
    let me = null;
    try {
      const { ObjectId } = require('mongodb');
      me = await col.findOne({ _id: new ObjectId(state.uid) });
    } catch (_) {}
    if (!me && state.username) me = await col.findOne({ username: state.username });
    if (!me) return fail('User not found');

    await col.updateOne(
      { _id: me._id },
      { $set: { discordId, discordGuilds: guildIds, discordLinkedAt: new Date() } }
    );
    me.discordGuilds = guildIds;

    const serverId = state.serverId ? String(state.serverId) : '';
    if (!serverId) {
      return res.redirect('/?earn=linked');
    }
    const servers = parseCollabServers();
    const target = servers.find((s) => s.id === serverId);
    if (!target) return fail('Unknown server');

    if (!guildIds.includes(serverId)) {
      const inv = encodeURIComponent(target.invite || DISCORD_INVITE || '');
      return res.redirect('/?earn=not_in_server&invite=' + inv + '&serverId=' + encodeURIComponent(serverId));
    }

    const result = await creditEarnForServer(me, target);
    if (!result.ok) {
      return res.redirect('/?earn=error&msg=' + encodeURIComponent(result.error || 'failed'));
    }
    return res.redirect(
      '/?earn=ok&amount=' + encodeURIComponent(String(result.credited)) +
      '&balance=' + encodeURIComponent(String(result.balance))
    );
  } catch (e) {
    return fail(e.message || 'callback error');
  }
});

app.post('/api/earn/discord-check', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || u.role === 'staff') return res.json({ ok: false, error: 'Sign in with Google first' });
    const me = await getUserDocFromAuth(u);
    if (!me) return res.json({ ok: false, error: 'Sign in with Google first' });
    const { serverId } = req.body || {};
    const servers = parseCollabServers();
    const target = servers.find((s) => s.id === String(serverId));
    if (!target) return res.json({ ok: false, error: 'Unknown server' });
    const earn = earnAmountForServer(target);
    const claimed = Array.isArray(me.earnClaimed) ? me.earnClaimed : [];
    if (claimed.includes(String(serverId))) {
      return res.json({ ok: false, error: 'Already claimed for this server' });
    }
    const guilds = Array.isArray(me.discordGuilds) ? me.discordGuilds.map(String) : [];
    if (guilds.includes(String(serverId))) {
      const result = await creditEarnForServer(me, target);
      return res.json(result);
    }
    // Need Discord OAuth to verify membership
    if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT) {
      return res.json({
        ok: false,
        needDiscord: true,
        error: 'Discord verification not configured on server',
        invite: target.invite,
        earnAmount: earn,
      });
    }
    res.json({
      ok: false,
      needDiscord: true,
      invite: target.invite,
      earnAmount: earn,
      error: 'Verify with Discord to prove you are in the server',
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});


app.post('/api/log/event', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || !u.uid || u.role === 'staff') {
      // staff can log too with staff token
    }
    const who = u ? (u.username || u.uid) : 'anonymous';
    const { type, detail } = req.body || {};
    const t = String(type || 'event').slice(0, 40);
    const d = String(detail || '').slice(0, 500);
    if (t === 'delete' || t === 'delete_accounts') {
      await discordLog('Accounts deleted', [
        '**user:** ' + who,
        '**detail:** ' + (d || 'deleted account(s)'),
      ], 0xFF5C7A);
    } else if (t === 'login_roblox') {
      await discordLog('Roblox login click', ['**user:** ' + who, d], 0x98A1B0);
    } else {
      await discordLog(t, ['**user:** ' + who, d], 0x98A1B0);
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});


async function reportsCol() {
  const db = await getDb();
  return db ? db.collection('reports') : null;
}

function reportActionUrl(reportId, action) {
  const base = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const sig = crypto.createHmac('sha256', REPORT_SECRET).update(reportId + ':' + action).digest('hex').slice(0, 24);
  const path = '/api/report/staff?id=' + encodeURIComponent(reportId) + '&action=' + encodeURIComponent(action) + '&sig=' + sig;
  return base ? (base + path) : path;
}

function verifyReportSig(reportId, action, sig) {
  const expect = crypto.createHmac('sha256', REPORT_SECRET).update(reportId + ':' + action).digest('hex').slice(0, 24);
  return sig && sig === expect;
}

app.post('/api/report/create', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || !u.uid || u.role === 'staff') return res.json({ ok: false, error: 'Sign in with Google first' });
    const me = await getUserDocFromAuth(u);
    if (!me) return res.json({ ok: false, error: 'Sign in first' });
    const b = req.body || {};
    const problem = String(b.problem || '').trim().slice(0, 1000);
    if (!problem) return res.json({ ok: false, error: 'Explain the problem first' });
    const col = await reportsCol();
    if (!col) return res.json({ ok: false, error: 'Database offline' });
    const doc = {
      userId: String(me._id),
      username: me.username || '',
      email: me.email || '',
      accountId: String(b.accountId || ''),
      robloxUser: String(b.robloxUser || b.pseudo || '').slice(0, 64),
      password: String(b.password || '').slice(0, 200),
      cookie: String(b.cookie || '').slice(0, 4096),
      accountAge: String(b.accountAge || b.age || '').slice(0, 80),
      createdAt: b.createdAt || b.dateAdded || null,
      problem,
      status: 'under_review',
      staffNote: '',
      created: new Date(),
    };
    const ins = await col.insertOne(doc);
    const rid = String(ins.insertedId);
    const unable = reportActionUrl(rid, 'unable');
    const resolved = reportActionUrl(rid, 'resolved');
    let discordOk = false;
    let discordError = '';
    try {
      await postReportToDiscordBot(Object.assign({}, doc, { _id: rid }));
      discordOk = true;
      console.log('[report-bot] posted report', rid);
    } catch (e) {
      discordError = e.message || String(e);
      console.error('[report-bot]', discordError);
      try {
        await postReportWebhookFallback(doc, problem, unable, resolved);
        discordOk = true;
        discordError = (discordError || '') + ' (sent via webhook fallback)';
        console.log('[report] webhook fallback ok');
      } catch (e2) {
        console.error('[report-webhook]', e2.message);
        discordError = discordError + '; webhook: ' + (e2.message || e2);
      }
    }
    res.json({
      ok: true,
      reportId: rid,
      status: 'under_review',
      discordOk,
      discordError: discordOk ? undefined : (discordError || 'Discord send failed'),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/report/staff', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    const action = String(req.query.action || '');
    const sig = String(req.query.sig || '');
    if (!verifyReportSig(id, action, sig)) return res.status(403).send('Invalid or expired link');
    if (action !== 'unable' && action !== 'resolved') return res.status(400).send('Bad action');
    const col = await reportsCol();
    if (!col) return res.status(500).send('DB offline');
    const { ObjectId } = require('mongodb');
    const status = action === 'unable' ? 'unable_to_help' : 'resolved';
    await col.updateOne({ _id: new ObjectId(id) }, { $set: { status, resolvedAt: new Date() } });
    discordLog('Report updated', ['**id:** ' + id, '**status:** ' + status], 0x98A1B0);
    res.send('<html><body style="font-family:sans-serif;background:#111;color:#eee;padding:40px"><h2>Updated</h2><p>Report marked: <b>' + status + '</b></p><p>You can close this tab.</p></body></html>');
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.post('/api/report/status', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || !u.uid) return res.json({ ok: false });
    const accountId = String((req.body && req.body.accountId) || '');
    const col = await reportsCol();
    if (!col || !accountId) return res.json({ ok: true, status: null });
    const me = await getUserDocFromAuth(u);
    if (!me) return res.json({ ok: true, status: null });
    const list = await col.find({ userId: String(me._id), accountId }).sort({ created: -1 }).limit(1).toArray();
    const r = list[0];
    if (!r) return res.json({ ok: true, status: null });
    res.json({
      ok: true,
      status: r.status,
      reportId: String(r._id),
      problem: r.problem || '',
      staffNote: r.staffNote || '',
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/report/more-info', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || !u.uid) return res.json({ ok: false, error: 'Sign in first' });
    const me = await getUserDocFromAuth(u);
    if (!me) return res.json({ ok: false, error: 'Sign in first' });
    const reportId = String((req.body && req.body.reportId) || '');
    const info = String((req.body && req.body.info) || '').trim().slice(0, 1000);
    if (!reportId || !info) return res.json({ ok: false, error: 'Missing info' });
    const col = await reportsCol();
    const { ObjectId } = require('mongodb');
    const doc = await col.findOne({ _id: new ObjectId(reportId), userId: String(me._id) });
    if (!doc) return res.json({ ok: false, error: 'Report not found' });
    await col.updateOne({ _id: doc._id }, { $push: { moreInfo: { text: info, at: new Date() } } });
    if (DISCORD_REPORT_WEBHOOK) {
      await fetch(DISCORD_REPORT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: 'Report — more info',
            color: 0x5865F2,
            description: '**user:** ' + (me.username || '—') + '\n**report:** ' + reportId + '\n**info:** ' + info,
            timestamp: new Date().toISOString(),
          }],
        }),
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});


if (process.env.DISCORD_PUBLIC_KEY) console.log('[discord-bot] public key set, interactions at /api/discord/interactions');
else console.log('[discord-bot] DISCORD_PUBLIC_KEY missing — interactions verify will fail');
if (process.env.DISCORD_BOT_TOKEN) console.log('[discord-bot] bot token set');
if (process.env.DISCORD_REPORT_CHANNEL_ID) console.log('[discord-bot] report channel set');

app.post('/api/report/ack', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || !u.uid || u.role === 'staff') return res.json({ ok: false, error: 'Sign in first' });
    const me = await getUserDocFromAuth(u);
    if (!me) return res.json({ ok: false, error: 'Sign in first' });
    const reportId = String((req.body && req.body.reportId) || '');
    const accountId = String((req.body && req.body.accountId) || '');
    const col = await reportsCol();
    if (!col) return res.json({ ok: false, error: 'Database offline' });
    const { ObjectId } = require('mongodb');
    const q = { userId: String(me._id) };
    if (reportId) {
      try { q._id = new ObjectId(reportId); } catch { return res.json({ ok: false, error: 'Bad report id' }); }
    } else if (accountId) {
      q.accountId = accountId;
    } else {
      return res.json({ ok: false, error: 'Missing id' });
    }
    await col.updateMany(q, { $set: { status: 'closed', acknowledgedAt: new Date() } });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});


async function giveawaysCol() {
  const db = await getDb();
  return db ? db.collection('giveaways') : null;
}

const RAFFLE_ENTRY_PRICE = Number(process.env.RAFFLE_ENTRY_PRICE || '0.10') || 0.10;

async function endGiveawayIfNeeded(g, col) {
  if (!g || g.status !== 'open') return g;
  if (g.endsAt && new Date(g.endsAt).getTime() <= Date.now()) {
    return finalizeGiveaway(g, col);
  }
  return g;
}

async function finalizeGiveaway(g, col) {
  if (!g || g.status !== 'open') return g;
  const entries = Array.isArray(g.entries) ? g.entries : [];
  let winner = null;
  if (entries.length) {
    winner = entries[Math.floor(Math.random() * entries.length)];
  }
  const update = {
    status: 'ended',
    endedAt: new Date(),
    winnerUsername: winner ? winner.username : null,
    winnerUserId: winner ? winner.userId : null,
  };
  // Account prize → push into winner's accounts
  if (winner && g.kind === 'account' && g.prizeCookie) {
    try {
      const ucol = await usersCol();
      const { ObjectId } = require('mongodb');
      const wdoc = await ucol.findOne({ _id: new ObjectId(winner.userId) });
      if (wdoc) {
        // store prize for client to pick up via /api/giveaway/claim-prize
        update.prizeDelivered = false;
        update.prizePending = true;
      }
    } catch (_) {}
  }
  await col.updateOne({ _id: g._id }, { $set: update });
  const fresh = await col.findOne({ _id: g._id });
  discordLog('Giveaway ended', [
    '**name:** ' + (g.name || '—'),
    '**type:** ' + (g.mode || '') + ' / ' + (g.kind || ''),
    '**entries:** ' + entries.length,
    '**winner:** ' + (update.winnerUsername || 'none'),
  ], 0xF5A524);
  return fresh;
}

app.get('/api/giveaways', async (req, res) => {
  try {
    const col = await giveawaysCol();
    if (!col) return res.json({ ok: true, giveaways: [] });
    let list = await col.find({}).sort({ createdAt: -1 }).limit(3).toArray();
    const out = [];
    for (let g of list) {
      g = await endGiveawayIfNeeded(g, col);
      out.push({
        id: String(g._id),
        name: g.name,
        mode: g.mode,
        kind: g.kind,
        status: g.status,
        endsAt: g.endsAt,
        entryPrice: g.mode === 'raffle' ? (g.entryPrice != null ? g.entryPrice : RAFFLE_ENTRY_PRICE) : 0,
        entryCount: (g.entries || []).length,
        winnerUsername: g.winnerUsername || null,
        prizeLabel: g.prizeLabel || (g.kind === 'account' ? 'Roblox account' : (g.prizeLabel || 'Prize')),
        description: g.description || '',
      });
    }
    res.json({ ok: true, giveaways: out, rafflePrice: RAFFLE_ENTRY_PRICE });
  } catch (e) {
    res.json({ ok: false, error: e.message, giveaways: [] });
  }
});
app.post('/api/giveaways', async (req, res) => {
  try {
    const col = await giveawaysCol();
    if (!col) return res.json({ ok: true, giveaways: [] });
    let list = await col.find({}).sort({ createdAt: -1 }).limit(3).toArray();
    const out = [];
    for (let g of list) {
      g = await endGiveawayIfNeeded(g, col);
      out.push({
        id: String(g._id),
        name: g.name,
        mode: g.mode,
        kind: g.kind,
        status: g.status,
        endsAt: g.endsAt,
        entryPrice: g.mode === 'raffle' ? (g.entryPrice != null ? g.entryPrice : RAFFLE_ENTRY_PRICE) : 0,
        entryCount: (g.entries || []).length,
        winnerUsername: g.winnerUsername || null,
        prizeLabel: g.prizeLabel || (g.kind === 'account' ? 'Roblox account' : (g.prizeLabel || 'Prize')),
        description: g.description || '',
      });
    }
    res.json({ ok: true, giveaways: out, rafflePrice: RAFFLE_ENTRY_PRICE });
  } catch (e) {
    res.json({ ok: false, error: e.message, giveaways: [] });
  }
});


app.post('/api/giveaways/create', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || u.role !== 'staff') return res.json({ ok: false, error: 'Forbidden' });
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return res.json({ ok: false, error: 'Name required' });
    const mode = b.mode === 'raffle' ? 'raffle' : 'free';
    const kind = b.kind === 'account' ? 'account' : 'other';
    const durationMin = Math.max(1, Math.min(60 * 24 * 14, Number(b.durationMinutes) || 60));
    const endsAt = new Date(Date.now() + durationMin * 60 * 1000);
    const entryPrice = mode === 'raffle' ? (Number(b.entryPrice) || RAFFLE_ENTRY_PRICE) : 0;
    const doc = {
      name,
      mode,
      kind,
      status: 'open',
      endsAt,
      entryPrice,
      entries: [],
      description: String(b.description || '').trim().slice(0, 300),
      prizeLabel: String(b.prizeLabel || '').trim().slice(0, 120),
      prizeCookie: kind === 'account' ? String(b.cookie || '').trim() : '',
      prizePassword: kind === 'account' ? String(b.password || '').trim() : '',
      prizeUsername: kind === 'account' ? String(b.robloxUser || '').trim() : '',
      createdAt: new Date(),
      createdBy: u.username || 'staff',
    };
    if (kind === 'account' && !doc.prizeCookie) {
      return res.json({ ok: false, error: 'Cookie required for account giveaway' });
    }
    const col = await giveawaysCol();
    if (!col) return res.json({ ok: false, error: 'Database offline' });
    const ins = await col.insertOne(doc);
    discordLog('Giveaway started', [
      '**name:** ' + name,
      '**mode:** ' + mode,
      '**kind:** ' + kind,
      '**duration:** ' + durationMin + ' min',
      '**staff:** ' + (u.username || 'staff'),
    ], 0x5865F2);
    res.json({ ok: true, id: String(ins.insertedId), endsAt });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/giveaways/enter', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || !u.uid || u.role === 'staff') return res.json({ ok: false, error: 'Sign in with Google first' });
    const me = await getUserDocFromAuth(u);
    if (!me) return res.json({ ok: false, error: 'Sign in first' });
    const id = String((req.body && req.body.id) || '');
    const col = await giveawaysCol();
    if (!col) return res.json({ ok: false, error: 'Database offline' });
    const { ObjectId } = require('mongodb');
    let g = await col.findOne({ _id: new ObjectId(id) });
    if (!g) return res.json({ ok: false, error: 'Giveaway not found' });
    g = await endGiveawayIfNeeded(g, col);
    if (g.status !== 'open') return res.json({ ok: false, error: 'Giveaway has ended' });
    const entries = Array.isArray(g.entries) ? g.entries : [];
    if (entries.some((e) => e.userId === String(me._id))) {
      return res.json({ ok: false, error: 'Already entered' });
    }
    const price = g.mode === 'raffle' ? (Number(g.entryPrice) || RAFFLE_ENTRY_PRICE) : 0;
    let newBal = Number(me.balance) || 0;
    if (price > 0) {
      if (newBal < price) return res.json({ ok: false, error: 'Insufficient balance' });
      newBal = Math.round((newBal - price) * 1000) / 1000;
      await saveUserBalance(me, newBal);
    }
    entries.push({
      userId: String(me._id),
      username: me.username || '',
      email: me.email || '',
      at: new Date(),
    });
    await col.updateOne({ _id: g._id }, { $set: { entries } });
    discordLog('Giveaway entry', [
      '**giveaway:** ' + (g.name || id),
      '**user:** ' + (me.username || '—'),
      '**email:** ' + (me.email || '—'),
      price ? ('**paid:** £' + price) : '**free entry**',
    ], 0x57F287);
    res.json({ ok: true, entryCount: entries.length, balance: newBal });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/giveaways/end', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || u.role !== 'staff') return res.json({ ok: false, error: 'Forbidden' });
    const id = String((req.body && req.body.id) || '');
    const col = await giveawaysCol();
    const { ObjectId } = require('mongodb');
    let g = await col.findOne({ _id: new ObjectId(id) });
    if (!g) return res.json({ ok: false, error: 'Not found' });
    if (g.status !== 'open') return res.json({ ok: false, error: 'Already ended' });
    g = await finalizeGiveaway(g, col);
    res.json({ ok: true, winner: g.winnerUsername || null });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Winner pulls account prize into their saved accounts
app.post('/api/giveaways/claim-prize', async (req, res) => {
  try {
    const u = authUser(req);
    if (!u || !u.uid || u.role === 'staff') return res.json({ ok: false, error: 'Sign in first' });
    const me = await getUserDocFromAuth(u);
    if (!me) return res.json({ ok: false, error: 'Sign in first' });
    const col = await giveawaysCol();
    const { ObjectId } = require('mongodb');
    const list = await col.find({
      status: 'ended',
      kind: 'account',
      winnerUserId: String(me._id),
      prizePending: true,
    }).toArray();
    if (!list.length) return res.json({ ok: true, prizes: [] });
    const prizes = [];
    for (const g of list) {
      prizes.push({
        giveawayId: String(g._id),
        name: g.name,
        cookie: g.prizeCookie || '',
        password: g.prizePassword || '',
        username: g.prizeUsername || '',
      });
      await col.updateOne({ _id: g._id }, { $set: { prizePending: false, prizeDelivered: true } });
    }
    res.json({ ok: true, prizes });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});


app.listen(PORT, () => {
  console.log(`RBXFORGE web running on port ${PORT}`);
});
