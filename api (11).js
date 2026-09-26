// Full compatibility layer – matches every window.api.* call in renderer2.js
window.__authToken = window.__authToken || localStorage.getItem('ogalts_token') || '';
window.__staffToken = window.__staffToken || localStorage.getItem('ogalts_staff_token') || '';

async function fetchJson(path, body = {}, opts = {}) {
  try {
    const useStaff = !!opts.staff || path.startsWith('/staff/') || path === '/auth/staff';
    const token = useStaff
      ? (window.__staffToken || '')
      : (window.__authToken || '');
    // staff login itself has no token yet
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch('/api' + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body == null ? {} : body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[api]', path, res.status, text.slice(0, 200));
      throw new Error('HTTP ' + res.status + ': ' + text);
    }
    return await res.json();
  } catch (e) {
    console.error('[api]', path, e.message);
    throw e;
  }
}

window.api = {
  // Google user token — used for generate, accounts, etc.
  setToken: (t) => {
    window.__authToken = t || '';
    if (t) localStorage.setItem('ogalts_token', t);
    else localStorage.removeItem('ogalts_token');
  },
  // Staff token — separate so staff login does NOT wipe Google session
  setStaffToken: (t) => {
    window.__staffToken = t || '';
    if (t) localStorage.setItem('ogalts_staff_token', t);
    else localStorage.removeItem('ogalts_staff_token');
  },
  authGoogle: (credential, username) => fetchJson('/auth/google', { credential, username }),
  authMe: () => fetchJson('/auth/me', {}),
  authStaff: (username, password) => fetchJson('/auth/staff', { username, password }, { staff: true }),
  staffUsers: () => fetchJson('/staff/users', {}, { staff: true }),
  staffBalance: (payload) => fetchJson('/staff/balance', payload, { staff: true }),
  staffCollab: (payload) => fetchJson('/staff/collab', payload, { staff: true }),
  staffStock: () => fetchJson('/staff/stock', {}, { staff: true }),
  staffRetryReset: (payload) => fetchJson('/staff/retry-reset', payload, { staff: true }),
  staffRetryResetBatch: (payload) => fetchJson('/staff/retry-reset-batch', payload, { staff: true }),
  staffFailedDelete: (payload) => fetchJson('/staff/failed-delete', payload, { staff: true }),
  referralClaim: (code) => fetchJson('/referral/claim', { code }),
  earnDiscordCheck: (payload) => fetchJson('/earn/discord-check', payload),
  logEvent: (type, detail) => fetchJson('/log/event', { type, detail }),
  reportCreate: (payload) => fetchJson('/report/create', payload),
  reportStatus: (accountId) => fetchJson('/report/status', { accountId }),
  reportMoreInfo: (reportId, info) => fetchJson('/report/more-info', { reportId, info }),
  reportAck: (reportId, accountId) => fetchJson('/report/ack', { reportId, accountId }),
  giveawaysList: () => fetchJson('/giveaways', {}),
  giveawayEnter: (id) => fetchJson('/giveaways/enter', { id }),
  giveawayCreate: (payload) => fetchJson('/giveaways/create', payload, { staff: true }),
  giveawayEnd: (id) => fetchJson('/giveaways/end', { id }, { staff: true }),
  giveawayClaim: () => fetchJson('/giveaways/claim-prize', {}),
  desktopCode: () => fetchJson('/auth/desktop-code', {}),
  desktopRedeem: (code) => fetchJson('/auth/desktop-redeem', { code }),

  load: () => fetchJson('/accounts/load'),
  save: (accounts) => fetchJson('/accounts/save', { accounts }),
  export: (accounts) => fetchJson('/accounts/export', { accounts }),
  importTxt: () => fetchJson('/accounts/import-txt'),

  bloxgenBalance: (apiKey) => fetchJson('/bloxgen/balance', { apiKey }),
  bloxgenDailyLimit: (payload) => fetchJson('/bloxgen/daily-limit', payload),
  bloxgenGenerate: (payload) => fetchJson('/bloxgen/generate', payload),

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

  vaultLoad: () => fetchJson('/vault/load'),
  vaultSave: (data) => fetchJson('/vault/save', data),
  gamesLoad: () => fetchJson('/games/load'),
  gamesSave: (data) => fetchJson('/games/save', data),

  secureStatus: () => fetchJson('/secure/status'),
  unlock: (password) => fetchJson('/secure/unlock', { password }),
  setMasterPassword: (password, accounts) => fetchJson('/secure/set', { password, accounts }),
  removeMasterPassword: (accounts) => fetchJson('/secure/remove', { accounts }),

  version: () => fetchJson('/app/version').then((v) => (typeof v === 'string' ? v : '1.0.0-web')),
  setTheme: (theme) => fetchJson('/theme/set', { theme }),
  setConfig: (cfg) => fetchJson('/config/set', cfg).catch(() => true),
  openUrl: (url) => {
    if (typeof url === 'string' && url.startsWith('http')) window.open(url, '_blank');
    return Promise.resolve(true);
  },
  openDataFolder: () => {
    alert('Data is stored on the server database. No local folder on the website version.');
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
  confirm: (msg, buttons) => {
    const ok = window.confirm(msg || 'Are you sure?');
    return Promise.resolve(ok ? 0 : 1);
  },
  onUpdateAvailable: () => {},
  onUpdateNone: () => {},
  onUpdateDownloaded: () => {},
  onUpdateError: () => {},
  onDetected: () => {},
};
