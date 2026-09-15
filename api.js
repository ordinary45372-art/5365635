// Full compatibility layer – matches every window.api.* call in renderer2.js
async function fetchJson(path, body = {}) {
  try {
    const res = await fetch('/api' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body == null ? {} : body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[api]', path, res.status, text.slice(0, 200));
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return await res.json();
  } catch (e) {
    console.error('[api]', path, e.message);
    throw e;
  }
}

window.api = {
  // ---------- Persistence ----------
  load: () => fetchJson('/accounts/load'),
  save: (accounts) => fetchJson('/accounts/save', { accounts }),
  export: (accounts) => fetchJson('/accounts/export', { accounts }),
  importTxt: () => fetchJson('/accounts/import-txt'),

  // ---------- Bloxgen ----------
  bloxgenBalance: (apiKey) => fetchJson('/bloxgen/balance', { apiKey }),
  bloxgenDailyLimit: (payload) => fetchJson('/bloxgen/daily-limit', payload),
  bloxgenGenerate: (payload) => fetchJson('/bloxgen/generate', payload),

  // ---------- Roblox core ----------
  cookieIdentity: (cookie) => fetchJson('/roblox/cookie-identity', { cookie }),
  cookieAliveCheck: (cookie) => fetchJson('/roblox/cookie-alive-check', { cookie }),
  ageInfo: (payload) => fetchJson('/roblox/age-info', payload),
  enrich: (username) => fetchJson('/roblox/enrich', { username }),
  enrichBatch: (usernames) => fetchJson('/roblox/enrich-batch', { usernames }),
  refreshInfo: (payload) => fetchJson('/roblox/refresh-info', payload),
  getCookie: (accountId) => fetchJson('/roblox/get-cookie', { accountId }),
  setCookie: (payload) => fetchJson('/roblox/set-cookie', payload),
  robuxRap: (payload) => fetchJson('/roblox/robux-rap', payload),
  inventory: (payload) => fetchJson('/roblox/inventory', payload),
  inventoryFull: (payload) => fetchJson('/roblox/inventory-full', payload),
  assetThumbs: (assetIds) => fetchJson('/roblox/asset-thumbs', { assetIds }),
  bundleThumbs: (bundleIds) => fetchJson('/roblox/bundle-thumbs', { bundleIds }),
  gamepassThumbs: (ids) => fetchJson('/roblox/gamepass-thumbs', { ids }),
  inventoryValue: (payload) => fetchJson('/roblox/inventory-value', payload),
  userBadges: (payload) => fetchJson('/roblox/user-badges', payload),
  placesUniverses: (placeIds) => fetchJson('/roblox/places-universes', { placeIds }),
  refreshCookie: (cookie) => fetchJson('/roblox/refresh-cookie', { cookie }),
  friendRequest: (payload) => fetchJson('/roblox/friend-request', payload),
  followUser: (payload) => fetchJson('/roblox/follow-user', payload),
  changePassword: (payload) => fetchJson('/roblox/change-password', payload),
  presence: (payload) => fetchJson('/roblox/presence', payload),
  recentlyPlayed: (payload) => fetchJson('/roblox/recently-played', payload),
  detect: (accountId) => fetchJson('/roblox/detect', { accountId }),
  searchGames: (query) => fetchJson('/roblox/search-games', { query }),
  resolveGame: (id) => fetchJson('/game/resolve', { id }),

  // ---------- Vault / Games ----------
  vaultLoad: () => fetchJson('/vault/load'),
  vaultSave: (data) => fetchJson('/vault/save', data),
  gamesLoad: () => fetchJson('/games/load'),
  gamesSave: (data) => fetchJson('/games/save', data),

  // ---------- Security (master password) ----------
  secureStatus: () => fetchJson('/secure/status'),
  unlock: (password) => fetchJson('/secure/unlock', { password }),
  setMasterPassword: (password, accounts) =>
    fetchJson('/secure/set', { password, accounts }),
  removeMasterPassword: (accounts) =>
    fetchJson('/secure/remove', { accounts }),

  // ---------- App / UI helpers ----------
  version: () => fetchJson('/app/version').then((v) => (typeof v === 'string' ? v : '1.0.0-web')),
  setTheme: (theme) => fetchJson('/theme/set', { theme }),
  setConfig: (cfg) => fetchJson('/config/set', cfg).catch(() => true),
  openUrl: (url) => {
    if (typeof url === 'string' && url.startsWith('http')) window.open(url, '_blank');
    return Promise.resolve(true);
  },
  openDataFolder: () => {
    alert('Data is stored on the server (data/accounts.json). No local folder on the website version.');
    return Promise.resolve(true);
  },
  logoutAll: (ids) => Promise.resolve(Array.isArray(ids) ? ids.length : 0),
  robloxLogin: (payload) => {
    window.open('https://www.roblox.com/home', '_blank');
    return Promise.resolve({ ok: true });
  },
  updateCheck: () => {
    alert('Website version – redeploy on Render to update.');
    return Promise.resolve(true);
  },

  // Confirm dialog used by delete actions
  confirm: (msg, buttons) => {
    const ok = window.confirm(msg || 'Are you sure?');
    return Promise.resolve(ok ? 0 : 1);
  },

  // Event-style stubs (Electron used ipc events; web has no auto-updater)
  onUpdateAvailable: () => {},
  onUpdateNone: () => {},
  onUpdateDownloaded: () => {},
  onUpdateError: () => {},
  onDetected: () => {},
};
