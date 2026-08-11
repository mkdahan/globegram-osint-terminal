/**
 * Electron main process: window lifecycle + IPC hub wiring together the
 * Telegram client, geocoder, keyword filter, and financial data services.
 */
'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const secureStore = require('./secureStore');
const settings = require('./settings');
const { TelegramService } = require('./tdlib/client');
const { ChatManager } = require('./tdlib/chatManager');
const { GeonamesParser } = require('./geocoder/geonamesParser');
const { CompanyParser } = require('./corporate/companyParser');
const keywordFilter = require('./utils/keywordFilter');
const marketData = require('./financial/marketData');
const topMovers = require('./financial/topMovers');
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

/* ---------------- Telegram event pipeline ---------------- */

tg.onAuthStateChange = (state) => send('auth:state', state);

chats.onEvent = async (payload) => {
  const { highPriority, matches } = keywordFilter.classify(payload.text);

  // Parallel parsing engines, filtered by the user's watch flags
  const watch = (currentSettings && currentSettings.watch) || { places: true, companies: true };
  const locations = watch.places !== false ? geocoder.match(payload.text) : [];
  const companies = watch.companies !== false ? companyParser.match(payload.text) : [];

  // Unified targets: prefer places with locative cues (ב / in / at / near)
  // over secondary mentions (לאוקראינה = "to Ukraine"), then by text order.
  const lowerText = (payload.text || '').toLowerCase();
  const targets = [
    ...locations.map((l) => ({
      kind: 'place',
      name: l.name,
      lat: l.lat,
      lon: l.lon,
      cc: l.cc,
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
      // Mild boost when phrased as "facility of X" / "מפעל X" — still below ב/in/at
      locativeScore: 30,
      locativeHint: 'company',
      _pos: lowerText.indexOf(String(c.matchedWord || '').toLowerCase()),
    })),
  ]
    .map((t, i) => ({ ...t, _pos: t._pos < 0 ? 1e9 + i : t._pos }))
    .sort((a, b) => b.locativeScore - a.locativeScore || a._pos - b._pos)
    .map(({ _pos, ...t }) => t);

  const event = {
    ...payload,
    highPriority,
    keywords: matches,
    locations,
    companies,
    targets,
    mediaPath: null,
  };
  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.splice(0, recentEvents.length - MAX_RECENT_EVENTS);
  }
  send('tg:event', event);

  // High-priority messages with media: download immediately, notify when ready.
  if (highPriority && payload.media && ['photo', 'video'].includes(payload.media.kind)) {
    downloadAndNotify(payload.chatId, payload.msgId, payload.key);
  }
};

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
    currentSettings = settings.save(partial);
    return currentSettings;
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
  ipcMain.handle('app:openMediaDir', () => shell.openPath(MEDIA_DIR));
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

  // Restore monitored chats from settings
  currentSettings = settings.load();
  chats.setMonitored(currentSettings.monitoredChats);

  if (process.env.GG_DEMO) startDemoFeed();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await tg.disconnect();
  app.quit();
});
