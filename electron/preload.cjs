const { contextBridge, ipcRenderer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The fleet, read here rather than shipped in the bundle.
 *
 * preload runs with Node access before the renderer, so the config is available
 * at module scope on the other side — no loading state, no flash of placeholder
 * servers. A missing file is not an error: the app opens on the placeholder in
 * src/config.js, which is the state someone configuring it for the first time
 * is actually in.
 */
function loadConsoleConfig() {
  const candidates = [
    process.env.CONSOLE_CONFIG,
    path.join(process.cwd(), 'config', 'console.json'),
    path.join(__dirname, '..', 'config', 'console.json')
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // Named rather than swallowed: a JSON syntax error that silently falls
      // back to placeholders is a confusing twenty minutes.
      console.error(`[console] ${file} okunamadı: ${err.message}`);
      return null;
    }
  }
  return null;
}

contextBridge.exposeInMainWorld('consoleConfig', loadConsoleConfig());

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('serverConsole', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  selectKeyFile: () => ipcRenderer.invoke('dialog:select-key'),
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (profile) => ipcRenderer.invoke('profiles:save', profile),
    remove: (id) => ipcRenderer.invoke('profiles:remove', id)
  },
  ssh: {
    startTerminal: (payload) => ipcRenderer.invoke('ssh:start-terminal', payload),
    write: (terminalId, data) => ipcRenderer.invoke('ssh:write', { terminalId, data }),
    resize: (terminalId, cols, rows) => ipcRenderer.invoke('ssh:resize', { terminalId, cols, rows }),
    stopTerminal: (terminalId) => ipcRenderer.invoke('ssh:stop-terminal', terminalId),
    stopAll: () => ipcRenderer.invoke('ssh:stop-all')
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
    readText: () => ipcRenderer.invoke('clipboard:read-text')
  },
  deploy: {
    // One channel. The project descriptor travels with the request, so adding a
    // project is a config edit rather than a new branch here.
    run: (payload) => ipcRenderer.invoke('deploy:run', payload),
    onEvent: (callback) => subscribe('deploy:event', callback)
  },
  maintenance: {
    on: (payload) => ipcRenderer.invoke('maintenance:on', payload),
    off: (payload) => ipcRenderer.invoke('maintenance:off', payload),
    status: (payload) => ipcRenderer.invoke('maintenance:status', payload)
  },
  files: {
    list: (terminalId, path) => ipcRenderer.invoke('sftp:list', { terminalId, path }),
    read: (terminalId, path) => ipcRenderer.invoke('sftp:read-file', { terminalId, path }),
    write: (terminalId, path, content) => ipcRenderer.invoke('sftp:write-file', { terminalId, path, content }),
    openExternalEditor: (terminalId, path, options = {}) => ipcRenderer.invoke('sftp:open-external-editor', { terminalId, path, options }),
    mkdir: (terminalId, path) => ipcRenderer.invoke('sftp:mkdir', { terminalId, path }),
    delete: (terminalId, path, type) => ipcRenderer.invoke('sftp:delete', { terminalId, path, type }),
    rename: (terminalId, from, to) => ipcRenderer.invoke('sftp:rename', { terminalId, from, to })
  },
  remoteEdit: {
    onStatus: (callback) => subscribe('remote-edit:status', callback)
  },
  onTerminalData: (callback) => subscribe('ssh:data', callback),
  onTerminalReady: (callback) => subscribe('ssh:ready', callback),
  onTerminalError: (callback) => subscribe('ssh:error', callback),
  onTerminalExit: (callback) => subscribe('ssh:exit', callback)
});
