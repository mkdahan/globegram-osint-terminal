/**
 * Context-isolated bridge: the only surface the renderer can touch.
 * No secrets ever cross this bridge (booleans/status only).
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    saveCreds: (apiId, apiHash) => ipcRenderer.invoke('auth:saveCreds', { apiId, apiHash }),
    begin: (phone) => ipcRenderer.invoke('auth:begin', { phone }),
    submitCode: (code) => ipcRenderer.invoke('auth:code', { code }),
    submitPassword: (password) => ipcRenderer.invoke('auth:password', { password }),
    logout: () => ipcRenderer.invoke('auth:logout'),
    onState: (cb) => on('auth:state', cb),
  },
  chats: {
    list: () => ipcRenderer.invoke('chats:list'),
    setMonitored: (ids) => ipcRenderer.invoke('chats:setMonitored', ids),
  },
  events: {
    onTelegramEvent: (cb) => on('tg:event', cb),
    onMediaReady: (cb) => on('tg:media', cb),
    requestMedia: (chatId, msgId, key) =>
      ipcRenderer.invoke('tg:downloadMedia', { chatId, msgId, key }),
    stats: () => ipcRenderer.invoke('tg:stats'),
    backlog: () => ipcRenderer.invoke('tg:backlog'),
  },
  market: {
    candles: (symbol, dateMs, interval) =>
      ipcRenderer.invoke('market:candles', { symbol, dateMs, interval }),
    quote: (symbol) => ipcRenderer.invoke('market:quote', { symbol }),
    movers: () => ipcRenderer.invoke('market:movers'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (partial) => ipcRenderer.invoke('settings:set', partial),
  },
  geocoderInfo: () => ipcRenderer.invoke('geocoder:info'),
  openMediaDir: () => ipcRenderer.invoke('app:openMediaDir'),
  openLog: () => ipcRenderer.invoke('app:openLog'),
});
