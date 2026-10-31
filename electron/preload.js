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
    probe: invoke('jobs:probe'),
    targetDir: invoke('jobs:targetDir'),
    pause: invoke('jobs:pause'),
    resume: invoke('jobs:resume'),
    remove: invoke('jobs:remove'),
    pauseAll: invoke('jobs:pauseAll'),
    resumeAll: invoke('jobs:resumeAll'),
    clearCompleted: invoke('jobs:clearCompleted'),
    openFile: invoke('jobs:openFile'),
    showInFolder: invoke('jobs:showInFolder'),
    onChange: (cb) => subscribe('jobs:changed', cb),
  },
  settings: {
    get: invoke('settings:get'),
    set: invoke('settings:set'),
    categoryNames: invoke('settings:categoryNames'),
  },
  app: {
    info: invoke('app:info'),
    createShortcuts: invoke('app:createShortcuts'),
    openPath: invoke('shell:openPath'),
  },
  video: {
    status: invoke('video:status'),
    qualities: invoke('video:qualities'),
    probe: invoke('video:probe'),
    install: invoke('video:install'),
    update: invoke('video:update'),
    onInstall: (cb) => subscribe('video:install', cb),
  },
  bridge: {
    status: invoke('bridge:status'),
    onStatus: (cb) => subscribe('bridge:status', cb),
  },
  chooseDir: invoke('dialog:chooseDir'),
  clipboardUrl: invoke('clipboard:url'),
  openExternal: invoke('shell:openExternal'),
});
