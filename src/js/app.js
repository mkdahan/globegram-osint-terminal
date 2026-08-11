/**
 * Renderer controller: auth flow, channel selector, event feed,
 * globe + charts + time-sync + movers tape wiring.
 */
import { CesiumManager } from './globe/cesiumManager.js';
import { CameraQueue } from './globe/cameraQueue.js';
import { ChartManager } from './charts/chartManager.js';
import { TimeSync } from './sync/timeSync.js';

const $ = (id) => document.getElementById(id);

/* ================= core instances ================= */

const globe = new CesiumManager('cesiumContainer');
const charts = new ChartManager($('charts-grid'), (unixMs) => sync.onChartClick(unixMs));
const sync = new TimeSync(globe, charts);
// Camera flies to origin; on arrive refresh sticky card (bubble is shown by CameraQueue).
const cameraQueue = new CameraQueue(globe, (event, loc) => {
  // Only overwrite sticky card if this is still the newest match
  if (globe.lastEvent && globe.lastEvent.date > event.date) return;
  globe.showPopup(event, loc || event.origin || (event.targets && event.targets[0]));
});

// Corporate popup "Load <TICKER> chart" button
globe.onLoadTicker = (yahoo) => charts.addChart(yahoo);

let settings = {
  tickers: [], monitoredChats: [], liveCandleRefreshSec: 15, moversRefreshSec: 60,
  watch: { places: true, companies: true },
  sources: { telegram: true, darknet: false },
  darknet: { enabled: true, pollMinutes: 5, minSeverity: 'MEDIUM', useTor: false },
  ui: { sidebarOpen: true, chartsOpen: true },
  popupMinSec: 6,
  alarms: false, autoChartCompany: false, profiles: {},
};

/* ================= alarm siren (WebAudio, no assets) ================= */

let _audioCtx = null;
function playAlarm() {
  try {
    if (!_audioCtx) _audioCtx = new AudioContext();
    const ctx = _audioCtx;
    const now = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      const t = now + i * 0.45;
      osc.frequency.setValueAtTime(650, t);
      osc.frequency.linearRampToValueAtTime(1150, t + 0.22);
      osc.frequency.linearRampToValueAtTime(650, t + 0.44);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.45);
    }
  } catch (err) {
    console.warn('alarm sound failed:', err);
  }
}

function fireAlarm(event) {
  playAlarm();
  try {
    const what = event.targets.map((t) => t.name).join(', ');
    new Notification(`🚨 ${event.chatTitle}`, {
      body: `${what}\n${(event.text || '').slice(0, 120)}`,
      silent: true, // we play our own siren
    });
  } catch (err) {
    console.warn('notification failed:', err);
  }
}

/* ================= auth UI ================= */

const authPanels = ['creds-form', 'phone-form', 'code-form', 'password-form'];
function showAuthPanel(id) {
  for (const p of authPanels) $(p).classList.toggle('hidden', p !== id);
}
function setAuthStatus(text, ok = false) {
  const el = $('auth-status');
  el.textContent = text;
  el.className = 'status-line' + (ok ? ' ok' : '');
}

async function initAuth() {
  const status = await window.api.auth.status();
  $('logout').classList.toggle('hidden', !status.authorized);
  if (!status.hasApiId || !status.hasApiHash) {
    setAuthStatus('Setup required');
    showAuthPanel('creds-form');
  } else if (status.authorized) {
    setAuthStatus('Connected ✓', true);
    showAuthPanel('');
    await loadChats();
  } else {
    setAuthStatus('Not signed in');
    showAuthPanel('phone-form');
  }
}

window.api.auth.onState(({ state, error }) => {
  switch (state) {
    case 'connecting':
      setAuthStatus('Connecting…');
      break;
    case 'wait_code':
      setAuthStatus('Code sent — check Telegram');
      showAuthPanel('code-form');
      break;
    case 'wait_password':
      setAuthStatus('2FA password required');
      showAuthPanel('password-form');
      break;
    case 'authorized':
      setAuthStatus('Connected ✓', true);
      showAuthPanel('');
      $('logout').classList.remove('hidden');
      loadChats();
      break;
    case 'error':
      setAuthStatus(`Error: ${error}`);
      showAuthPanel('phone-form');
      break;
  }
});

$('auth-help-btn').addEventListener('click', () => {
  $('auth-help').classList.toggle('hidden');
});

$('save-creds').addEventListener('click', async () => {
  const apiId = $('api-id').value.trim();
  const apiHash = $('api-hash').value.trim();
  if (!apiId || !apiHash) return setAuthStatus('Both fields required');
  await window.api.auth.saveCreds(apiId, apiHash);
  setAuthStatus('Credentials saved (outside repo)');
  showAuthPanel('phone-form');
});

$('send-code').addEventListener('click', async () => {
  const phone = $('phone').value.trim();
  if (!phone) return setAuthStatus('Enter phone number');
  setAuthStatus('Sending code…');
  try {
    await window.api.auth.begin(phone);
  } catch (err) {
    setAuthStatus(`Error: ${err.message}`);
  }
});

$('submit-code').addEventListener('click', async () => {
  try {
    await window.api.auth.submitCode($('code').value);
    setAuthStatus('Verifying…');
  } catch (err) {
    setAuthStatus(`Error: ${err.message}`);
  }
});

$('submit-password').addEventListener('click', async () => {
  try {
    await window.api.auth.submitPassword($('password').value);
    setAuthStatus('Verifying…');
  } catch (err) {
    setAuthStatus(`Error: ${err.message}`);
  }
});

$('logout').addEventListener('click', async () => {
  await window.api.auth.logout();
  $('chat-list').innerHTML = '';
  $('logout').classList.add('hidden');
  setAuthStatus('Logged out');
  showAuthPanel('phone-form');
});

/* ================= channel selector ================= */

let allChats = [];

async function loadChats() {
  try {
    allChats = await window.api.chats.list();
    renderChatList();
  } catch (err) {
    console.error('loadChats:', err);
  }
}

function renderChatList() {
  const filter = $('chat-search').value.trim().toLowerCase();
  const monitored = new Set(settings.monitoredChats.map(String));
  const list = $('chat-list');
  list.innerHTML = '';
  for (const chat of allChats) {
    if (chat.kind === 'user') continue; // channels & groups only
    if (filter && !chat.title.toLowerCase().includes(filter)) continue;
    const row = document.createElement('label');
    row.className = 'chat-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = monitored.has(chat.id);
    cb.addEventListener('change', () => toggleMonitored(chat.id, cb.checked));
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = chat.title;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = chat.kind;
    row.append(cb, title, kind);
    list.appendChild(row);
  }
}

async function toggleMonitored(id, on) {
  const set = new Set(settings.monitoredChats.map(String));
  if (on) set.add(id);
  else set.delete(id);
  settings.monitoredChats = [...set];
  await window.api.chats.setMonitored(settings.monitoredChats);
}

$('chat-search').addEventListener('input', renderChatList);
$('refresh-chats').addEventListener('click', loadChats);

/* ================= telegram event stream ================= */

const eventsByKey = new Map();
const MAX_FEED = 200;

window.api.events.onTelegramEvent((event) => handleEvent(event));

function handleEvent(event, { replay = false, fly = true } = {}) {
  if (eventsByKey.has(event.key)) return; // live + backlog replay dedupe
  eventsByKey.set(event.key, event);
  addFeedCard(event);
  const targets = event.targets || [];
  if (!targets.length) return;
  // Stamp min display time so the queue / bubbles honor the setting
  event.popupMinSec = settings.popupMinSec || event.popupMinSec || 6;
  globe.addEvent(event); // pins + from→to arrows
  // Sticky card + WhatsApp bubble from the origin place (first / "from")
  const origin = event.origin || targets[0];
  globe.showPopup(event, origin);
  if (fly) {
    cameraQueue.push(event); // flies, then bumps bubble from origin
  } else {
    globe.showBubble(event, origin);
  }
  charts.addEventMarker(event);
  if (!replay && settings && settings.alarms) fireAlarm(event);
  // Auto-chart: settings flag, or always for darknet victims with a ticker
  const isDarknet = event.stream === 'darknet';
  if ((settings && settings.autoChartCompany) || isDarknet) {
    const co = targets.find((t) => t.kind === 'company' && t.yahoo);
    if (co && (settings.autoChartCompany || isDarknet)) charts.addChart(co.yahoo);
  }
}

/**
 * Startup catch-up: events processed while this window was still loading
 * (or from previous minutes of this session) — pins for all, camera
 * flights for the most recent few, no alarm sounds for old news.
 */
async function replayBacklog() {
  if (!window.api.events.backlog) return;
  try {
    const backlog = (await window.api.events.backlog()) || [];
    const withTargets = backlog.filter((e) => (e.targets || []).length && !eventsByKey.has(e.key));
    const flyKeys = new Set(withTargets.slice(-10).map((e) => e.key));
    for (const ev of backlog) {
      handleEvent(ev, { replay: true, fly: flyKeys.has(ev.key) });
    }
  } catch (err) {
    console.warn('backlog replay:', err);
  }
}

window.api.events.onMediaReady(({ key, path, error }) => {
  if (error) return console.warn('media error:', error);
  const event = eventsByKey.get(key);
  if (event) event.mediaPath = path;
  globe.attachMedia(key, path);
});

function addFeedCard(event) {
  const feed = $('event-feed');
  const card = document.createElement('div');
  const isDarknet = event.stream === 'darknet' || String(event.source || '').startsWith('DARKNET');
  card.className = 'event-card'
    + (event.highPriority ? ' high' : '')
    + (isDarknet ? ' darknet' : '');

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = new Date(event.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.innerHTML =
    `<span>${time}</span><span>${escapeHtml(event.chatTitle)}</span>` +
    (isDarknet ? '<span class="cyber">CTI</span>' : '') +
    (event.keywords || []).map((k) => `<span class="kw ${k.category === 'cyber' ? 'cyber' : ''}">${k.category}</span>`).join('') +
    (event.locations || []).map((l) => `<span class="loc">${escapeHtml(l.name)}</span>`).join('') +
    (event.companies || [])
      .map((c) => `<span class="co">${escapeHtml(c.companyName)}${c.ticker ? ` [${escapeHtml(c.ticker)}]` : ''}</span>`)
      .join('');

  const txt = document.createElement('div');
  txt.className = 'txt';
  txt.textContent = event.text || '(media only)';

  card.append(meta, txt);
  card.addEventListener('click', () => {
    const targets = event.targets || [];
    if (targets.length) {
      const loc = targets[0];
      globe.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(loc.lon, loc.lat, 120000),
        duration: 1.5,
        complete: () => globe.showPopup(event, loc),
      });
      // request media on demand for low-priority events
      if (event.media && !event.mediaPath) {
        window.api.events.requestMedia(event.chatId, event.msgId, event.key);
      }
    }
  });
  feed.prepend(card);
  while (feed.children.length > MAX_FEED) feed.lastChild.remove();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ================= charts + tickers ================= */

$('add-ticker').addEventListener('click', addTickerFromInput);
$('ticker-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addTickerFromInput();
});

async function addTickerFromInput() {
  const sym = $('ticker-input').value.trim().toUpperCase();
  if (!sym) return;
  $('ticker-input').value = '';
  await charts.addChart(sym);
}

let bootingCharts = true; // don't persist while restoring saved tickers
charts.onTickersChanged = (symbols) => {
  if (bootingCharts) return;
  settings.tickers = symbols;
  window.api.settings.set({ tickers: symbols });
};

/* ================= panel dock toggles ================= */

function applyUiPanels() {
  const ui = settings.ui || { sidebarOpen: true, chartsOpen: true };
  document.getElementById('app').classList.toggle('sidebar-collapsed', ui.sidebarOpen === false);
  document.getElementById('app').classList.toggle('charts-collapsed', ui.chartsOpen === false);
  $('toggle-sidebar').classList.toggle('active', ui.sidebarOpen !== false);
  $('toggle-charts').classList.toggle('active', ui.chartsOpen !== false);
  // Cesium needs a resize kick after layout change
  setTimeout(() => {
    try { globe.viewer.resize(); } catch { /* ignore */ }
  }, 240);
}

function initDock() {
  applyUiPanels();
  $('toggle-sidebar').addEventListener('click', () => {
    const open = !document.getElementById('app').classList.contains('sidebar-collapsed');
    settings.ui = { ...(settings.ui || {}), sidebarOpen: !open };
    applyUiPanels();
    window.api.settings.set({ ui: settings.ui });
  });
  $('toggle-charts').addEventListener('click', () => {
    const open = !document.getElementById('app').classList.contains('charts-collapsed');
    settings.ui = { ...(settings.ui || {}), chartsOpen: !open };
    applyUiPanels();
    window.api.settings.set({ ui: settings.ui });
  });
}

/* ================= watch filters & data sources ================= */

function syncSourceUi() {
  const sources = settings.sources || { telegram: true, darknet: false };
  const dn = settings.darknet || {};
  $('src-telegram').checked = sources.telegram !== false;
  $('src-darknet').checked = sources.darknet === true;
  $('dn-tor').checked = Boolean(dn.useTor);
  $('dn-poll').value = String(dn.pollMinutes || 5);
  $('dn-severity').value = dn.minSeverity || 'MEDIUM';
  $('sources-panel').classList.toggle('darknet-on', sources.darknet === true);
}

async function persistConfig() {
  settings.watch = {
    places: $('watch-places').checked,
    companies: $('watch-companies').checked,
  };
  settings.alarms = $('opt-alarms').checked;
  settings.autoChartCompany = $('opt-autochart').checked;
  settings.popupMinSec = Number($('popup-min').value) || 6;
  settings.sources = {
    telegram: $('src-telegram').checked,
    darknet: $('src-darknet').checked,
  };
  settings.darknet = {
    ...(settings.darknet || {}),
    enabled: true,
    useTor: $('dn-tor').checked,
    pollMinutes: Number($('dn-poll').value) || 5,
    minSeverity: $('dn-severity').value || 'MEDIUM',
  };
  $('sources-panel').classList.toggle('darknet-on', settings.sources.darknet);
  cameraQueue.setIntervalSec(settings.popupMinSec);
  // settings:set → main.applyRuntimeSettings — takes effect immediately
  await window.api.settings.set({
    watch: settings.watch,
    alarms: settings.alarms,
    autoChartCompany: settings.autoChartCompany,
    popupMinSec: settings.popupMinSec,
    sources: settings.sources,
    darknet: settings.darknet,
  });
  refreshDarknetStatus();
}

function initToggles() {
  $('watch-places').checked = settings.watch.places !== false;
  $('watch-companies').checked = settings.watch.companies !== false;
  $('opt-alarms').checked = Boolean(settings.alarms);
  $('opt-autochart').checked = Boolean(settings.autoChartCompany);
  $('popup-min').value = String(settings.popupMinSec || 6);
  syncSourceUi();

  for (const id of [
    'watch-places', 'watch-companies', 'opt-alarms', 'opt-autochart', 'popup-min',
    'src-telegram', 'src-darknet', 'dn-tor', 'dn-poll', 'dn-severity',
  ]) {
    $(id).addEventListener('change', () => persistConfig());
  }
  $('dn-poll-now').addEventListener('click', async () => {
    $('dn-status').textContent = 'polling…';
    try {
      const s = await window.api.darknet.pollNow();
      $('dn-status').textContent = `ok · ${s.emitted || 0} events`;
      $('dn-status').className = 'status-line ok';
    } catch (err) {
      $('dn-status').textContent = err.message || 'error';
      $('dn-status').className = 'status-line';
    }
  });

  // Unlock WebAudio on first user gesture so the siren can play later
  document.body.addEventListener(
    'click',
    () => {
      if (!_audioCtx) {
        try { _audioCtx = new AudioContext(); } catch { /* ignore */ }
      }
    },
    { once: true }
  );
}

async function refreshDarknetStatus() {
  const el = $('dn-status');
  if (!el || !window.api.darknet) return;
  try {
    const s = await window.api.darknet.stats();
    if (!(settings.sources && settings.sources.darknet)) {
      el.textContent = 'off';
      el.className = 'status-line dim';
      return;
    }
    const ago = s.lastPollAt ? Math.round((Date.now() - s.lastPollAt) / 1000) : null;
    el.textContent = ago != null
      ? `${s.emitted || 0} events · ${ago}s · tor:${s.torOk ? 'on' : 'off'}`
      : 'waiting…';
    el.className = 'status-line ok';
    if (s.lastError) el.title = s.lastError;
  } catch {
    el.textContent = 'n/a';
  }
}

/* ================= profiles ================= */

function currentProfileSnapshot() {
  return {
    monitoredChats: [...settings.monitoredChats],
    tickers: charts.symbols,
    watch: { ...settings.watch },
    sources: { ...(settings.sources || { telegram: true, darknet: false }) },
    darknet: { ...(settings.darknet || {}) },
    alarms: settings.alarms,
    autoChartCompany: settings.autoChartCompany,
    popupMinSec: settings.popupMinSec || 6,
  };
}

function renderProfileList(selected = '') {
  const sel = $('profile-select');
  sel.innerHTML = '<option value="">— select profile —</option>';
  for (const name of Object.keys(settings.profiles || {}).sort()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === selected) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function applyProfile(name) {
  const prof = (settings.profiles || {})[name];
  if (!prof) return;

  // Channels — live immediately
  settings.monitoredChats = [...(prof.monitoredChats || [])];
  await window.api.chats.setMonitored(settings.monitoredChats);
  renderChatList();

  // Charts
  for (const sym of [...charts.symbols]) charts.removeChart(sym);
  for (const sym of prof.tickers || ['GLD']) await charts.addChart(sym);

  // Watch / sources / darknet / options — apply to UI then push to main
  settings.watch = { places: true, companies: true, ...(prof.watch || {}) };
  settings.sources = {
    telegram: true,
    darknet: false,
    ...(prof.sources || {}),
  };
  settings.darknet = {
    enabled: true,
    pollMinutes: 5,
    minSeverity: 'MEDIUM',
    useTor: false,
    ...(settings.darknet || {}),
    ...(prof.darknet || {}),
  };
  settings.alarms = Boolean(prof.alarms);
  settings.autoChartCompany = Boolean(prof.autoChartCompany);
  if (prof.popupMinSec) settings.popupMinSec = Number(prof.popupMinSec) || settings.popupMinSec;

  $('watch-places').checked = settings.watch.places !== false;
  $('watch-companies').checked = settings.watch.companies !== false;
  $('opt-alarms').checked = settings.alarms;
  $('opt-autochart').checked = settings.autoChartCompany;
  $('popup-min').value = String(settings.popupMinSec || 6);
  syncSourceUi();
  cameraQueue.setIntervalSec(settings.popupMinSec || 6);

  // One settings:set call → main.applyRuntimeSettings (darknet start/stop, watch)
  await window.api.settings.set({
    monitoredChats: settings.monitoredChats,
    tickers: charts.symbols,
    watch: settings.watch,
    sources: settings.sources,
    darknet: settings.darknet,
    alarms: settings.alarms,
    autoChartCompany: settings.autoChartCompany,
    popupMinSec: settings.popupMinSec,
  });
  refreshDarknetStatus();
}

function initProfiles() {
  renderProfileList();

  $('profile-save').addEventListener('click', async () => {
    const name = $('profile-name').value.trim() || $('profile-select').value;
    if (!name) return;
    settings.profiles = settings.profiles || {};
    settings.profiles[name] = currentProfileSnapshot();
    await window.api.settings.set({ profiles: settings.profiles });
    $('profile-name').value = '';
    renderProfileList(name);
  });

  $('profile-select').addEventListener('change', (e) => {
    if (e.target.value) applyProfile(e.target.value);
  });

  $('profile-delete').addEventListener('click', async () => {
    const name = $('profile-select').value;
    if (!name || !settings.profiles[name]) return;
    delete settings.profiles[name];
    await window.api.settings.set({ profiles: settings.profiles });
    renderProfileList();
  });
}

/* ================= movers tape ================= */

async function refreshMovers() {
  const res = await window.api.market.movers();
  if (!res.ok || !res.movers.length) return;
  const track = $('tape-track');
  track.innerHTML = '';
  for (const m of res.movers) {
    const item = document.createElement('span');
    item.className = 'tape-item';
    const cls = m.extreme ? 'extreme' : m.hot ? 'hot' : 'up';
    item.innerHTML =
      `<b>${m.symbol}</b> ${m.price != null ? m.price.toFixed(2) : ''} ` +
      `<span class="chg ${cls}">+${m.changePct.toFixed(1)}%</span>`;
    item.title = m.name;
    item.addEventListener('click', () => charts.addChart(m.symbol));
    track.appendChild(item);
  }
}

/* ================= boot ================= */

async function boot() {
  settings = await window.api.settings.get();

  const geoInfo = await window.api.geocoderInfo();
  $('geocoder-status').textContent =
    `Gazetteer: ${geoInfo.locations.toLocaleString()} places (${geoInfo.source}) · ` +
    `${geoInfo.companies.toLocaleString()} companies (${geoInfo.companySource})`;

  const restore = (settings.tickers && settings.tickers.length)
    ? settings.tickers
    : ['GLD'];
  for (const sym of restore) {
    await charts.addChart(sym);
  }
  bootingCharts = false;

  initDock();
  initToggles();
  initProfiles();
  cameraQueue.setIntervalSec(settings.popupMinSec || 6);
  await initAuth();
  await replayBacklog();
  // Second pass: the first catch-up sync may still have been in flight
  setTimeout(replayBacklog, 10_000);
  refreshMovers();
  setInterval(refreshMovers, (settings.moversRefreshSec || 60) * 1000);
  setInterval(() => charts.refreshLive(), (settings.liveCandleRefreshSec || 15) * 1000);
  setInterval(refreshIngestStatus, 5000);
  setInterval(refreshDarknetStatus, 8000);
  refreshIngestStatus();
  refreshDarknetStatus();
}

async function refreshIngestStatus() {
  const el = $('live-ingest');
  if (!el || !window.api.events.stats) return;
  try {
    const s = await window.api.events.stats();
    const n = (s.monitored || []).length;
    if (!n) {
      el.textContent = 'no channels';
      el.className = 'live-pill warn';
      return;
    }
    const mode = s.listening ? (s.polling ? 'live+poll' : 'live') : 'offline';
    if (s.emitted > 0) {
      const ago = s.lastAt ? Math.round((Date.now() - s.lastAt) / 1000) : '?';
      el.textContent = `${mode} · ${s.emitted} msgs · ${ago}s`;
      el.className = 'live-pill ok';
      el.title = s.lastChat ? `${s.lastChat}: ${s.lastText || ''}` : '';
    } else {
      el.textContent = `${mode} · ${n} ch · waiting…`;
      el.className = 'live-pill warn';
      el.title = s.skippedUnmonitored
        ? `skipped ${s.skippedUnmonitored} msgs from other chats`
        : '';
    }
  } catch {
    /* ignore */
  }
}

boot();
