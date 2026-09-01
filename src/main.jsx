import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

const api = window.serverConsole;

import { defaultServers, defaultProjects, validateConfig } from './config.js'

// The fleet is configuration, not source.
//
// preload reads config/console.json (gitignored) and hands it over before this
// bundle runs, so hosts, usernames, key paths and remote directory layouts stay
// on the machine that needs them. Without a config file the app starts against
// the placeholder in src/config.js rather than refusing to open — a console you
// cannot launch is no help when you are trying to configure it.
const loadedConfig = (typeof window !== 'undefined' && window.consoleConfig) || null

if (loadedConfig) {
  const problems = validateConfig(loadedConfig)
  // Reported rather than thrown: a bad entry should not take the whole console
  // down, and the message names the field so it can be fixed in one edit.
  if (problems.length) console.error('config/console.json:\n  ' + problems.join('\n  '))
}

const managedServers = loadedConfig?.servers?.length ? loadedConfig.servers : defaultServers
const deployProjects = Array.isArray(loadedConfig?.projects) ? loadedConfig.projects : defaultProjects

const defaultConnection = {
  label: managedServers[0].title,
  host: managedServers[0].host,
  port: managedServers[0].port,
  username: managedServers[0].username,
  password: '',
  keyPath: '',
  proxyCommand: '',
  passphrase: ''
};

const quickCommands = [
  { label: 'Clear', command: 'clear\n', accent: true },
  { label: 'Sistem', command: 'uptime && free -h && df -h\n' },
  { label: 'Nginx', command: 'systemctl status nginx --no-pager\n' },
  { label: 'Siteler', command: 'ls -la /etc/nginx/sites-enabled && echo && ls -la /var/www\n' },
  { label: 'Nginx Test', command: 'nginx -t\n' },
  { label: 'PM2', command: 'pm2 list\n' }
];

const locations = [
  { label: 'Root', path: '/root' },
  { label: 'Web', path: '/var/www' },
  { label: 'Nginx', path: '/etc/nginx' },
  { label: 'Logs', path: '/var/log' },
  { label: 'Home', path: '/home' },
  { label: 'Opt', path: '/opt' }
];

function makeTerminalTitle(config, index) {
  const label = config?.label || config?.host || 'sunucu';
  return `${label} · T${index}`;
}

function defaultPathFor(config) {
  return config?.username === 'root' ? '/root' : `/home/${config?.username || ''}`;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function joinRemotePath(base, name) {
  if (!base || base === '/') return `/${name}`;
  return `${base.replace(/\/$/, '')}/${name}`;
}

function fileIcon(file) {
  if (file.type === 'directory') return '▰';
  if (file.type === 'symlink') return '↗';
  if (/\.conf$/i.test(file.name)) return '⚙';
  if (/\.(zip|tar|gz|rar|7z)$/i.test(file.name)) return '◈';
  if (/\.(png|jpg|jpeg|webp|svg|gif)$/i.test(file.name)) return '▧';
  if (/\.(js|jsx|ts|tsx|json|css|html|md|env|yml|yaml|sh)$/i.test(file.name)) return '</>';
  return '□';
}

function fileTone(file) {
  if (file.type === 'directory') return 'folder';
  if (file.type === 'symlink') return 'link';
  if (/\.conf$/i.test(file.name)) return 'config';
  if (/\.(js|jsx|ts|tsx|json|css|html|md|env|yml|yaml|sh)$/i.test(file.name)) return 'code';
  if (/\.(png|jpg|jpeg|webp|svg|gif)$/i.test(file.name)) return 'media';
  if (/\.(zip|tar|gz|rar|7z)$/i.test(file.name)) return 'archive';
  return 'file';
}

function compactPath(path = '/') {
  if (path.length <= 46) return path;
  const parts = path.split('/').filter(Boolean);
  return `/${parts.slice(0, 2).join('/')}/…/${parts.slice(-2).join('/')}`;
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) return '-';
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).format(new Date(value));
  } catch { return '-'; }
}

/* ═══════════════════════════════════════════════════════════════════
   NOYSEC COMMAND CENTER
   ═══════════════════════════════════════════════════════════════════ */
function ProjectCommandCenter({
  project, maintenanceState, connectedToSelectedServer,
  activeServer, deployState, onDeploy, onToggleMaintenance, onOpenEnv
}) {
  const mState = maintenanceState[project.key] || {};
  const isOnMaintenance = mState.status === 'on';
  const isLoading = Boolean(mState.loading);
  const isDeploying = deployState.running && deployState.projectKey === project.key;
  const canAct = connectedToSelectedServer && !deployState.running && !isLoading;
  const statusKnown = mState.status !== undefined;

  return (
    <div className="ns-station">
      <div className="ns-ambient-top" />
      <div className="ns-ambient-right" />

      {/* ── Header ── */}
      <div className="ns-header">
        <div className="ns-shield-wrap">
          <svg viewBox="0 0 48 56" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
              <linearGradient id="sg" x1="0" y1="0" x2="48" y2="56" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#6d28d9"/>
                <stop offset="100%" stopColor="#a78bfa"/>
              </linearGradient>
              <linearGradient id="sg2" x1="0" y1="0" x2="48" y2="56" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.5"/>
                <stop offset="100%" stopColor="#c4b5fd" stopOpacity="0.2"/>
              </linearGradient>
              <filter id="sf">
                <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
            </defs>
            <path d="M24 2L6 10V28C6 39.5 13.8 50.3 24 52C34.2 50.3 42 39.5 42 28V10L24 2Z"
              fill="url(#sg)" opacity="0.92" filter="url(#sf)"/>
            <path d="M24 2L6 10V28C6 39.5 13.8 50.3 24 52C34.2 50.3 42 39.5 42 28V10L24 2Z"
              fill="url(#sg2)"/>
            <path d="M24 2L6 10V28C6 39.5 13.8 50.3 24 52C34.2 50.3 42 39.5 42 28V10L24 2Z"
              stroke="rgba(196,181,253,0.55)" strokeWidth="1.5" fill="none"/>
            <path d="M18 19H21.5L24 25.5L26.5 19H30V37H27V27L24 33.5L21 27V37H18V19Z"
              fill="white" opacity="0.95"/>
          </svg>
        </div>

        <div className="ns-meta">
          <div className="ns-title-row">
            <h2>NoySec Platform</h2>
            {statusKnown ? (
              <div className={`ns-badge ${isOnMaintenance ? 'ns-badge--maint' : 'ns-badge--live'}`}>
                <span className="ns-badge-dot" />
                {isOnMaintenance ? 'BAKIM' : 'CANLI'}
              </div>
            ) : (
              <div className="ns-badge ns-badge--checking">
                <span className="ns-badge-dot" />
                KONTROL
              </div>
            )}
          </div>
          <p className="ns-sub">{project.domain} &nbsp;·&nbsp; {activeServer.host}:{activeServer.port}</p>
          {!connectedToSelectedServer && (
            <p className="ns-warn">SSH bağlantısı kur → eylemler aktif olacak</p>
          )}
        </div>
      </div>

      {/* ── Deploy Button ── */}
      <button
        className="ns-deploy"
        onClick={() => onDeploy(project)}
        disabled={deployState.running || !connectedToSelectedServer}
        title={project.description}
      >
        <div className="ns-deploy-orb">
          {isDeploying ? (
            <span className="ns-spinner" />
          ) : (
            <svg viewBox="0 0 22 22" fill="none">
              <path d="M11 3L17 9M11 3L5 9M11 3V15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3 19H19" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/>
            </svg>
          )}
        </div>
        <div className="ns-deploy-body">
          <strong>{isDeploying ? 'Deploy sürüyor…' : 'NoySec Güncelle'}</strong>
          <small>Localdeki tüm değişiklikler → sunucu · build · infra · restart · sağlık kontrol</small>
        </div>
        <div className="ns-deploy-chevron">›</div>
      </button>

      {/* ── Maintenance + Env ── */}
      <div className="ns-controls">
        <button
          className={`ns-ctrl ns-ctrl--danger ${isOnMaintenance ? 'ns-ctrl--active' : ''}`}
          onClick={() => onToggleMaintenance(project, true)}
          disabled={!canAct}
          title={`${project.domain} sitesini bakım sayfasına al`}
        >
          <div className="ns-ctrl-ico">⛔</div>
          <div className="ns-ctrl-body">
            <strong>Bakıma Al</strong>
            <small>{isOnMaintenance ? '● Aktif' : 'Pasif'}</small>
          </div>
        </button>

        <button
          className={`ns-ctrl ns-ctrl--success ${mState.status === 'off' ? 'ns-ctrl--active' : ''}`}
          onClick={() => onToggleMaintenance(project, false)}
          disabled={!canAct}
          title={`${project.domain} sitesini canlıya al`}
        >
          <div className="ns-ctrl-ico">✓</div>
          <div className="ns-ctrl-body">
            <strong>Bakımdan Çıkar</strong>
            <small>{mState.status === 'off' ? '● Canlı' : ''}</small>
          </div>
        </button>

        {project.envPath && (
          <button
            className="ns-ctrl ns-ctrl--env"
            onClick={() => onOpenEnv(project)}
            disabled={!connectedToSelectedServer || deployState.running}
            title={project.envPath}
          >
            <div className="ns-ctrl-ico">⚙</div>
            <div className="ns-ctrl-body">
              <strong>Ortam .env</strong>
              <small>Üretim değişkenleri</small>
            </div>
          </button>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   GENERIC PROJECT STRIP (non-NoySec servers)
   ═══════════════════════════════════════════════════════════════════ */
function ProjectStrip({
  activeServer, serverProjects, connectedToSelectedServer,
  deployState, maintenanceState, onDeploy, onToggleMaintenance, onOpenEnv
}) {
  return (
    <section className="project-strip">
      <div className="project-strip-copy">
        <span>Seçili Sunucu</span>
        <h1>{activeServer.title}</h1>
        <p>
          {activeServer.host || 'IP bilgisi bekleniyor'}
          {connectedToSelectedServer
            ? <span className="conn-badge">● Bağlı</span>
            : <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 10 }}>Bağlantı bekliyor</span>}
        </p>
      </div>
      <div className="project-actions">
        {serverProjects.length === 0 && <div className="empty-action">Bu sunucu için proje tanımlanmadı.</div>}
        {serverProjects.map((project) => (
          <div
            className={`project-control ${project.supportsMaintenance ? 'project-control--maintenance' : ''} ${!project.envPath ? 'project-control--no-env' : ''}`}
            key={project.key}
          >
            <button
              className={`project-button ${project.accent}`}
              onClick={() => onDeploy(project)}
              disabled={deployState.running || (!project.pending && !connectedToSelectedServer)}
              title={project.description}
            >
              <span>{project.icon}</span>
              <strong>{project.buttonLabel}</strong>
              <small>{project.domain}</small>
            </button>
            {project.envPath && (
              <button
                className="env-button"
                onClick={() => onOpenEnv(project)}
                disabled={!connectedToSelectedServer || deployState.running}
                title={project.envPath}
              >
                <span>{project.envButtonLabel?.includes('.local') ? '.local' : '.env'}</span>
                <strong>{project.envButtonLabel || 'Proje .env'}</strong>
              </button>
            )}
            {project.supportsMaintenance && (
              <>
                <button
                  className={`maintenance-button maintenance-on ${maintenanceState[project.key]?.status === 'on' ? 'active' : ''}`}
                  onClick={() => onToggleMaintenance(project, true)}
                  disabled={!connectedToSelectedServer || deployState.running || maintenanceState[project.key]?.loading}
                >
                  <span>⛔</span>
                  <strong>Bakım Al</strong>
                  <small>{maintenanceState[project.key]?.status === 'on' ? 'Aktif' : ''}</small>
                </button>
                <button
                  className={`maintenance-button maintenance-off ${maintenanceState[project.key]?.status === 'off' ? 'active' : ''}`}
                  onClick={() => onToggleMaintenance(project, false)}
                  disabled={!connectedToSelectedServer || deployState.running || maintenanceState[project.key]?.loading}
                >
                  <span>✓</span>
                  <strong>Bakımdan Çıkar</strong>
                  <small>{maintenanceState[project.key]?.status === 'off' ? 'Canlı' : ''}</small>
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   APP
   ═══════════════════════════════════════════════════════════════════ */
function App() {
  const [profiles, setProfiles] = useState([]);
  const [selectedServerId, setSelectedServerId] = useState(managedServers[0].id);
  const [form, setForm] = useState(defaultConnection);
  const [tabs, setTabs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [status, setStatus] = useState('Hazır');
  const [isConnecting, setIsConnecting] = useState(false);
  const [appInfo, setAppInfo] = useState(null);
  const [remotePath, setRemotePath] = useState('/root');
  const [files, setFiles] = useState([]);
  const [fileStatus, setFileStatus] = useState('Sunucu dosya sistemi hazır.');
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [editor, setEditor] = useState(null);
  const [clearTick, setClearTick] = useState(0);
  const [copyTick, setCopyTick] = useState(0);
  const [deployState, setDeployState] = useState({
    open: false, running: false, progress: 0, step: 'Hazır',
    logs: [], error: null, done: false, projectKey: null,
    projectLabel: '', successText: '', steps: []
  });
  const [maintenanceState, setMaintenanceState] = useState({});

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId), [tabs, activeId]);
  const connected = activeTab?.state === 'connected';
  const activeServer = useMemo(
    () => managedServers.find((s) => s.id === selectedServerId) || managedServers[0],
    [selectedServerId]
  );
  const serverProjects = useMemo(
    () => deployProjects.filter((p) => p.serverId === selectedServerId),
    [selectedServerId]
  );
  const connectedToSelectedServer =
    connected && activeTab?.config?.host === form.host && activeTab?.config?.username === form.username;
  const folderCount = files.filter((f) => f.type === 'directory').length;
  const fileCount = files.filter((f) => f.type !== 'directory').length;

  const refreshProfiles = useCallback(async () => {
    const list = await api.profiles.list();
    setProfiles(list);
  }, []);

  useEffect(() => {
    refreshProfiles();
    api.appInfo().then(setAppInfo).catch(() => {});
  }, [refreshProfiles]);

  useEffect(() => {
    if (!api.deploy?.onEvent) return undefined;
    const off = api.deploy.onEvent((event) => {
      const line = String(event.line || '').trimEnd();
      setDeployState((cur) => ({
        ...cur,
        open: true,
        running: !event.error && event.progress !== 100,
        progress: typeof event.progress === 'number' ? event.progress : cur.progress,
        step: event.step || cur.step,
        error: event.error || cur.error,
        done: !event.error && event.progress === 100,
        projectKey: event.projectKey || cur.projectKey,
        projectLabel: event.projectLabel || cur.projectLabel,
        successText: event.successText || cur.successText,
        steps: event.steps || cur.steps,
        logs: line ? [...cur.logs, line].slice(-260) : cur.logs
      }));
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    const off = api.remoteEdit?.onStatus?.((event) => {
      if (!event) return;
      const lbl = event.projectLabel || 'Remote dosya';
      if (event.status === 'opened') {
        setFileStatus(`${lbl} metin editöründe açıldı. Ctrl+S ile otomatik kaydedilir.`);
        setStatus(`${lbl} dış editörde açıldı.`);
      } else if (event.status === 'saved') {
        const t = event.savedAt ? new Date(event.savedAt).toLocaleTimeString('tr-TR') : '';
        setFileStatus(`${lbl} kaydedildi${t ? ` · ${t}` : ''}.`);
      } else if (event.status === 'error') {
        setFileStatus(`${lbl} kaydetme hatası: ${event.message || 'Bilinmeyen hata'}`);
      }
    });
    return () => off?.();
  }, []);

  const loadDirectory = useCallback(async (path = remotePath) => {
    if (!activeId) { setFileStatus('Dosya sistemini görmek için önce sunucuya giriş yap.'); return; }
    setIsLoadingFiles(true);
    setFileStatus(`${path} okunuyor...`);
    try {
      const result = await api.files.list(activeId, path);
      setRemotePath(result.path);
      setFiles(result.files || []);
      setSelectedFile(null);
      setEditor(null);
      setFileStatus(`${result.files?.length || 0} öğe listelendi.`);
    } catch (err) {
      setFileStatus(`Dosya hatası: ${err.message}`);
    } finally {
      setIsLoadingFiles(false);
    }
  }, [activeId, remotePath]);

  useEffect(() => {
    const offReady = api.onTerminalReady(({ terminalId }) => {
      setTabs((cur) => cur.map((t) => t.id === terminalId ? { ...t, state: 'connected' } : t));
      setStatus('Bağlantı hazır');
    });
    const offError = api.onTerminalError(({ terminalId, message }) => {
      setTabs((cur) => cur.map((t) => t.id === terminalId ? { ...t, state: 'error', error: message } : t));
      setStatus(`Hata: ${message}`);
    });
    const offExit = api.onTerminalExit(({ terminalId }) => {
      setTabs((cur) => cur.map((t) => t.id === terminalId ? { ...t, state: 'closed' } : t));
    });
    return () => { offReady(); offError(); offExit(); };
  }, []);

  useEffect(() => {
    if (!connected || !activeTab) return;
    const home = defaultPathFor(activeTab.config);
    setRemotePath(home);
    setTimeout(() => loadDirectory(home), 120);
  }, [activeId, connected]);

  const updateForm = (key, value) => setForm((cur) => ({ ...cur, [key]: value }));

  const selectServer = (server) => {
    setSelectedServerId(server.id);
    setForm({ label: server.title, host: server.host, port: server.port, username: server.username, password: '', keyPath: server.keyPath || '', proxyCommand: server.proxyCommand || '', passphrase: '' });
    setStatus(server.host ? `${server.title} seçildi.` : `${server.title} seçildi. IP eklendiğinde aktif olacak.`);
  };

  const loadProfile = (profile) => {
    setSelectedServerId('custom');
    setForm({ ...defaultConnection, ...profile, password: '', passphrase: '' });
    setStatus(`${profile.label || profile.host} forma yüklendi`);
  };

  const saveProfile = async () => {
    try {
      const saved = await api.profiles.save(form);
      await refreshProfiles();
      setForm((cur) => ({ ...cur, id: saved.id }));
      setStatus('Profil kaydedildi.');
    } catch (err) { setStatus(`Profil hatası: ${err.message}`); }
  };

  const removeProfile = async (id) => {
    await api.profiles.remove(id);
    await refreshProfiles();
    setStatus('Profil silindi');
  };

  const startTerminal = async (sourceConfig = form) => {
    if (!sourceConfig.host) { setStatus('Bu sunucu için IP/host bilgisi eksik.'); return; }
    const terminalId = crypto.randomUUID();
    const newTab = {
      id: terminalId,
      title: makeTerminalTitle(sourceConfig, tabs.length + 1),
      config: { ...sourceConfig, password: sourceConfig.password || '', passphrase: sourceConfig.passphrase || '' },
      state: 'connecting',
      createdAt: Date.now()
    };
    setTabs((cur) => [...cur, newTab]);
    setActiveId(terminalId);
    setIsConnecting(true);
    setStatus(`${sourceConfig.host} sunucusuna bağlanılıyor...`);
    try {
      const result = await api.ssh.startTerminal({ ...sourceConfig, terminalId });
      if (!result.ok) {
        setTabs((cur) => cur.map((t) => t.id === terminalId ? { ...t, state: 'error', error: result.error } : t));
        setStatus(`Bağlantı başarısız: ${result.error}`);
      } else {
        setStatus('Terminal açıldı');
      }
    } catch (err) {
      setTabs((cur) => cur.map((t) => t.id === terminalId ? { ...t, state: 'error', error: err.message } : t));
      setStatus(`Bağlantı hatası: ${err.message}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const duplicateTerminal = async () => startTerminal(activeTab?.config || form);

  const closeTab = async (terminalId) => {
    await api.ssh.stopTerminal(terminalId);
    setTabs((cur) => {
      const next = cur.filter((t) => t.id !== terminalId);
      if (terminalId === activeId) setActiveId(next.at(-1)?.id || null);
      return next;
    });
  };

  const closeAll = async () => {
    await api.ssh.stopAll();
    setTabs([]); setActiveId(null); setFiles([]); setEditor(null); setSelectedFile(null);
    setStatus('Tüm terminaller kapatıldı');
    setFileStatus('Sunucu dosya sistemi hazır.');
  };

  const runQuickCommand = async (command) => {
    if (!activeId) return;
    if (command === 'clear\n') setClearTick((v) => v + 1);
    await api.ssh.write(activeId, command);
  };

  const clearTerminal = async () => {
    if (!activeId) return;
    setClearTick((v) => v + 1);
    await api.ssh.write(activeId, 'clear\n');
    setStatus('Terminal temizlendi');
  };

  const copyTerminal = () => {
    if (!activeId) return;
    setCopyTick((v) => v + 1);
    setStatus('Terminal çıktısı kopyalanıyor...');
  };

  const selectKey = async () => {
    const selected = await api.selectKeyFile();
    if (selected) updateForm('keyPath', selected);
  };

  const openDirectory = async (path) => loadDirectory(path);

  const openFile = async (file) => {
    setSelectedFile(file);
    setFileStatus(`${file.path} açılıyor...`);
    try {
      const result = await api.files.read(activeId, file.path);
      setEditor({ file, content: result.content, dirty: false });
      setFileStatus(`${file.name} düzenleme paneline açıldı.`);
    } catch (err) {
      setEditor(null);
      setFileStatus(`Dosya açılamadı: ${err.message}`);
    }
  };

  const openProjectEnv = async (project) => {
    if (!connectedToSelectedServer || !activeId) {
      setStatus(`${project.label} ortam dosyasını açmak için önce sunucuya giriş yap.`);
      return;
    }
    if (!project.envPath) {
      const msg = `${project.label} için ortam dosyası yolu tanımlı değil.`;
      window.alert(msg); setStatus(msg); return;
    }
    setEditor(null);
    setSelectedFile({ name: project.envButtonLabel || `${project.label} .env`, path: project.envPath, type: 'file', size: 0, modifiedAt: null });
    setFileStatus(`${project.envPath} metin editöründe açılıyor...`);
    try {
      const result = await api.files.openExternalEditor(activeId, project.envPath, {
        projectKey: project.key,
        projectLabel: project.envButtonLabel || project.label,
        fallbackPaths: project.envFallbackPaths || [],
        allowCreate: false
      });
      setFileStatus(`${project.envButtonLabel || project.label} açıldı. Ctrl+S ile otomatik kaydedilir.`);
      setStatus(`${project.envButtonLabel || project.label} dış metin editöründe açıldı.`);
    } catch (err) {
      setFileStatus(`Ortam dosyası açılamadı: ${err.message}`);
      setStatus(`Ortam dosyası açılamadı: ${err.message}`);
    }
  };

  const saveEditor = async () => {
    if (!editor || !activeId) return;
    setFileStatus(`${editor.file.name} kaydediliyor...`);
    try {
      await api.files.write(activeId, editor.file.path, editor.content);
      setEditor((cur) => cur ? { ...cur, dirty: false } : cur);
      setFileStatus(`${editor.file.name} kaydedildi.`);
    } catch (err) { setFileStatus(`Kaydetme hatası: ${err.message}`); }
  };

  const createFolder = async () => {
    if (!connected) return;
    const name = window.prompt('Yeni klasör adı');
    if (!name) return;
    try {
      await api.files.mkdir(activeId, joinRemotePath(remotePath, name.trim()));
      await loadDirectory(remotePath);
      setFileStatus(`${name} klasörü oluşturuldu.`);
    } catch (err) { setFileStatus(`Klasör oluşturulamadı: ${err.message}`); }
  };

  const renameSelected = async () => {
    if (!selectedFile) return;
    const nextName = window.prompt('Yeni ad', selectedFile.name);
    if (!nextName || nextName === selectedFile.name) return;
    try {
      await api.files.rename(activeId, selectedFile.path, joinRemotePath(remotePath, nextName.trim()));
      await loadDirectory(remotePath);
      setFileStatus('Yeniden adlandırıldı.');
    } catch (err) { setFileStatus(`Ad değiştirme hatası: ${err.message}`); }
  };

  const deleteSelected = async () => {
    if (!selectedFile) return;
    if (!window.confirm(`${selectedFile.name} silinsin mi? Bu işlem geri alınamaz.`)) return;
    try {
      await api.files.delete(activeId, selectedFile.path, selectedFile.type);
      setEditor(null); setSelectedFile(null);
      await loadDirectory(remotePath);
      setFileStatus('Silindi.');
    } catch (err) { setFileStatus(`Silme hatası: ${err.message}`); }
  };

  const openInTerminal = async (path = remotePath) => {
    if (!activeId) return;
    await api.ssh.write(activeId, `cd ${shQuote(path)} && clear && pwd && ls -la\n`);
  };

  // A project has a maintenance switch when it declares a flag path, not when
  // its key matches a name compiled into this file.
  const maintenanceApiFor = useCallback((project) => (project?.maintenanceFlag ? api.maintenance : null), []);

  const startProjectDeploy = async (project) => {
    if (project.pending) { window.alert(project.pendingMessage); setStatus(project.pendingMessage); return; }
    if (!connectedToSelectedServer || !activeId) {
      setStatus(`${project.label} güncellemesi için önce ${activeServer.title} sunucusuna giriş yap.`);
      return;
    }
    if (!window.confirm(project.confirmText)) return;

    setDeployState({
      open: true, running: true, progress: 1, step: 'Başlatılıyor',
      logs: [project.startLog], error: null, done: false,
      projectKey: project.key, projectLabel: project.label,
      successText: project.successText, steps: project.steps
    });
    setStatus(`${project.label} güncellemesi çalışıyor...`);

    try {
      await api.deploy.run({ project, terminalId: activeId, localProjectPath: project.localProjectPath, remoteDir: project.remoteDir });
      setStatus(`${project.label} güncellendi.`);
      if (project.maintenanceFlag && project.maintenanceAfterDeploy !== false) {
        const mApi = maintenanceApiFor(project);
        if (mApi) { try { await mApi.off({ terminalId: activeId, project }); } catch {} }
        setMaintenanceState((cur) => ({ ...cur, [project.key]: { status: 'off', loading: false } }));
      }
    } catch (err) {
      setDeployState((cur) => ({ ...cur, open: true, running: false, error: err.message, logs: [...cur.logs, `HATA: ${err.message}`].slice(-260) }));
      setStatus(`${project.label} güncelleme hatası: ${err.message}`);
      if (project.maintenanceFlag && project.maintenanceAfterDeploy !== false) {
        setMaintenanceState((cur) => ({ ...cur, [project.key]: { status: 'on', loading: false } }));
      }
    }
  };

  const closeDeployPanel = () => {
    if (deployState.running) return;
    setDeployState((cur) => ({ ...cur, open: false }));
  };

  useEffect(() => {
    if (!connectedToSelectedServer || !activeId) return;
    serverProjects.filter((p) => p.supportsMaintenance).forEach((project) => {
      const mApi = maintenanceApiFor(project);
      if (!mApi?.status) return;
      mApi.status({ terminalId: activeId, project })
        .then((result) => setMaintenanceState((cur) => ({ ...cur, [project.key]: { status: result.status, loading: false } })))
        .catch(() => {});
    });
  }, [connectedToSelectedServer, activeId, serverProjects, maintenanceApiFor]);

  const toggleMaintenance = async (project, enable) => {
    if (!connectedToSelectedServer || !activeId) {
      setStatus(`${project.label} bakım modu için önce ${activeServer.title} sunucusuna giriş yap.`);
      return;
    }
    const mApi = maintenanceApiFor(project);
    if (!mApi) { setStatus(`${project.label} için bakım modu API tanımlanmamış.`); return; }
    const msg = enable
      ? `${project.label} için bakım modu açılsın mı? ${project.domain} anında bakım sayfasını gösterecek.`
      : `${project.label} için bakım modu kapatılsın mı? ${project.domain} anında canlıya alınacak.`;
    if (!window.confirm(msg)) return;

    setMaintenanceState((cur) => ({ ...cur, [project.key]: { ...(cur[project.key] || {}), loading: true } }));
    setStatus(`${project.label} ${enable ? 'bakıma alınıyor' : 'canlıya alınıyor'}...`);

    try {
      const result = enable ? await mApi.on({ terminalId: activeId, project }) : await mApi.off({ terminalId: activeId, project });
      setMaintenanceState((cur) => ({ ...cur, [project.key]: { status: result.status, loading: false } }));
      setStatus(enable ? `${project.label} bakım modu açıldı.` : `${project.label} canlıya alındı.`);
    } catch (err) {
      setMaintenanceState((cur) => ({ ...cur, [project.key]: { ...(cur[project.key] || {}), loading: false } }));
      setStatus(`${enable ? 'Bakım Al' : 'Bakımdan Çıkar'} hatası: ${err.message}`);
    }
  };

  // A project earns the command-centre panel by declaring `commandCenter: true`,
  // not by matching a server id compiled into this file.
  const commandCentreProject = deployProjects.find(
    (p) => p.commandCenter && p.serverId === selectedServerId
  );

  return (
    <div className="app-shell">

      {/* ══ SIDEBAR ══════════════════════════════════════════════════ */}
      <aside className="sidebar">
        <div className="brand-card">
          <div className="brand-logo">
            <svg viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="9" fill="url(#bl)"/>
              <path d="M9 10h3.5l3.5 8 3.5-8H23v12h-2.5v-8.5L17.5 21h-3l-3-7.5V22H9V10Z" fill="white" opacity="0.95"/>
              <defs>
                <linearGradient id="bl" x1="0" y1="0" x2="32" y2="32">
                  <stop stopColor="#38bdf8"/>
                  <stop offset="1" stopColor="#818cf8"/>
                </linearGradient>
              </defs>
            </svg>
          </div>
          <div>
            <span>NOYKARA KONSOL</span>
            <strong>Sunucu Paneli</strong>
            <small>{status}</small>
          </div>
        </div>

        <section className="side-section">
          <div className="section-title">
            <span>Sunucular</span>
            <button className="tiny" onClick={() => selectServer(managedServers[0])}>Sıfırla</button>
          </div>
          <div className="server-list">
            {managedServers.map((server) => (
              <button
                key={server.id}
                className={`server-button ${selectedServerId === server.id ? 'selected' : ''} ${!server.host ? 'muted' : ''}`}
                onClick={() => selectServer(server)}
              >
                <span className={`server-mark ${server.accentClass || ''}`}>
                  {server.short}
                </span>
                <span className="server-copy">
                  <strong>{server.title}</strong>
                  <em>{server.host || 'IP bekliyor'}</em>
                  <small>{server.subtitle}</small>
                </span>
                <span className="server-status">
                  <span className={`status-dot ${server.host ? 'online' : 'pending'}`} />
                  <span className="server-status-label">{server.note}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="side-section connect-box">
          <div className="section-title">
            <span>Bağlantı</span>
            <i>{activeServer.status}</i>
          </div>
          <label>Profil adı<input value={form.label} onChange={(e) => updateForm('label', e.target.value)} placeholder="Sunucu" /></label>
          <label>Sunucu IP / Host<input value={form.host} onChange={(e) => updateForm('host', e.target.value)} placeholder="IP eklenecek" /></label>
          <div className="grid-2">
            <label>Port<input type="number" value={form.port} onChange={(e) => updateForm('port', Number(e.target.value))} /></label>
            <label>Kullanıcı<input value={form.username} onChange={(e) => updateForm('username', e.target.value)} placeholder="root" /></label>
          </div>
          <label>
            Şifre
            <input type="password" value={form.password} onChange={(e) => updateForm('password', e.target.value)} placeholder="Sadece şifreyi gir" />
            <small>Şifre kaydedilmez.</small>
          </label>
          <div className="key-row">
            <label>SSH key<input value={form.keyPath} onChange={(e) => updateForm('keyPath', e.target.value)} placeholder="Opsiyonel" /></label>
            <button className="secondary key-btn" onClick={selectKey}>Seç</button>
          </div>
          <label>Key passphrase<input type="password" value={form.passphrase} onChange={(e) => updateForm('passphrase', e.target.value)} placeholder="Varsa" /></label>
          <div className="connect-actions">
            <button className="primary" onClick={() => startTerminal()} disabled={isConnecting || !form.host}>
              {isConnecting ? 'Bağlanıyor…' : 'Giriş Yap'}
            </button>
            <button className="secondary" onClick={saveProfile}>Kaydet</button>
          </div>
        </section>

        {profiles.length > 0 && (
          <section className="side-section saved-profiles">
            <div className="section-title"><span>Ek Profiller</span></div>
            <div className="profile-list">
              {profiles.map((profile) => (
                <div className="profile-card" key={profile.id}>
                  <button onClick={() => loadProfile(profile)}>
                    <strong>{profile.label}</strong>
                    <span>{profile.username}@{profile.host}:{profile.port}</span>
                  </button>
                  <button className="delete" onClick={() => removeProfile(profile.id)}>×</button>
                </div>
              ))}
            </div>
          </section>
        )}
      </aside>

      {/* ══ CENTER PANEL ══════════════════════════════════════════════ */}
      <main className="files-panel">
        {commandCentreProject ? (
          <ProjectCommandCenter
            project={commandCentreProject}
            maintenanceState={maintenanceState}
            connectedToSelectedServer={connectedToSelectedServer}
            activeServer={activeServer}
            deployState={deployState}
            onDeploy={startProjectDeploy}
            onToggleMaintenance={toggleMaintenance}
            onOpenEnv={openProjectEnv}
            activeId={activeId}
          />
        ) : (
          <ProjectStrip
            activeServer={activeServer}
            serverProjects={serverProjects}
            connectedToSelectedServer={connectedToSelectedServer}
            deployState={deployState}
            maintenanceState={maintenanceState}
            onDeploy={startProjectDeploy}
            onToggleMaintenance={toggleMaintenance}
            onOpenEnv={openProjectEnv}
          />
        )}

        <section className="file-console">
          <div className="file-topbar">
            <div>
              <span>Dosya Sistemi</span>
              <h2>{connected ? compactPath(remotePath) : 'Sunucu dosyaları bekliyor'}</h2>
            </div>
            <div className="file-actions">
              <button className="secondary" onClick={() => loadDirectory(remotePath)} disabled={!connected || isLoadingFiles}>Yenile</button>
              <button className="secondary" onClick={createFolder} disabled={!connected}>Klasör</button>
              <button className="secondary" onClick={() => openInTerminal(remotePath)} disabled={!connected}>Terminalde Aç</button>
            </div>
          </div>

          <div className="status-row">
            <div><span>Bağlantı</span><strong>{connected ? `${activeTab.config.username}@${activeTab.config.host}` : 'Kapalı'}</strong></div>
            <div><span>Klasör</span><strong>{connected ? folderCount : '-'}</strong></div>
            <div><span>Dosya</span><strong>{connected ? fileCount : '-'}</strong></div>
            <div className="status-wide"><span>Durum</span><strong>{isLoadingFiles ? 'Okunuyor…' : fileStatus}</strong></div>
          </div>

          <div className="pathbar">
            <button onClick={() => openDirectory('/')} disabled={!connected}>/</button>
            <button onClick={() => openDirectory(remotePath.split('/').slice(0, -1).join('/') || '/')} disabled={!connected}>Üst</button>
            <input
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') loadDirectory(remotePath); }}
              disabled={!connected}
            />
          </div>

          <div className="locations">
            {locations.map((item) => (
              <button key={item.path} onClick={() => openDirectory(item.path)} disabled={!connected} className={remotePath === item.path ? 'selected' : ''}>
                <span>{item.label}</span><small>{item.path}</small>
              </button>
            ))}
          </div>

          <div className="file-layout">
            <div className="file-grid">
              {!connected && (
                <div className="desktop-placeholder">
                  <div className="server-orb">⬡</div>
                  <h3>Dosya sistemi hazır.</h3>
                  <p>Sol panelden sunucuyu seç ve bağlan.<br/>Dosyalar burada grid görünümünde listelenir.</p>
                </div>
              )}
              {connected && files.length === 0 && !isLoadingFiles && (
                <div className="empty desktop-empty">Bu klasör boş veya listeleme yapılamadı.</div>
              )}
              {connected && files.map((file) => (
                <button
                  key={file.path}
                  className={`file-card ${selectedFile?.path === file.path ? 'selected' : ''}`}
                  onClick={() => setSelectedFile(file)}
                  onDoubleClick={() => file.type === 'directory' ? openDirectory(file.path) : openFile(file)}
                  title={file.path}
                >
                  <span className={`file-icon ${fileTone(file)}`}>{fileIcon(file)}</span>
                  <strong>{file.name}</strong>
                  <small>{file.type === 'directory' ? 'Klasör' : formatBytes(file.size)}</small>
                  <em>{formatDate(file.modifiedAt)}</em>
                </button>
              ))}
            </div>

            <aside className="inspector">
              <div className="inspector-head">
                <span>Kontrol</span>
                <h3>{selectedFile?.name || 'Öğe seç'}</h3>
              </div>
              {selectedFile ? (
                <>
                  <div className="meta-row"><span>Tür</span><strong>{selectedFile.type}</strong></div>
                  <div className="meta-row"><span>Boyut</span><strong>{selectedFile.type === 'directory' ? '-' : formatBytes(selectedFile.size)}</strong></div>
                  <div className="meta-row path-meta"><span>Yol</span><strong>{selectedFile.path}</strong></div>
                  <div className="inspector-actions">
                    {selectedFile.type === 'directory'
                      ? <button className="primary" onClick={() => openDirectory(selectedFile.path)}>Aç</button>
                      : <button className="primary" onClick={() => openFile(selectedFile)}>Düzenle</button>}
                    <button className="secondary" onClick={() => openInTerminal(selectedFile.type === 'directory' ? selectedFile.path : remotePath)}>Terminal</button>
                    <button className="secondary" onClick={renameSelected}>Yeniden Adlandır</button>
                    <button className="danger" onClick={deleteSelected}>Sil</button>
                  </div>
                </>
              ) : (
                <p className="muted">Bir dosya veya klasör seç. Çift tıklarsan klasör açılır, metin dosyaları editöre gelir.</p>
              )}
              {editor && (
                <div className="editor-card">
                  <div className="editor-head">
                    <div>
                      <strong>{editor.file.name}</strong>
                      <small>{editor.isEnv ? 'Canlı .env · Ctrl+S kaydeder' : 'Metin dosyası · Ctrl+S kaydeder'}</small>
                    </div>
                    <button className="tiny" onClick={() => setEditor(null)}>Kapat</button>
                  </div>
                  <textarea
                    value={editor.content}
                    onChange={(e) => setEditor((cur) => cur ? { ...cur, content: e.target.value, dirty: true } : cur)}
                    onKeyDown={(e) => {
                      if (!((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 's')) return;
                      e.preventDefault();
                      saveEditor();
                    }}
                    spellCheck="false"
                  />
                  <button className="primary wide" onClick={saveEditor} disabled={!editor.dirty}>Kaydet</button>
                </div>
              )}
            </aside>
          </div>
        </section>
      </main>

      {/* ══ TERMINAL PANEL ════════════════════════════════════════════ */}
      <section className="terminal-panel">
        <div className="terminal-head">
          <div>
            <span>Canlı Terminal</span>
            <h2>{activeTab ? activeTab.title : 'Terminal bekliyor'}</h2>
          </div>
          <div className="terminal-actions">
            <button className="secondary" onClick={duplicateTerminal} disabled={!activeTab && !form.host}>+ Terminal</button>
            <button className="secondary" onClick={copyTerminal} disabled={!activeId}>Kopyala</button>
            <button className="secondary" onClick={clearTerminal} disabled={!activeId}>Clear</button>
            <button className="danger" onClick={closeAll} disabled={tabs.length === 0}>Kapat</button>
          </div>
        </div>

        <div className="tabs">
          {tabs.length === 0 && <span className="no-tabs">Bağlantı kurulduğunda terminal burada açılır.</span>}
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`tab ${tab.id === activeId ? 'selected' : ''} ${tab.state}`}
              onClick={() => setActiveId(tab.id)}
            >
              <span>{tab.title}</span>
              <em>{tab.state}</em>
              <b onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}>×</b>
            </button>
          ))}
        </div>

        <div className="quickbar">
          {quickCommands.map((item) => (
            <button key={item.label} className={item.accent ? 'accent' : ''} onClick={() => runQuickCommand(item.command)} disabled={!activeId}>
              {item.label}
            </button>
          ))}
        </div>

        <div className="terminal-stage">
          {tabs.length === 0 ? (
            <div className="terminal-placeholder">
              <div className="orb">⌨</div>
              <h2>Terminal hazır.</h2>
              <p>Sunucuya bağlandıktan sonra<br/>canlı SSH terminali burada açılır.</p>
            </div>
          ) : (
            tabs.map((tab) => (
              <TerminalView key={tab.id} tab={tab} active={tab.id === activeId} clearTick={clearTick} copyTick={copyTick} onCopied={setStatus} />
            ))
          )}
        </div>
      </section>

      {deployState.open && <DeployOverlay state={deployState} onClose={closeDeployPanel} />}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   DEPLOY OVERLAY
   ═══════════════════════════════════════════════════════════════════ */
function DeployOverlay({ state, onClose }) {
  const progress = Math.max(0, Math.min(100, Number(state.progress || 0)));
  const steps = state.steps?.length ? state.steps : ['Hazırlık', 'Paketle', 'Aktar', 'Yedekle', 'Build', 'Restart', 'Sağlık', 'Kontrol'];
  const isNS = Boolean(state.commandCenter);

  return (
    <div className="deploy-overlay">
      <div className={`deploy-card ${isNS ? 'deploy-card--ns' : ''}`}>
        {isNS && <div className="deploy-card-glow" />}
        <div className="deploy-head">
          <div>
            <span>Canlı Yayın</span>
            <h2>{state.projectLabel || 'Canlı Güncelle'}</h2>
            <p>{state.step}</p>
          </div>
          <button className="tiny" onClick={onClose} disabled={state.running}>Kapat</button>
        </div>
        <div className="deploy-progress">
          <div style={{ width: `${progress}%` }} className={isNS ? 'ns-prog' : ''} />
        </div>
        <div className="deploy-meta">
          <span>%{progress}</span>
          <strong>{state.error ? 'Hata oluştu' : state.done ? 'Tamamlandı ✓' : state.running ? 'İşlem sürüyor…' : 'Beklemede'}</strong>
        </div>
        <div className="deploy-steps">
          {steps.map((item, i) => (
            <span key={item} className={progress >= Math.round(((i + 1) / steps.length) * 100) ? 'done' : ''}>{item}</span>
          ))}
        </div>
        <pre className="deploy-log">{state.logs.join('\n') || 'Log bekleniyor...'}</pre>
        {state.error && <div className="deploy-error">{state.error}</div>}
        {state.done && !state.error && <div className="deploy-success">{state.successText || 'Güncelleme başarıyla tamamlandı.'}</div>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TERMINAL VIEW
   ═══════════════════════════════════════════════════════════════════ */
function getTerminalText(term) {
  if (!term?.buffer?.active) return '';
  const buffer = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return `${lines.join('\n').replace(/[\s\n]+$/g, '')}\n`;
}

function TerminalView({ tab, active, clearTick, copyTick, onCopied }) {
  const frameRef = useRef(null);
  const mountRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      theme: {
        background: '#050713',
        foreground: '#e6ecff',
        cursor: '#79f2ff',
        selectionBackground: '#2f4c7a',
        black: '#050713', red: '#ff6b88', green: '#8df7a7', yellow: '#ffd166',
        blue: '#79a8ff', magenta: '#c48cff', cyan: '#79f2ff', white: '#e6ecff',
        brightBlack: '#596279', brightRed: '#ff88a1', brightGreen: '#a5ffc0',
        brightYellow: '#ffe08a', brightBlue: '#9dbfff', brightMagenta: '#d9b7ff',
        brightCyan: '#a6f7ff', brightWhite: '#ffffff'
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mountRef.current);
    fit.fit();
    terminalRef.current = term;
    fitRef.current = fit;

    term.writeln('\x1b[36mNOYKARA Server Console\x1b[0m');
    term.writeln(`Bağlantı hazırlanıyor: ${tab.config.username}@${tab.config.host}:${tab.config.port}`);
    term.writeln('');

    term.onData((data) => { api.ssh.write(tab.id, data); });

    term.attachCustomKeyEventHandler((event) => {
      const key = String(event.key || '').toLowerCase();
      const plainCtrl = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
      if (!plainCtrl || event.type !== 'keydown') return true;
      if (key === 'c') {
        const sel = term.getSelection();
        if (!sel) return true;
        api.clipboard.writeText(sel)
          .then(() => onCopied?.(`Kopyalandı: ${sel.length.toLocaleString('tr-TR')} karakter.`))
          .catch((err) => onCopied?.(`Kopyalama hatası: ${err.message}`));
        term.clearSelection(); term.focus();
        return false;
      }
      if (key === 'v') {
        api.clipboard.readText()
          .then((result) => {
            const text = typeof result === 'string' ? result : result?.text;
            if (!text) { onCopied?.('Panoda metin yok.'); return; }
            api.ssh.write(tab.id, text); term.focus();
          })
          .catch((err) => onCopied?.(`Yapıştırma hatası: ${err.message}`));
        return false;
      }
      return true;
    });

    const offData  = api.onTerminalData(({ terminalId, data }) => { if (terminalId === tab.id) term.write(data); });
    const offError = api.onTerminalError(({ terminalId, message }) => { if (terminalId === tab.id) term.writeln(`\r\n\x1b[31m${message}\x1b[0m`); });
    const offExit  = api.onTerminalExit(({ terminalId }) => { if (terminalId === tab.id) term.writeln('\r\n\x1b[90m[Terminal kapandı]\x1b[0m'); });

    const resizeObserver = new ResizeObserver(() => { fit.fit(); api.ssh.resize(tab.id, term.cols, term.rows); });
    resizeObserver.observe(frameRef.current);
    api.ssh.resize(tab.id, term.cols, term.rows);

    return () => { offData(); offError(); offExit(); resizeObserver.disconnect(); term.dispose(); };
  }, [tab.id]);

  useEffect(() => {
    if (!active) return;
    setTimeout(() => {
      fitRef.current?.fit();
      terminalRef.current?.focus();
      if (terminalRef.current) api.ssh.resize(tab.id, terminalRef.current.cols, terminalRef.current.rows);
    }, 40);
  }, [active, tab.id]);

  useEffect(() => {
    if (!active || !clearTick) return;
    terminalRef.current?.clear();
    terminalRef.current?.focus();
  }, [clearTick, active]);

  useEffect(() => {
    if (!active || !copyTick || !terminalRef.current) return;
    const text = getTerminalText(terminalRef.current);
    if (!text.trim()) { onCopied?.('Kopyalanacak terminal çıktısı yok.'); return; }
    api.clipboard.writeText(text)
      .then(() => onCopied?.(`Kopyalandı: ${text.length.toLocaleString('tr-TR')} karakter.`))
      .catch((err) => onCopied?.(`Kopyalama hatası: ${err.message}`));
  }, [copyTick, active, onCopied]);

  return (
    <div className={`terminal-pane ${active ? 'active' : ''}`}>
      <div ref={frameRef} className="terminal-container">
        <div ref={mountRef} className="terminal-mount" />
      </div>
      <div className="terminal-safe-label">Komut satırı alanı</div>
      {tab.state === 'error' && <div className="terminal-error">{tab.error}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
