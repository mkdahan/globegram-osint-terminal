/**
 * Electron main process: window lifecycle + IPC hub wiring together the
 * Telegram client, geocoder, keyword filter, and financial data services.
 */
'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

require('./logger').install(); // before anything that logs (GramJS included)

const secureStore = require('./secureStore');
const settings = require('./settings');
const { TelegramService } = require('./tdlib/client');
const { ChatManager } = require('./tdlib/chatManager');
const { GeonamesParser } = require('./geocoder/geonamesParser');
const { CompanyParser } = require('./corporate/companyParser');
const keywordFilter = require('./utils/keywordFilter');
const marketData = require('./financial/marketData');
const topMovers = require('./financial/topMovers');
const { DarknetScraper } = require('./darknet/darknetScraper');
const { extractRoutes } = require('./geocoder/relationExtractor');
const { logDecision } = require('./decisionLog');
const { ensureDataDirs, MEDIA_DIR } = require('./paths');

let win = null;
const tg = new TelegramService();
const chats = new ChatManager(tg);
const geocoder = new GeonamesParser();
const companyParser = new CompanyParser();
let currentSettings = null; // kept in sync with settings.json

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Events emitted before the renderer finishes loading (startup catch-up sync
// starts seconds after launch, Cesium takes longer) would be lost — buffer
// them so the UI can replay the backlog once it is ready.
const recentEvents = [];
const MAX_RECENT_EVENTS = 300;

/* ---------------- shared geo-event pipeline ---------------- */

tg.onAuthStateChange = (state) => send('auth:state', state);

/**
 * Telegram + Darknet CTI both land here. Applies watch filters, geocodes
 * places/companies, buffers for startup replay, and pushes to the UI.
 */
async function processEvent(payload) {
  const isDarknet = String(payload.source || '').startsWith('DARKNET')
    || payload.chatId === 'darknet';

  // Source gate — profiles / Data Sources toggles apply immediately
  const sources = (currentSettings && currentSettings.sources) || { telegram: true, darknet: false };
  if (isDarknet && sources.darknet === false) {
    logDecision({
      action: 'skipped_source',
      stream: 'darknet',
      chatTitle: payload.chatTitle,
      text: (payload.text || '').slice(0, 240),
      reason: 'darknet source disabled',
    });
    return;
  }
  if (!isDarknet && payload.chatId !== 'demo' && sources.telegram === false) {
    logDecision({
      action: 'skipped_source',
      stream: 'telegram',
      chatTitle: payload.chatTitle,
      text: (payload.text || '').slice(0, 240),
      reason: 'telegram source disabled',
    });
    return;
  }

  const { highPriority: kwHigh, matches } = keywordFilter.classify(payload.text);
  const highPriority = Boolean(payload.highPriorityHint) || kwHigh || isDarknet;

  const watch = (currentSettings && currentSettings.watch) || { places: true, companies: true };
  // For darknet: also match the extracted victim name as a company query
  const searchText = isDarknet && payload.victim
    ? `${payload.text}\n${payload.victim}`
    : payload.text;
  const locations = watch.places !== false ? geocoder.match(searchText) : [];
  let companies = watch.companies !== false ? companyParser.match(searchText) : [];

  // Darknet boost: if victim string is an exact-ish company alias, force-include
  if (isDarknet && watch.companies !== false && payload.victim && !companies.length) {
    companies = companyParser.match(String(payload.victim));
  }

  const lowerText = (searchText || '').toLowerCase();
  const targets = [
    ...locations.map((l) => ({
      kind: 'place',
      name: l.name,
      lat: l.lat,
      lon: l.lon,
      cc: l.cc,
      pop: l.pop || 0,
      matchedWord: l.matchedWord,
      locativeScore: l.locativeScore || 0,
      locativeHint: l.locativeHint || null,
      _pos: lowerText.indexOf(String(l.matchedWord || '').toLowerCase()),
    })),
    ...companies.map((c) => ({
      kind: 'company',
      name: c.companyName,
      lat: c.lat,
      lon: c.lon,
      cc: c.countryCode,
      country: c.country,
      ticker: c.ticker,
      yahoo: c.yahoo,
      exchange: c.exchange,
      matchedWord: c.matchedWord,
      // Darknet victim HQ ranks above bare place mentions
      locativeScore: isDarknet ? 120 : 30,
      locativeHint: isDarknet ? 'darknet-victim' : 'company',
      _pos: lowerText.indexOf(String(c.matchedWord || '').toLowerCase()),
    })),
  ]
    .map((t, i) => ({ ...t, _pos: t._pos < 0 ? 1e9 + i : t._pos }))
    .sort((a, b) => b.locativeScore - a.locativeScore || a._pos - b._pos)
    .map(({ _pos, ...t }) => t);

  // Darknet without a company HQ: drop weak place pins (RSS banners cause
  // random red dots). Keep only strong locative / large places.
  let finalTargets = targets;
  if (isDarknet && !companies.length) {
    finalTargets = targets.filter(
      (t) => (t.locativeScore || 0) >= 45 || (t.pop || 0) >= 500_000
    );
  }

  // From→to routes (arrows) or undirected links between places/companies
  const placeLike = finalTargets.filter((t) => t.lat != null && t.lon != null);
  const { routes, origin } = extractRoutes(searchText || '', placeLike);
  const popupMinSec = (currentSettings && currentSettings.popupMinSec) || 8;

  const event = {
    ...payload,
    highPriority,
    keywords: isDarknet
      ? [{ category: 'cyber', word: 'darknet' }, ...matches]
      : matches,
    locations,
    companies,
    targets: finalTargets,
    routes,
    origin: origin || finalTargets[0] || null,
    mediaPath: null,
    stream: isDarknet ? 'darknet' : 'telegram',
    popupMinSec,
  };

  const action = finalTargets.length
    ? (routes.length
      ? (routes.some((r) => r.directed) ? 'globe_arrow' : 'globe_link')
      : 'globe_pin')
    : 'feed_only';

  logDecision({
    action,
    stream: event.stream,
    source: payload.source || payload.chatId,
    chatTitle: payload.chatTitle,
    msgId: payload.msgId,
    key: payload.key,
    text: (payload.text || '').slice(0, 400),
    victim: payload.victim || null,
    groupName: payload.groupName || null,
    keywords: (event.keywords || []).map((k) => k.category),
    places: (locations || []).map((l) => ({
      name: l.name, word: l.matchedWord, score: l.locativeScore, cc: l.cc,
    })),
    companies: (companies || []).map((c) => ({
      name: c.companyName, word: c.matchedWord, ticker: c.ticker,
    })),
    targets: finalTargets.map((t) => ({ kind: t.kind, name: t.name, cc: t.cc })),
    origin: event.origin ? { name: event.origin.name, cc: event.origin.cc } : null,
    routes: (routes || []).map((r) => ({
      directed: r.directed,
      pattern: r.pattern,
      from: r.from && r.from.name,
      to: r.to && r.to.name,
    })),
    popupMinSec,
    highPriority,
  });

  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.splice(0, recentEvents.length - MAX_RECENT_EVENTS);
  }
  send('tg:event', event);

  if (highPriority && payload.media && ['photo', 'video'].includes(payload.media.kind)) {
    downloadAndNotify(payload.chatId, payload.msgId, payload.key);
  }
}

chats.onEvent = (payload) => processEvent(payload);

const darknet = new DarknetScraper({ onEvent: (payload) => processEvent(payload) });

function applyRuntimeSettings(cfg) {
  currentSettings = cfg;
  const sources = cfg.sources || { telegram: true, darknet: false };
  const dn = cfg.darknet || {};
  darknet.configure({
    enabled: sources.darknet === true && dn.enabled !== false,
    pollMinutes: dn.pollMinutes,
    minSeverity: dn.minSeverity,
    useTor: dn.useTor,
    torProxy: dn.torProxy,
  });
}

async function downloadAndNotify(chatId, msgId, key) {
  try {
    const filePath = await chats.downloadMedia(chatId, msgId);
    if (filePath) send('tg:media', { key, path: filePath });
  } catch (err) {
    console.error('[media]', err.message);
    send('tg:media', { key, error: err.message });
  }
}

/* ---------------- IPC handlers ---------------- */

function registerIpc() {
  // --- auth / secrets ---
  ipcMain.handle('auth:status', async () => {
    const status = secureStore.secretsStatus();
    let authorized = false;
    if (status.hasApiId && status.hasApiHash && status.hasSession) {
      try {
        authorized = await tg.connect();
        if (authorized) chats.startListening();
      } catch (err) {
        console.error('[auth:status]', err.message);
      }
    }
    return { ...status, authorized, state: tg.authState };
  });
  ipcMain.handle('auth:saveCreds', (e, { apiId, apiHash }) => {
    secureStore.saveTelegramCredentials(apiId, apiHash);
    return secureStore.secretsStatus();
  });
  ipcMain.handle('auth:begin', async (e, { phone }) => tg.beginLogin(phone));
  ipcMain.handle('auth:code', (e, { code }) => tg.submitCode(code));
  ipcMain.handle('auth:password', (e, { password }) => tg.submitPassword(password));
  ipcMain.handle('auth:logout', async () => tg.logout());

  // --- chats ---
  ipcMain.handle('chats:list', async () => {
    const list = await chats.listDialogs();
    chats.startListening();
    // Entity cache is warm now — catch anything missed while connecting
    chats.pollMonitored().catch(() => {});
    return list;
  });
  ipcMain.handle('chats:setMonitored', (e, ids) => {
    chats.setMonitored(ids);
    settings.save({ monitoredChats: ids });
    chats.startListening(); // ensure live handler + poll backup are running
    return true;
  });
  ipcMain.handle('tg:downloadMedia', async (e, { chatId, msgId, key }) => {
    downloadAndNotify(chatId, msgId, key);
    return true;
  });

  // --- market ---
  ipcMain.handle('market:candles', async (e, { symbol, dateMs, interval }) => {
    try {
      return { ok: true, candles: await marketData.getCandles(symbol, { dateMs, interval }) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('market:quote', async (e, { symbol }) => {
    try {
      return { ok: true, quote: await marketData.getQuote(symbol) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('market:movers', async () => {
    try {
      return { ok: true, movers: await topMovers.getTopMovers(25) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- settings / misc ---
  ipcMain.handle('settings:get', () => {
    currentSettings = settings.load();
    return currentSettings;
  });
  ipcMain.handle('settings:set', (e, partial) => {
    const merged = settings.save(partial);
    applyRuntimeSettings(merged); // profiles / source toggles take effect immediately
    return merged;
  });
  ipcMain.handle('geocoder:info', () => ({
    source: geocoder.source,
    locations: geocoder.entries.length,
    companySource: companyParser.source,
    companies: companyParser.companies.length,
  }));
  ipcMain.handle('tg:backlog', () => recentEvents);
  ipcMain.handle('tg:stats', () => ({
    ...chats.stats,
    monitored: chats._monitoredPrimary || [],
    listening: !!chats._handlerAttached,
    polling: !!chats._pollTimer,
  }));
  ipcMain.handle('darknet:stats', () => ({ ...darknet.stats, cfg: darknet.cfg }));
  ipcMain.handle('darknet:pollNow', async () => {
    await darknet.poll();
    return { ...darknet.stats };
  });
  ipcMain.handle('app:openMediaDir', () => shell.openPath(MEDIA_DIR));
  ipcMain.handle('app:openLog', () => shell.showItemInFolder(require('./logger').LOG_PATH));
  ipcMain.handle('app:openDecisionsLog', () => {
    const { LOG_PATH } = require('./decisionLog');
    ensureDataDirs();
    try {
      if (!require('fs').existsSync(LOG_PATH)) {
        require('fs').writeFileSync(LOG_PATH, '', 'utf-8');
      }
    } catch { /* ignore */ }
    return shell.showItemInFolder(LOG_PATH);
  });
}

/* ---------------- window ---------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1720,
    height: 1000,
    backgroundColor: '#0b0e14',
    title: 'GlobeGram OSINT Terminal',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Open external links (my.telegram.org etc.) in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // Debug aid: GG_SCREENSHOT=<path> captures the window after GG_SCREENSHOT_DELAY ms
  if (process.env.GG_SCREENSHOT) {
    win.webContents.setBackgroundThrottling(false);
    const delay = Number(process.env.GG_SCREENSHOT_DELAY) || 12000;
    setTimeout(async () => {
      try {
        win.show();
        win.moveTop();
        win.focus();
        await new Promise((r) => setTimeout(r, 1500));
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(process.env.GG_SCREENSHOT, img.toPNG());
        console.log('[screenshot]', process.env.GG_SCREENSHOT);
      } catch (err) {
        console.error('[screenshot]', err.message);
      }
    }, delay);
  }
}

/**
 * Demo mode (GG_DEMO=1): feeds synthetic multilingual messages through the
 * real pipeline so the globe/charts/feed can be exercised without Telegram.
 */
function startDemoFeed() {
  const demo = [
    { chatTitle: 'OSINT Demo', text: 'An explosion reported near the facility of Intel in Kiryat Gat' },
    { chatTitle: 'חדשות דמו', text: 'פיצוץ עז נשמע בבאר שבע — אזעקות גם באשקלון ובאשדוד' },
    { chatTitle: 'Демо Канал', text: 'Пожар на объекте Газпрома, взрыв в Москве' },
    { chatTitle: 'عاجل ديمو', text: 'انفجار كبير في بيروت قرب الميناء وحريق واسع' },
    { chatTitle: 'Markets Demo', text: 'Missile intercepted over Tel Aviv — Elbit and Lockheed Martin stocks moving' },
  ];
  demo.forEach((d, i) => {
    setTimeout(() => {
      chats.onEvent({
        key: `demo:${i}`,
        chatId: 'demo',
        chatTitle: d.chatTitle,
        msgId: i,
        date: Date.now(),
        text: d.text,
        media: null,
      });
    }, 8000 + i * 7000);
  });
}

app.whenReady().then(() => {
  ensureDataDirs();
  geocoder.load();
  companyParser.load();
  registerIpc();
  createWindow();

  // Restore monitored chats + darknet/source toggles from settings
  currentSettings = settings.load();
  chats.setMonitored(currentSettings.monitoredChats);
  applyRuntimeSettings(currentSettings);

  if (process.env.GG_DEMO) startDemoFeed();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  darknet.stop();
  await tg.disconnect();
  app.quit();
});
