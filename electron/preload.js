'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('sf', {
  jobs: {
    list: invoke('jobs:list'),
    add: invoke('jobs:add'),
    addMany: invoke('jobs:addMany'),
    probe: invoke('jobs:probe'),
    targetDir: invoke('jobs:targetDir'),
    pause: invoke('jobs:pause'),
    resume: invoke('jobs:resume'),
    remove: invoke('jobs:remove'),
    removeMany: invoke('jobs:removeMany'),
    pauseAll: invoke('jobs:pauseAll'),
    resumeAll: invoke('jobs:resumeAll'),
    clearCompleted: invoke('jobs:clearCompleted'),
    clearFailed: invoke('jobs:clearFailed'),
    openFile: invoke('jobs:openFile'),
    showInFolder: invoke('jobs:showInFolder'),
    setDescription: invoke('jobs:setDescription'),
    changeUrl: invoke('jobs:changeUrl'),
    redownload: invoke('jobs:redownload'),
    moveFile: invoke('jobs:moveFile'),
    setChecksum: invoke('jobs:setChecksum'),
    verifyChecksum: invoke('jobs:verifyChecksum'),
    extract: invoke('jobs:extract'),
    stopSeeding: invoke('jobs:stopSeeding'),
    addToQueue: invoke('jobs:addToQueue'),
    removeFromQueue: invoke('jobs:removeFromQueue'),
    export: invoke('jobs:export'),
    onChange: (cb) => subscribe('jobs:changed', cb),
    onChecksum: (cb) => subscribe('jobs:checksum', cb),
  },
  links: {
    extract: invoke('links:extract'),
    fromPage: invoke('links:fromPage'),
    expand: invoke('links:expand'),
    suggest: invoke('links:suggest'),
    lookup: invoke('links:lookup'),
    importFile: invoke('links:importFile'),
    onLookup: (cb) => subscribe('links:lookup', cb),
    onIncoming: (cb) => subscribe('links:incoming', cb),
  },
  queues: {
    list: invoke('queues:list'),
    create: invoke('queues:create'),
    update: invoke('queues:update'),
    remove: invoke('queues:remove'),
    start: invoke('queues:start'),
    stop: invoke('queues:stop'),
    limits: invoke('queues:limits'),
    cancelCountdown: invoke('queues:cancelCountdown'),
    powerNow: invoke('queues:powerNow'),
    onChange: (cb) => subscribe('queues:changed', cb),
    onCountdown: (cb) => subscribe('scheduler:countdown', cb),
    onLimit: (cb) => subscribe('scheduler:limit', cb),
  },
  torrents: {
    lookup: invoke('torrents:lookup'),
    chooseFile: invoke('torrents:chooseFile'),
    onRequest: (cb) => subscribe('torrent:request', cb),
    onMagnet: (cb) => subscribe('torrent:magnet', cb),
  },
  debrid: {
    services: invoke('debrid:services'),
    check: invoke('debrid:check'),
  },
  network: { status: invoke('network:status') },
  tools: { status: invoke('tools:status') },
  video: {
    status: invoke('video:status'),
    qualities: invoke('video:qualities'),
    probe: invoke('video:probe'),
    install: invoke('video:install'),
    update: invoke('video:update'),
    onInstall: (cb) => subscribe('video:install', cb),
  },
  gallery: { supports: invoke('gallery:supports') },
  settings: {
    get: invoke('settings:get'),
    set: invoke('settings:set'),
    categoryNames: invoke('settings:categoryNames'),
  },
  app: {
    info: invoke('app:info'),
    createShortcuts: invoke('app:createShortcuts'),
    openPath: invoke('shell:openPath'),
    setZoom: invoke('app:setZoom'),
    playSound: invoke('app:playSound'),
    onAddRequest: (cb) => subscribe('add:request', cb),
    onBatchRequest: (cb) => subscribe('batch:request', cb),
  },
  bridge: {
    status: invoke('bridge:status'),
    onStatus: (cb) => subscribe('bridge:status', cb),
  },
  chooseDir: invoke('dialog:chooseDir'),
  chooseFile: invoke('dialog:chooseFile'),
  saveAs: invoke('dialog:saveAs'),
  clipboardUrl: invoke('clipboard:url'),
  clipboardText: invoke('clipboard:text'),
  openExternal: invoke('shell:openExternal'),
});
