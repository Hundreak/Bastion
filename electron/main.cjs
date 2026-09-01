const { app, BrowserWindow, ipcMain, shell, dialog, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Duplex } = require('stream');
const { Client } = require('ssh2');
const { spawn, execFileSync } = require('child_process');

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-setuid-sandbox');
}

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
let mainWindow;

const terminals = new Map();
const activeRemoteEditors = new Map();

const activeDeploys = new Set();

function emitDeploy(payload) {
  emit('deploy:event', {
    ts: new Date().toISOString(),
    ...payload
  });
}

function runLocalCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: process.env,
      shell: false
    });

    let output = '';
    const onChunk = (chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      options.onData?.(text);
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, output });
      else reject(new Error(`${command} ${args.join(' ')} komutu ${code} koduyla bitti.\n${output}`));
    });
  });
}

function uploadFileWithProgress(sftp, localPath, remotePath, onProgress) {
  const totalSize = fs.statSync(localPath).size;
  let lastPercent = -1;
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, {
      step: (transferred, _chunk, total) => {
        const size = total || totalSize || 1;
        const percent = Math.max(0, Math.min(100, Math.round((transferred / size) * 100)));
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress?.(percent, transferred, size);
        }
      }
    }, (err) => {
      if (err) reject(err);
      else resolve({ ok: true, remotePath, totalSize });
    });
  });
}

function execRemoteCommand(conn, command, onData) {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: true }, (err, stream) => {
      if (err) return reject(err);
      let output = '';
      stream.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        output += text;
        onData?.(text);
      });
      stream.stderr?.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        output += text;
        onData?.(text);
      });
      stream.on('close', (code) => {
        if (code === 0) resolve({ ok: true, output });
        else reject(new Error(`Uzak komut ${code} koduyla bitti.\n${output}`));
      });
      stream.on('error', reject);
    });
  });
}

function shQuoteLocal(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    title: 'NOYKARA Server Console',
    backgroundColor: '#050713',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    closeAllTerminals();
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  closeAllTerminals();
  if (process.platform !== 'darwin') app.quit();
});

function profilePath() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'server-profiles.json');
}

function readProfiles() {
  const file = profilePath();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeProfiles(profiles) {
  fs.writeFileSync(profilePath(), JSON.stringify(profiles, null, 2));
}

function sanitizeProfile(input) {
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  const label = String(input.label || host || 'Sunucu').trim();
  const port = Number(input.port || 22);
  const keyPath = String(input.keyPath || '').trim();

  if (!host) throw new Error('Sunucu IP / host zorunlu.');
  if (!username) throw new Error('Kullanıcı adı zorunlu.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port 1-65535 aralığında olmalı.');

  return {
    id: String(input.id || crypto.randomUUID()),
    label,
    host,
    port,
    username,
    keyPath,
    updatedAt: new Date().toISOString()
  };
}

function emit(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function resolveHome(filePath) {
  if (!filePath) return '';
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function createProxyStream(proxyCommand) {
  const expanded = String(proxyCommand).replace(/^~\//, os.homedir() + '/');
  const parts = expanded.split(/\s+/).filter(Boolean);
  const proc = spawn(parts[0], parts.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });

  const stream = new Duplex({
    read() {},
    write(chunk, enc, cb) { proc.stdin.write(chunk, enc, cb); },
    destroy(err, cb) {
      try { proc.kill(); } catch {}
      cb(err);
    }
  });

  proc.stdout.on('data', (d) => stream.push(d));
  proc.stdout.on('end', () => stream.push(null));
  proc.on('error', (err) => stream.destroy(err));
  proc.on('close', (code) => {
    if (!stream.destroyed) stream.push(null);
  });

  stream._proc = proc;
  return stream;
}

function buildSshConfig(input) {
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  const port = Number(input.port || 22);
  const password = String(input.password || '');
  const keyPath = resolveHome(String(input.keyPath || '').trim());

  if (!host) throw new Error('Sunucu IP / host zorunlu.');
  if (!username) throw new Error('Kullanıcı adı zorunlu.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port 1-65535 aralığında olmalı.');

  const config = {
    host,
    port,
    username,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    readyTimeout: 20000,
    tryKeyboard: true
  };

  if (keyPath) {
    if (!fs.existsSync(keyPath)) throw new Error(`SSH key bulunamadı: ${keyPath}`);
    config.privateKey = fs.readFileSync(keyPath);
    if (input.passphrase) config.passphrase = String(input.passphrase);
  } else {
    if (!password) throw new Error('Şifre veya SSH key gerekli.');
    config.password = password;
  }

  return config;
}

function closeRemoteEditorsForTerminal(terminalId) {
  for (const [id, editor] of activeRemoteEditors.entries()) {
    if (String(editor.terminalId) !== String(terminalId)) continue;
    try { clearTimeout(editor.timer); } catch {}
    try { fs.unwatchFile(editor.localPath, editor.watchHandler); } catch {}
    activeRemoteEditors.delete(id);
  }
}

function closeAllRemoteEditors() {
  for (const [id, editor] of activeRemoteEditors.entries()) {
    try { clearTimeout(editor.timer); } catch {}
    try { fs.unwatchFile(editor.localPath, editor.watchHandler); } catch {}
    activeRemoteEditors.delete(id);
  }
}

function closeTerminal(terminalId) {
  const item = terminals.get(terminalId);
  if (!item) return;
  closeRemoteEditorsForTerminal(terminalId);
  try { item.stream && item.stream.end('exit\n'); } catch {}
  try { item.conn && item.conn.end(); } catch {}
  terminals.delete(terminalId);
}

function closeAllTerminals() {
  for (const id of [...terminals.keys()]) closeTerminal(id);
  closeAllRemoteEditors();
}

function cleanRemotePath(rawPath, fallback = '/root') {
  const input = String(rawPath || fallback).trim() || fallback;
  let normalized = input.replace(/\\+/g, '/');
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  const parts = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}` || '/';
}

function parentRemotePath(remotePath) {
  const clean = cleanRemotePath(remotePath, '/');
  if (clean === '/') return '/';
  const next = clean.split('/').slice(0, -1).join('/');
  return next || '/';
}

function getTerminal(terminalId) {
  const item = terminals.get(String(terminalId || ''));
  if (!item?.conn) throw new Error('Aktif SSH bağlantısı bulunamadı. Önce sunucuya giriş yap.');
  return item;
}

function withSftp(terminalId, worker) {
  return new Promise((resolve, reject) => {
    let sftpRef;
    try {
      const item = getTerminal(terminalId);
      item.conn.sftp(async (err, sftp) => {
        if (err) return reject(err);
        sftpRef = sftp;
        try {
          const result = await worker(sftp);
          try { sftp.end(); } catch {}
          resolve(result);
        } catch (workerErr) {
          try { sftpRef?.end(); } catch {}
          reject(workerErr);
        }
      });
    } catch (err) {
      try { sftpRef?.end(); } catch {}
      reject(err);
    }
  });
}

function attrsToFile(entry, basePath) {
  const attrs = entry.attrs;
  const type = attrs.isDirectory() ? 'directory' : attrs.isSymbolicLink() ? 'symlink' : attrs.isFile() ? 'file' : 'other';
  const fullPath = cleanRemotePath(`${basePath}/${entry.filename}`, '/');
  return {
    name: entry.filename,
    path: fullPath,
    type,
    size: attrs.size || 0,
    mode: attrs.permissions || 0,
    modifiedAt: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : null,
    longname: entry.longname || ''
  };
}

function readStreamToString(stream, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > limitBytes) {
        stream.destroy(new Error('Dosya çok büyük. Önizleme limiti 2MB.'));
        return;
      }
      chunks.push(buf);
    });
    stream.on('error', reject);
    stream.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function writeStringToStream(stream, content) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('close', resolve);
    stream.end(String(content ?? ''), 'utf8');
  });
}

function remoteEditBaseDir() {
  const dir = path.join(app.getPath('userData'), 'remote-env-editors');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeLocalEditorName(remotePath, projectLabel = 'remote-env') {
  const base = String(projectLabel || path.basename(remotePath) || 'remote-env')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'remote-env';
  const hash = crypto.createHash('sha1').update(String(remotePath)).digest('hex').slice(0, 8);
  return `${base}-${hash}.txt`;
}

function hashText(value) {
  return crypto.createHash('sha1').update(String(value ?? ''), 'utf8').digest('hex');
}


function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function commandExists(command) {
  try {
    execFileSync('bash', ['-lc', `command -v ${shellQuote(command)}`], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

async function openPlainTextEditor(localPath) {
  const envEditor = String(process.env.NOYKARA_TEXT_EDITOR || '').trim();
  const preferred = [];

  if (envEditor) preferred.push({ command: envEditor, args: [localPath], label: envEditor });

  if (process.platform === 'linux') {
    preferred.push(
      { command: 'gnome-text-editor', args: ['--new-window', localPath], label: 'GNOME Text Editor' },
      { command: 'gedit', args: [localPath], label: 'gedit' },
      { command: 'xed', args: [localPath], label: 'xed' },
      { command: 'kate', args: [localPath], label: 'Kate' },
      { command: 'kwrite', args: [localPath], label: 'KWrite' },
      { command: 'mousepad', args: [localPath], label: 'Mousepad' },
      { command: 'code', args: ['--new-window', localPath], label: 'VS Code' }
    );
  }

  if (process.platform === 'darwin') {
    preferred.push({ command: 'open', args: ['-a', 'TextEdit', localPath], label: 'TextEdit' });
  }

  if (process.platform === 'win32') {
    preferred.push({ command: 'notepad.exe', args: [localPath], label: 'Notepad' });
  }

  for (const candidate of preferred) {
    if (!candidate.command) continue;
    if (process.platform === 'linux' && !commandExists(candidate.command)) continue;

    try {
      const child = spawn(candidate.command, candidate.args, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return { ok: true, editor: candidate.label || candidate.command };
    } catch (_) {
      // Sıradaki editörü dene.
    }
  }

  const openResult = await shell.openPath(localPath);
  if (openResult) throw new Error(`Metin editörü açılamadı: ${openResult}`);
  return { ok: true, editor: 'system-default' };
}

async function uploadRemoteEditorFile(editorId) {
  const editor = activeRemoteEditors.get(editorId);
  if (!editor) return;
  if (editor.saving) {
    editor.queued = true;
    return;
  }
  editor.saving = true;
  try {
    const content = fs.readFileSync(editor.localPath, 'utf8');
    const nextHash = hashText(content);
    if (nextHash === editor.lastHash) return;
    await withSftp(editor.terminalId, async (sftp) => {
      await writeStringToStream(sftp.createWriteStream(editor.remotePath), content);
    });
    editor.lastHash = nextHash;
    emit('remote-edit:status', {
      id: editorId,
      status: 'saved',
      remotePath: editor.remotePath,
      localPath: editor.localPath,
      projectKey: editor.projectKey,
      projectLabel: editor.projectLabel,
      savedAt: new Date().toISOString()
    });
  } catch (err) {
    emit('remote-edit:status', {
      id: editorId,
      status: 'error',
      remotePath: editor.remotePath,
      localPath: editor.localPath,
      projectKey: editor.projectKey,
      projectLabel: editor.projectLabel,
      message: err.message
    });
  } finally {
    editor.saving = false;
    if (editor.queued) {
      editor.queued = false;
      editor.timer = setTimeout(() => uploadRemoteEditorFile(editorId), 350);
    }
  }
}

function registerRemoteEditor(editor) {
  const existingKey = [...activeRemoteEditors.entries()].find(([, current]) => (
    String(current.terminalId) === String(editor.terminalId) && current.remotePath === editor.remotePath
  ));
  if (existingKey) {
    const [oldId, oldEditor] = existingKey;
    try { clearTimeout(oldEditor.timer); } catch {}
    try { fs.unwatchFile(oldEditor.localPath, oldEditor.watchHandler); } catch {}
    activeRemoteEditors.delete(oldId);
  }

  const watchHandler = (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    const current = activeRemoteEditors.get(editor.id);
    if (!current) return;
    clearTimeout(current.timer);
    current.timer = setTimeout(() => uploadRemoteEditorFile(editor.id), 700);
  };

  const nextEditor = { ...editor, watchHandler, timer: null, saving: false, queued: false };
  activeRemoteEditors.set(editor.id, nextEditor);
  fs.watchFile(editor.localPath, { interval: 650 }, watchHandler);
  return nextEditor;
}


ipcMain.handle('clipboard:write-text', async (_event, text) => {
  const value = String(text || '');
  clipboard.writeText(value);
  return { ok: true, chars: value.length };
});

ipcMain.handle('clipboard:read-text', async () => ({
  ok: true,
  text: clipboard.readText()
}));

ipcMain.handle('app:info', () => ({
  platform: process.platform,
  version: app.getVersion(),
  userData: app.getPath('userData')
}));

ipcMain.handle('dialog:select-key', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'SSH Private Key Seç',
    properties: ['openFile'],
    filters: [
      { name: 'SSH Keys', extensions: ['pem', 'key', 'ppk', ''] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('profiles:list', () => readProfiles());

ipcMain.handle('profiles:save', (_event, rawProfile) => {
  const profile = sanitizeProfile(rawProfile || {});
  const profiles = readProfiles();
  const next = profiles.filter((item) => item.id !== profile.id);
  next.unshift(profile);
  writeProfiles(next);
  return profile;
});

ipcMain.handle('profiles:remove', (_event, id) => {
  const profiles = readProfiles().filter((item) => item.id !== id);
  writeProfiles(profiles);
  return true;
});

ipcMain.handle('ssh:start-terminal', async (_event, payload) => {
  const terminalId = String(payload.terminalId || crypto.randomUUID());
  const cols = Number(payload.cols || 120);
  const rows = Number(payload.rows || 34);
  const config = buildSshConfig(payload);
  const conn = new Client();

  let proxyStream = null;
  if (payload.proxyCommand) {
    try {
      proxyStream = createProxyStream(payload.proxyCommand);
      delete config.host;
      delete config.port;
      config.sock = proxyStream;
    } catch (err) {
      return { ok: false, error: `Proxy başlatılamadı: ${err.message}` };
    }
  }

  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          emit('ssh:error', { terminalId, message: err.message });
          try { conn.end(); } catch {}
          return safeResolve({ ok: false, error: err.message });
        }

        terminals.set(terminalId, { conn, stream, host: payload.host, username: payload.username, homePath: payload.username === 'root' ? '/root' : `/home/${payload.username}` });

        stream.on('data', (data) => emit('ssh:data', { terminalId, data: data.toString('utf8') }));
        stream.stderr?.on('data', (data) => emit('ssh:data', { terminalId, data: data.toString('utf8') }));
        stream.on('close', (code, signal) => {
          terminals.delete(terminalId);
          emit('ssh:exit', { terminalId, code, signal });
          try { conn.end(); } catch {}
          try { proxyStream?._proc?.kill(); } catch {}
        });
        stream.on('error', (streamErr) => emit('ssh:error', { terminalId, message: streamErr.message }));

        emit('ssh:ready', { terminalId });
        safeResolve({ ok: true, terminalId });
      });
    });

    conn.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
      finish([String(payload.password || '')]);
    });

    conn.on('error', (err) => {
      try { proxyStream?._proc?.kill(); } catch {}
      emit('ssh:error', { terminalId, message: err.message });
      safeResolve({ ok: false, error: err.message });
    });

    conn.on('end', () => emit('ssh:exit', { terminalId, code: null, signal: 'end' }));
    conn.on('close', () => emit('ssh:exit', { terminalId, code: null, signal: 'close' }));

    try {
      conn.connect(config);
    } catch (err) {
      try { proxyStream?._proc?.kill(); } catch {}
      emit('ssh:error', { terminalId, message: err.message });
      safeResolve({ ok: false, error: err.message });
    }
  });
});

ipcMain.handle('ssh:write', (_event, { terminalId, data }) => {
  const item = terminals.get(String(terminalId));
  if (!item?.stream) return false;
  item.stream.write(String(data));
  return true;
});

ipcMain.handle('ssh:resize', (_event, { terminalId, cols, rows }) => {
  const item = terminals.get(String(terminalId));
  if (!item?.stream) return false;
  try {
    item.stream.setWindow(Number(rows), Number(cols), 0, 0);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('ssh:stop-terminal', (_event, terminalId) => {
  closeTerminal(String(terminalId));
  return true;
});

ipcMain.handle('ssh:stop-all', () => {
  closeAllTerminals();
  return true;
});


function projectDeployKey(terminalId, projectKey) {
  return `${terminalId}:${projectKey}`;
}

function updateDeployProgressFromRemote(text, progress, remoteStart = 55, remoteRange = 40) {
  const raw = String(text || '');
  const match = raw.match(/\[(\d+)\/(\d+)\]/);
  if (!match) return;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return;
  const remoteProgress = remoteStart + Math.round((current / total) * remoteRange);
  const line = raw.split('\n').find((itemLine) => itemLine.includes(match[0])) || raw.trim();
  progress(Math.max(remoteStart, Math.min(remoteStart + remoteRange, remoteProgress)), 'Sunucu', line.trim());
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}




/**
 * One deploy handler for every project.
 *
 * There were four, one per product, each about a hundred lines of the same
 * sequence with different constants baked in: check the local tree, tar it with
 * that project's exclusions, upload the archive and its remote script, run the
 * script, stream the output. Adding a fifth product meant copying the file
 * again, and a fix to the upload path was three edits that could disagree.
 *
 * The project descriptor now supplies what differed. It comes from
 * config/console.json, so the remote layout of a real deployment stays out of
 * the repository, and a project the config does not define does not exist as
 * far as this handler is concerned.
 */
const DEFAULT_TAR_EXCLUDES = [
  '.git', 'node_modules', '.next', 'dist', 'release', '*.log',
  './.env', './.env.*'
];

ipcMain.handle('deploy:run', async (_event, payload = {}) => {
  const project = payload.project || {};
  const projectKey = String(project.key || '');
  const projectLabel = String(project.label || projectKey || 'proje');

  if (!projectKey) throw new Error('Deploy isteği bir proje anahtarı taşımıyor.');
  if (!project.script) throw new Error(`"${projectLabel}" için deploy scripti tanımlı değil.`);

  const terminalId = String(payload.terminalId || '');
  const item = getTerminal(terminalId);
  if (!item?.conn) throw new Error('Aktif SSH bağlantısı bulunamadı. Önce sol panelden sunucuya giriş yap.');

  const activeKey = projectDeployKey(terminalId, projectKey);
  if (activeDeploys.has(activeKey)) throw new Error(`Bu sunucu için zaten çalışan bir ${projectLabel} güncellemesi var.`);

  const localProjectPath = path.resolve(resolveHome(String(payload.localProjectPath || project.localProjectPath || '')));
  const remoteDir = cleanRemotePath(String(payload.remoteDir || project.remoteDir || ''), '/tmp');

  // The script name is resolved against the bundled scripts directory, basename
  // first: a descriptor is configuration, and configuration that can name
  // ../../etc/anything is a path-traversal hole rather than a feature.
  const scriptName = path.basename(String(project.script));
  const localRemoteScript = path.join(__dirname, 'scripts', scriptName);

  const deployId = crypto.randomUUID();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-deploy-'));
  const archivePath = path.join(tmpDir, 'source.tgz');
  const remoteArchive = `/tmp/console-deploy-${deployId}.tgz`;
  const remoteScript = `/tmp/console-deploy-${deployId}.sh`;

  activeDeploys.add(activeKey);

  const log = (line, extra = {}) => emitDeploy({ deployId, projectKey, projectLabel, line, ...extra });
  const progress = (value, step, line) => emitDeploy({ deployId, projectKey, projectLabel, progress: value, step, line });

  try {
    if (!localProjectPath) throw new Error(`"${projectLabel}" için lokal proje yolu tanımlı değil.`);
    if (!fs.existsSync(localProjectPath)) throw new Error(`Lokal proje klasörü bulunamadı: ${localProjectPath}`);
    if (!fs.existsSync(localRemoteScript)) throw new Error(`Deploy script şablonu bulunamadı: ${localRemoteScript}`);

    progress(3, 'Hazırlık', 'Lokal proje kontrol edildi.');
    log(`Lokal kaynak: ${localProjectPath}`);
    log(`Canlı hedef: ${remoteDir}`);

    progress(9, 'Paketleniyor', 'Canlıya gönderilecek dosyalar hazırlanıyor...');
    const excludes = Array.isArray(project.excludes) && project.excludes.length
      ? project.excludes
      : DEFAULT_TAR_EXCLUDES;
    const tarArgs = [
      '-czf', archivePath,
      ...excludes.map((pattern) => `--exclude=${pattern}`),
      '-C', localProjectPath,
      '.'
    ];
    await runLocalCommand('tar', tarArgs, { onData: (text) => {
      const trimmed = text.trim();
      if (trimmed) log(trimmed, { kind: 'local' });
    }});

    const archiveSize = fs.statSync(archivePath).size;
    progress(20, 'Paket hazır', `Paket hazır: ${(archiveSize / 1024 / 1024).toFixed(1)} MB`);

    await withSftp(terminalId, async (sftp) => {
      progress(22, 'Aktarım', 'Deploy scripti sunucuya gönderiliyor...');
      await uploadFileWithProgress(sftp, localRemoteScript, remoteScript, () => {});
      await uploadFileWithProgress(sftp, archivePath, remoteArchive, (percent) => {
        progress(24 + Math.round(percent * 0.28), 'Aktarım', `Sunucuya aktarılıyor: %${percent}`);
      });
    });

    progress(54, 'Sunucu hazırlığı', 'Sunucuda deploy akışı başlatılıyor...');
    const command = [
      'bash',
      shQuoteLocal(remoteScript),
      shQuoteLocal(remoteArchive),
      shQuoteLocal(remoteDir)
    ].join(' ');

    await execRemoteCommand(item.conn, command, (text) => {
      log(text, { kind: 'remote' });
      updateDeployProgressFromRemote(text, progress);
    });

    progress(100, 'Tamamlandı', `${projectLabel} güncellendi.`);
    return { ok: true, deployId, remoteDir };
  } catch (err) {
    emitDeploy({ deployId, projectKey, projectLabel, progress: 100, step: 'Hata', line: err.message, error: err.message });
    throw err;
  } finally {
    activeDeploys.delete(activeKey);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});


/**
 * Maintenance flag, for projects that declare one.
 *
 * These were three handlers with one product's flag path compiled in. The path
 * is a deployment fact, so it comes from the project descriptor; a project
 * without `maintenanceFlag` has no maintenance switch and the UI offers none.
 */
function maintenanceFlagPath(project) {
  const flag = String(project?.maintenanceFlag || '').trim();
  if (!flag) throw new Error('Bu proje için bakım modu bayrağı tanımlı değil.');
  // Absolute, no traversal, no shell metacharacters. This value is interpolated
  // into a remote command, so a config file is not permitted to become one.
  if (!/^\/[A-Za-z0-9._/-]+$/.test(flag) || flag.includes('..')) {
    throw new Error(`Geçersiz bakım bayrağı yolu: ${flag}`);
  }
  return flag;
}

ipcMain.handle('maintenance:on', async (_event, payload = {}) => {
  const item = getTerminal(String(payload.terminalId || ''));
  const flag = maintenanceFlagPath(payload.project);
  const dir = flag.replace(/\/[^/]+$/, '');
  const command = `mkdir -p ${shQuoteLocal(dir)} && touch ${shQuoteLocal(flag)} && chmod 755 ${shQuoteLocal(dir)} && chmod 644 ${shQuoteLocal(flag)} && echo MAINTENANCE_ON`;
  const result = await execRemoteCommand(item.conn, command, () => {});
  if (!result.output.includes('MAINTENANCE_ON')) throw new Error('Bakım modu açılamadı.');
  return { ok: true, status: 'on' };
});

ipcMain.handle('maintenance:off', async (_event, payload = {}) => {
  const item = getTerminal(String(payload.terminalId || ''));
  const flag = maintenanceFlagPath(payload.project);
  const command = `rm -f ${shQuoteLocal(flag)} && echo MAINTENANCE_OFF`;
  const result = await execRemoteCommand(item.conn, command, () => {});
  if (!result.output.includes('MAINTENANCE_OFF')) throw new Error('Bakım modu kapatılamadı.');
  return { ok: true, status: 'off' };
});

ipcMain.handle('maintenance:status', async (_event, payload = {}) => {
  const item = getTerminal(String(payload.terminalId || ''));
  const flag = maintenanceFlagPath(payload.project);
  const command = `[ -f ${shQuoteLocal(flag)} ] && echo MAINTENANCE_STATE_ON || echo MAINTENANCE_STATE_OFF`;
  const result = await execRemoteCommand(item.conn, command, () => {});
  return { ok: true, status: result.output.includes('MAINTENANCE_STATE_ON') ? 'on' : 'off' };
});


ipcMain.handle('sftp:list', async (_event, { terminalId, path: remotePath }) => {
  const requestedPath = cleanRemotePath(remotePath, '/root');
  return withSftp(terminalId, (sftp) => new Promise((resolve, reject) => {
    sftp.readdir(requestedPath, (err, entries) => {
      if (err) return reject(err);
      const files = entries
        .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
        .map((entry) => attrsToFile(entry, requestedPath))
        .sort((a, b) => {
          if (a.type === 'directory' && b.type !== 'directory') return -1;
          if (a.type !== 'directory' && b.type === 'directory') return 1;
          return a.name.localeCompare(b.name, 'tr');
        });
      resolve({ ok: true, path: requestedPath, parent: parentRemotePath(requestedPath), files });
    });
  }));
});

ipcMain.handle('sftp:read-file', async (_event, { terminalId, path: remotePath }) => {
  const filePath = cleanRemotePath(remotePath, '/root');
  return withSftp(terminalId, (sftp) => new Promise((resolve, reject) => {
    sftp.stat(filePath, async (statErr, attrs) => {
      if (statErr) return reject(statErr);
      if (attrs.isDirectory()) return reject(new Error('Klasör metin dosyası gibi açılamaz.'));
      if ((attrs.size || 0) > 2 * 1024 * 1024) return reject(new Error('Dosya çok büyük. Önizleme limiti 2MB.'));
      try {
        const content = await readStreamToString(sftp.createReadStream(filePath));
        resolve({ ok: true, path: filePath, content, size: attrs.size || 0 });
      } catch (err) {
        reject(err);
      }
    });
  }));
});

ipcMain.handle('sftp:write-file', async (_event, { terminalId, path: remotePath, content }) => {
  const filePath = cleanRemotePath(remotePath, '/root');
  return withSftp(terminalId, async (sftp) => {
    await writeStringToStream(sftp.createWriteStream(filePath), content);
    return { ok: true, path: filePath };
  });
});


ipcMain.handle('sftp:open-external-editor', async (_event, { terminalId, path: remotePath, options = {} }) => {
  const requestedPath = cleanRemotePath(remotePath, '/root');
  const fallbackPaths = Array.isArray(options.fallbackPaths)
    ? options.fallbackPaths.map((candidate) => cleanRemotePath(candidate, '/root')).filter(Boolean)
    : [];
  const candidates = [...new Set([requestedPath, ...fallbackPaths])];
  const projectLabel = String(options.projectLabel || path.basename(requestedPath) || 'Remote .env').trim();
  const projectKey = String(options.projectKey || '').trim();
  const allowCreate = options.allowCreate === true;
  const editorId = crypto.randomUUID();

  let filePath = requestedPath;
  let content = '';
  let remoteSize = 0;
  let remoteExists = false;

  await withSftp(terminalId, (sftp) => new Promise((resolve, reject) => {
    let index = 0;

    const tryNext = () => {
      const candidatePath = candidates[index++];
      if (!candidatePath) {
        if (allowCreate) {
          filePath = requestedPath;
          remoteExists = false;
          content = '';
          return resolve();
        }
        return reject(new Error(`Ortam dosyası bulunamadı. Kontrol edilen yollar: ${candidates.join(', ')}`));
      }

      sftp.stat(candidatePath, async (statErr, attrs) => {
        if (statErr) return tryNext();
        if (attrs.isDirectory()) return reject(new Error(`${candidatePath} klasör; metin dosyası olarak açılamaz.`));
        if ((attrs.size || 0) > 2 * 1024 * 1024) return reject(new Error('Dosya çok büyük. Dış editör limiti 2MB.'));
        try {
          filePath = candidatePath;
          remoteExists = true;
          remoteSize = attrs.size || 0;
          content = await readStreamToString(sftp.createReadStream(candidatePath), 2 * 1024 * 1024);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    };

    tryNext();
  }));

  const localPath = path.join(remoteEditBaseDir(), safeLocalEditorName(filePath, projectLabel));
  fs.writeFileSync(localPath, content, { encoding: 'utf8', mode: 0o600 });

  registerRemoteEditor({
    id: editorId,
    terminalId: String(terminalId),
    remotePath: filePath,
    localPath,
    projectKey,
    projectLabel,
    lastHash: hashText(content)
  });

  emit('remote-edit:status', {
    id: editorId,
    status: 'opened',
    requestedPath,
    remotePath: filePath,
    localPath,
    projectKey,
    projectLabel,
    remoteExists,
    remoteSize
  });

  const editorLaunch = await openPlainTextEditor(localPath);

  return { ok: true, id: editorId, remotePath: filePath, localPath, remoteExists, remoteSize, editor: editorLaunch.editor };
});

ipcMain.handle('sftp:mkdir', async (_event, { terminalId, path: remotePath }) => {
  const dirPath = cleanRemotePath(remotePath, '/root');
  return withSftp(terminalId, (sftp) => new Promise((resolve, reject) => {
    sftp.mkdir(dirPath, (err) => {
      if (err) return reject(err);
      resolve({ ok: true, path: dirPath });
    });
  }));
});

ipcMain.handle('sftp:delete', async (_event, { terminalId, path: remotePath, type }) => {
  const targetPath = cleanRemotePath(remotePath, '/root');
  return withSftp(terminalId, (sftp) => new Promise((resolve, reject) => {
    const done = (err) => {
      if (err) return reject(err);
      resolve({ ok: true, path: targetPath });
    };
    if (type === 'directory') sftp.rmdir(targetPath, done);
    else sftp.unlink(targetPath, done);
  }));
});

ipcMain.handle('sftp:rename', async (_event, { terminalId, from, to }) => {
  const fromPath = cleanRemotePath(from, '/root');
  const toPath = cleanRemotePath(to, '/root');
  return withSftp(terminalId, (sftp) => new Promise((resolve, reject) => {
    sftp.rename(fromPath, toPath, (err) => {
      if (err) return reject(err);
      resolve({ ok: true, from: fromPath, to: toPath });
    });
  }));
});
