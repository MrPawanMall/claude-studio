'use strict';
// Built-in SFTP / FTP / FTPS upload for Claude Studio.
// - reads .vscode/sftp.json (compatible format)
// - uploads files Claude edits, and files you save (uploadOnSave)
// - blocks PHP files with syntax errors
// - asks before uploading to production profiles
// - passwords live in the editor's secure storage, host keys are verified

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { vs, cfg, NS, fileKey, timeAgo, clock } = require('../util');
const { parseConfigText, resolveConfig, remotePathFor, configForFile, stripPasswords, CONFIG_REL, TEMPLATE } = require('./config');
const { Connection, readPrivateKey } = require('./client');
const { Quality } = require('../core/quality');

const MAX_HISTORY = 60;

class Uploader {
  constructor(context, { tracker, quality, notify, log }) {
    const vscode = vs();
    this.context = context;
    this.tracker = tracker;
    this.quality = quality;
    this.notify = notify;
    this.log = log;
    this.configs = [];
    this.configErrors = [];
    this.connections = new Map();
    this.queue = new Map();
    this.flushTimer = undefined;
    this.busy = 0;
    this.history = [];
    this.histSeq = 0;
    this.warnedPlain = new Set();
    this.sessionPasswords = new Map();

    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;

    this.status = vscode.window.createStatusBarItem(`${NS}.upload`, vscode.StatusBarAlignment.Right, 99);
    this.status.name = 'Claude Studio: Upload';
    this.status.command = `${NS}.upload.focus`;

    const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/sftp.json');
    context.subscriptions.push(
      this._onDidChange, this.status, watcher,
      watcher.onDidChange(() => this.loadConfigs()),
      watcher.onDidCreate(() => this.loadConfigs()),
      watcher.onDidDelete(() => this.loadConfigs()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.loadConfigs()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.loadConfigs()),
      vscode.workspace.onDidSaveTextDocument(doc => this.onUserSave(doc)),
      { dispose: () => { clearTimeout(this.flushTimer); for (const c of this.connections.values()) c.close(); } },
    );
    this.loadConfigs();
  }

  // ---------- configs ----------
  loadConfigs() {
    const vscode = vs();
    this.configs = [];
    this.configErrors = [];
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const file = path.join(folder.uri.fsPath, CONFIG_REL);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      try {
        parseConfigText(text).forEach((raw, i) => {
          const profile = this.context.workspaceState.get(`cs.profile:${fileKey(folder.uri.fsPath)}#${i}`);
          try { this.configs.push(resolveConfig(raw, folder.uri.fsPath, profile, i)); }
          catch (e) { this.configErrors.push(`${folder.name}: ${e.message}`); }
        });
      } catch (e) {
        this.configErrors.push(`${folder.name}: ${e.message}`);
      }
    }
    for (const c of this.connections.values()) c.close();
    this.connections.clear();
    if (this.configErrors.length) this.log('sftp.json problems: ' + this.configErrors.join('; '));
    this.updateStatus();
    this._onDidChange.fire();
  }

  configFor(uri) {
    return configForFile(this.configs, uri.fsPath);
  }

  isProd(config) {
    const list = cfg('upload').get('confirmProfiles', ['prod', 'production', 'live']).map(s => String(s).toLowerCase());
    const profile = (config.profile || '').toLowerCase();
    const name = (config.name || '').toLowerCase();
    return list.some(p => p && (profile === p || new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(name)));
  }

  label(config) {
    return `${config.name}${config.profile ? ` (${config.profile})` : ''}`;
  }

  // ---------- auth ----------
  async getAuth(config) {
    const vscode = vs();
    const auth = {};
    if (config.privateKeyPath) {
      auth.privateKey = readPrivateKey(config.privateKeyPath);
      if (typeof config.passphrase === 'string') auth.passphrase = config.passphrase;
      else if (config.passphrase === true) auth.passphrase = await this.secret(`${config.secretKey}#passphrase`, `Passphrase for ${config.privateKeyPath}`);
    }
    if (config.password !== undefined) {
      auth.password = config.password;
      if (!this.warnedPlain.has(config.id)) {
        this.warnedPlain.add(config.id);
        vscode.window.showWarningMessage(
          `Claude Studio: the password for "${config.name}" is saved as plain text in sftp.json. Anyone who can read the project can read it.`,
          'Move to secure storage'
        ).then(p => p && this.movePasswords());
      }
    } else if (!auth.privateKey && !config.agent) {
      auth.password = await this.secret(config.secretKey, `Password for ${config.username}@${config.host}`);
    }
    if (config.protocol === 'ftp' && !config.secure && !this.warnedPlain.has(config.id + '#ftp')) {
      this.warnedPlain.add(config.id + '#ftp');
      vscode.window.showWarningMessage(
        `Claude Studio: "${config.name}" uses plain FTP, which sends your password and files unencrypted. Use "protocol": "sftp" or "secure": true if your host supports it.`);
    }
    return auth;
  }

  async secret(key, prompt) {
    const vscode = vs();
    const stored = await this.context.secrets.get(`cs.pw:${key}`);
    if (stored) return stored;
    if (this.sessionPasswords.has(key)) return this.sessionPasswords.get(key);
    const value = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
    if (value === undefined) throw new Error('No password entered');
    const remember = await vscode.window.showQuickPick(
      [{ label: 'Remember in secure storage', value: true }, { label: 'Only for this session', value: false }],
      { placeHolder: 'Save this password?', ignoreFocusOut: true });
    if (remember && remember.value) await this.context.secrets.store(`cs.pw:${key}`, value);
    else this.sessionPasswords.set(key, value);
    return value;
  }

  async hostVerifier(host, port, fingerprint) {
    const vscode = vs();
    const known = this.context.globalState.get('cs.knownHosts', {});
    const id = `${host}:${port}`;
    if (known[id] === fingerprint) return true;
    if (known[id] && known[id] !== fingerprint) {
      vscode.window.showErrorMessage(
        `Claude Studio: the server key for ${id} has CHANGED (was ${known[id]}, now ${fingerprint}). Upload was stopped. ` +
        'If your host really changed its key, run "Claude Studio: Forget Server Key" and try again.', { modal: true });
      return false;
    }
    const pick = await vscode.window.showWarningMessage(
      `First connection to ${id}. Server key fingerprint:\n${fingerprint}\n\nTrust this server?`, { modal: true }, 'Trust');
    if (pick !== 'Trust') return false;
    known[id] = fingerprint;
    await this.context.globalState.update('cs.knownHosts', known);
    return true;
  }

  async connection(config) {
    const key = `${config.id}|${config.profile || ''}`;
    let conn = this.connections.get(key);
    if (!conn) {
      const auth = await this.getAuth(config);
      conn = new Connection(config, auth, {
        hostVerifier: (h, p, fp) => this.hostVerifier(h, p, fp),
        allowSelfSigned: cfg('upload').get('allowSelfSignedCertificates', false),
      });
      this.connections.set(key, conn);
    }
    return conn;
  }

  forgetConnection(config) {
    const key = `${config.id}|${config.profile || ''}`;
    const c = this.connections.get(key);
    if (c) { c.close(); this.connections.delete(key); }
  }

  // ---------- triggers ----------
  canRun(quiet) {
    const vscode = vs();
    if (!vscode.workspace.isTrusted) {
      if (!quiet) vscode.window.showWarningMessage('Claude Studio: uploads are disabled until you trust this workspace.');
      return false;
    }
    return true;
  }

  /** Claude changed a file */
  onClaudeChange(uri) {
    const mode = cfg('upload').get('claudeEdits', 'auto');
    if (mode !== 'auto' || !this.configs.length || !this.canRun(true)) return;
    if (!this.configFor(uri)) return;
    this.enqueue([uri], 'claude');
  }

  /** Claude finished a task */
  onTaskFinished(task) {
    const mode = cfg('upload').get('claudeEdits', 'auto');
    if (mode !== 'afterTask' || !this.configs.length || !this.canRun(true)) return;
    const uris = [...task.files.values()].map(e => e.uri).filter(u => this.configFor(u));
    if (uris.length) this.enqueue(uris, 'task');
  }

  onUserSave(doc) {
    if (doc.uri.scheme !== 'file' || !this.configs.length || !this.canRun(true)) return;
    const c = this.configFor(doc.uri);
    if (c && c.uploadOnSave) this.enqueue([doc.uri], 'save');
  }

  hasConfigFor(uris) {
    return uris.some(u => this.configFor(u));
  }

  enqueue(uris, reason) {
    for (const uri of uris) {
      const k = fileKey(uri.fsPath);
      if (!this.queue.has(k)) this.queue.set(k, { uri, reason });
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), reason === 'manual' ? 50 : 800);
  }

  /** Upload right now (manual commands, revert, task button). */
  uploadFiles(uris, reason = 'manual') {
    if (!this.canRun(false)) return;
    if (!this.configs.length) { this.noConfig(); return; }
    this.enqueue(uris, reason);
  }

  async flush() {
    const vscode = vs();
    const items = [...this.queue.values()];
    this.queue.clear();
    if (!items.length) return;

    // group by server
    const groups = new Map();
    for (const it of items) {
      const config = this.configFor(it.uri);
      if (!config) {
        if (it.reason === 'manual') vscode.window.showWarningMessage(`Claude Studio: ${path.basename(it.uri.fsPath)} isn't inside a folder set up in sftp.json.`);
        continue;
      }
      const remote = remotePathFor(config, it.uri.fsPath);
      if (!remote) {
        if (it.reason === 'manual') vscode.window.showWarningMessage(`Claude Studio: ${path.basename(it.uri.fsPath)} is in the sftp.json ignore list.`);
        continue;
      }
      if (!groups.has(config)) groups.set(config, []);
      groups.get(config).push({ ...it, remote });
    }

    for (const [config, list] of groups) {
      if (this.isProd(config)) {
        const names = list.slice(0, 5).map(i => path.basename(i.uri.fsPath)).join(', ') + (list.length > 5 ? ` and ${list.length - 5} more` : '');
        const ok = await vscode.window.showWarningMessage(
          `Upload ${list.length} file(s) to ${this.label(config)} — ${config.host}?\n\n${names}`, { modal: true }, 'Upload');
        if (ok !== 'Upload') {
          list.forEach(i => this.addHistory(i, config, 'skipped', 'Not confirmed'));
          continue;
        }
      }
      await this.uploadGroup(config, list);
    }
  }

  async uploadGroup(config, list) {
    const vscode = vs();
    let done = 0;
    const failed = [];
    let conn;
    for (const it of list) {
      const h = this.addHistory(it, config, 'uploading');
      // PHP syntax gate
      if (cfg('upload').get('blockPhpErrors', true) && Quality.isPhp(it.uri)) {
        const res = await this.quality.lintPhp(it.uri);
        if (!res.ok) {
          this.setHistory(h, 'blocked', `${res.message} (line ${res.line})`);
          failed.push({ it, error: `syntax error on line ${res.line}`, blocked: true });
          continue;
        }
      }
      this.busy++; this.updateStatus();
      try {
        conn = conn || await this.connection(config);
        await conn.upload(it.uri.fsPath, it.remote);
        this.setHistory(h, 'done');
        done++;
      } catch (e) {
        const msg = cleanError(e);
        this.setHistory(h, 'failed', msg);
        failed.push({ it, error: msg });
        this.log(`Upload failed ${it.uri.fsPath} -> ${config.host}:${it.remote}: ${msg}`);
        if (/password|auth|permission denied|530/i.test(msg)) {
          // wrong saved password: forget so we ask again next time
          this.sessionPasswords.delete(config.secretKey);
          this.forgetConnection(config);
          conn = undefined;
        }
      } finally {
        this.busy--; this.updateStatus();
      }
    }

    if (done) {
      vscode.window.setStatusBarMessage(`$(cloud-upload) Uploaded ${done} file(s) to ${this.label(config)}`, 4000);
      if (cfg('upload').get('notifyOnSuccess', false)) {
        this.notify({ event: 'uploadSuccess', title: `Uploaded ${done} file(s)`, message: this.label(config), silent: false });
      }
    }
    if (failed.length) {
      const blocked = failed.filter(f => f.blocked);
      const first = failed[0];
      this.notify({
        event: blocked.length === failed.length ? 'lintError' : 'uploadFailed',
        title: blocked.length === failed.length
          ? `Upload blocked: PHP syntax error in ${path.basename(first.it.uri.fsPath)}`
          : `${failed.length} upload(s) failed`,
        message: `${path.basename(first.it.uri.fsPath)}: ${first.error}`,
        actions: [
          { title: 'Open file', run: () => vscode.window.showTextDocument(first.it.uri) },
          { title: 'Retry', run: () => this.uploadFiles(failed.map(f => f.it.uri), 'manual') },
        ],
      });
    }
  }

  // ---------- history / tree ----------
  addHistory(it, config, status, error) {
    const h = { id: ++this.histSeq, uri: it.uri, remote: it.remote, server: this.label(config), status, error, time: Date.now(), reason: it.reason };
    this.history.unshift(h);
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
    this._onDidChange.fire();
    this.updateStatus();
    return h;
  }

  setHistory(h, status, error) {
    h.status = status; h.error = error; h.time = Date.now();
    this._onDidChange.fire();
    this.updateStatus();
  }

  updateStatus() {
    const vscode = vs();
    const s = this.status;
    if (!this.configs.length) { s.hide(); return; }
    const failed = this.history.filter(h => h.status === 'failed' || h.status === 'blocked');
    const recentFailed = failed.filter(h => Date.now() - h.time < 30 * 60000);
    const main = this.configs[0];
    if (this.busy) {
      s.text = `$(sync~spin) Uploading ${this.busy}`;
      s.backgroundColor = undefined;
    } else if (recentFailed.length) {
      s.text = `$(cloud-upload) ${recentFailed.length} failed`;
      s.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      s.text = `$(cloud) ${main.profile || main.name}`;
      s.backgroundColor = this.isProd(main) ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    }
    s.tooltip = `Claude Studio upload\nServer: ${this.label(main)} — ${main.protocol.toUpperCase()} ${main.host}\nClaude edits: ${cfg('upload').get('claudeEdits', 'auto')}\nClick to see uploads.`;
    s.show();
  }

  getChildren(node) {
    if (node) return [];
    const servers = this.configs.map(c => ({ kind: 'server', config: c }));
    const errors = this.configErrors.map(e => ({ kind: 'error', text: e }));
    const hist = this.history.map(h => ({ kind: 'item', h }));
    return [...errors, ...servers, ...hist];
  }

  getTreeItem(node) {
    const vscode = vs();
    if (node.kind === 'error') {
      const t = new vscode.TreeItem(node.text);
      t.iconPath = new vscode.ThemeIcon('error');
      t.command = { command: `${NS}.upload.openConfig`, title: 'Open sftp.json' };
      return t;
    }
    if (node.kind === 'server') {
      const c = node.config;
      const t = new vscode.TreeItem(this.label(c));
      t.description = `${c.protocol.toUpperCase()}${c.secure ? 'S' : ''} · ${c.username}@${c.host}:${c.remotePath}`;
      t.iconPath = new vscode.ThemeIcon(this.isProd(c) ? 'server-environment' : 'server', this.isProd(c) ? new vscode.ThemeColor('errorForeground') : undefined);
      t.tooltip = `${c.name}\nProfile: ${c.profile || '(none)'}${this.isProd(c) ? ' — asks before uploading' : ''}\nLocal folder: ${c.localRoot}\nUpload on save: ${c.uploadOnSave ? 'yes' : 'no'}\n\nClick to switch profile.`;
      t.contextValue = 'server';
      t.command = { command: `${NS}.upload.switchProfile`, title: 'Switch profile', arguments: [node] };
      return t;
    }
    const h = node.h;
    const icon = { done: 'pass', failed: 'error', blocked: 'error', uploading: 'sync~spin', skipped: 'circle-slash' }[h.status] || 'circle-outline';
    const color = { done: 'testing.iconPassed', failed: 'errorForeground', blocked: 'errorForeground' }[h.status];
    const t = new vscode.TreeItem(path.basename(h.uri.fsPath));
    t.resourceUri = h.uri;
    t.description = `${h.status === 'blocked' ? 'blocked · ' : h.status === 'failed' ? 'failed · ' : ''}${h.server} · ${clock(h.time)}`;
    t.tooltip = `${vscode.workspace.asRelativePath(h.uri)} → ${h.remote}\n${h.status.toUpperCase()}${h.error ? `: ${h.error}` : ''}\n${reasonLabel(h.reason)} · ${timeAgo(h.time)}`;
    t.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    t.contextValue = h.status === 'failed' || h.status === 'blocked' ? 'uploadFailed' : 'uploadItem';
    t.command = { command: 'vscode.open', title: 'Open', arguments: [h.uri] };
    return t;
  }

  // ---------- commands ----------
  noConfig() {
    const vscode = vs();
    vscode.window.showInformationMessage('Claude Studio: no server is set up for this project yet.', 'Set up server')
      .then(p => p && this.createConfig());
  }

  async createConfig() {
    const vscode = vs();
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!folder) { vscode.window.showWarningMessage('Open a project folder first.'); return; }
    const file = vscode.Uri.joinPath(folder.uri, '.vscode', 'sftp.json');
    try {
      await vscode.workspace.fs.stat(file);
    } catch {
      await vscode.workspace.fs.writeFile(file, Buffer.from(TEMPLATE, 'utf8'));
    }
    await vscode.window.showTextDocument(file);
  }

  async openConfig() {
    const vscode = vs();
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!folder) return;
    const file = vscode.Uri.joinPath(folder.uri, '.vscode', 'sftp.json');
    try { await vscode.window.showTextDocument(file); } catch { this.createConfig(); }
  }

  async switchProfile(node) {
    const vscode = vs();
    const config = node && node.config ? node.config : this.configs.find(c => c.profiles.length);
    if (!config || !config.profiles.length) { vscode.window.showInformationMessage('Claude Studio: sftp.json has no "profiles" to switch between.'); return; }
    const pick = await vscode.window.showQuickPick(config.profiles.map(p => ({
      label: p, description: p === config.profile ? 'current' : (this.isProd({ ...config, profile: p }) ? 'asks before upload' : ''),
    })), { placeHolder: `Profile for ${config.name}` });
    if (!pick) return;
    await this.context.workspaceState.update(`cs.profile:${config.id}`, pick.label);
    this.loadConfigs();
    vscode.window.setStatusBarMessage(`Claude Studio: now uploading to ${config.name} (${pick.label})`, 4000);
  }

  async uploadCommand(arg, all) {
    const vscode = vs();
    let uris = [];
    if (Array.isArray(all) && all.length) uris = all.filter(u => u instanceof vscode.Uri);
    else if (arg instanceof vscode.Uri) uris = [arg];
    else if (arg && arg.h) uris = [arg.h.uri];
    else if (arg && arg.kind === 'file') uris = [arg.entry.uri];
    else if (vscode.window.activeTextEditor) uris = [vscode.window.activeTextEditor.document.uri];
    const files = [];
    for (const u of uris) {
      try {
        const st = await vscode.workspace.fs.stat(u);
        if (st.type & vscode.FileType.Directory) {
          const found = await vscode.workspace.findFiles(new vscode.RelativePattern(u, '**/*'), '**/{node_modules,.git,vendor}/**', 2000);
          files.push(...found);
        } else files.push(u);
      } catch { /* missing */ }
    }
    for (const u of files) {
      const doc = vscode.workspace.textDocuments.find(d => fileKey(d.uri.fsPath) === fileKey(u.fsPath));
      if (doc && doc.isDirty) await doc.save();
    }
    if (files.length > 50) {
      const ok = await vscode.window.showWarningMessage(`Upload ${files.length} files?`, { modal: true }, 'Upload');
      if (ok !== 'Upload') return;
    }
    this.uploadFiles(files, 'manual');
  }

  async retry(node) {
    if (node && node.h) this.uploadFiles([node.h.uri], 'manual');
  }

  retryFailed() {
    const failed = this.history.filter(h => h.status === 'failed' || h.status === 'blocked').map(h => h.uri);
    const unique = [...new Map(failed.map(u => [fileKey(u.fsPath), u])).values()];
    if (unique.length) this.uploadFiles(unique, 'manual');
  }

  async downloadCommand(arg) {
    const vscode = vs();
    if (!this.canRun(false)) return;
    const uri = arg instanceof vscode.Uri ? arg : arg && arg.h ? arg.h.uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
    if (!uri) return;
    const config = this.configFor(uri);
    const remote = config && remotePathFor(config, uri.fsPath);
    if (!config || !remote) { this.noConfig(); return; }
    const ok = await vscode.window.showWarningMessage(
      `Download ${path.basename(uri.fsPath)} from ${this.label(config)}? Your local copy will be replaced.`, { modal: true }, 'Download');
    if (ok !== 'Download') return;
    const tmp = this.tempPath(uri);
    try {
      const conn = await this.connection(config);
      await conn.download(remote, tmp);
      const text = fs.readFileSync(tmp);
      this.tracker.markSelfWrite(uri, text.toString('utf8'));
      await vscode.workspace.fs.writeFile(uri, text);
      this.tracker.snapshot(uri, text.toString('utf8'));
      vscode.window.setStatusBarMessage(`Claude Studio: downloaded ${path.basename(uri.fsPath)}`, 3000);
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Studio: download failed — ${cleanError(e)}`);
    } finally {
      fs.rm(tmp, { force: true }, () => {});
    }
  }

  async compareCommand(arg) {
    const vscode = vs();
    if (!this.canRun(false)) return;
    const uri = arg instanceof vscode.Uri ? arg : arg && arg.h ? arg.h.uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
    if (!uri) return;
    const config = this.configFor(uri);
    const remote = config && remotePathFor(config, uri.fsPath);
    if (!config || !remote) { this.noConfig(); return; }
    const tmp = this.tempPath(uri);
    try {
      const conn = await this.connection(config);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Fetching server copy…' },
        () => conn.download(remote, tmp));
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tmp), uri,
        `${path.basename(uri.fsPath)} (${this.label(config)}) ↔ local`);
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Studio: couldn't fetch the server copy — ${cleanError(e)}`);
    }
  }

  tempPath(uri) {
    const dir = path.join(os.tmpdir(), 'claude-studio', crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, path.basename(uri.fsPath));
  }

  async movePasswords() {
    const vscode = vs();
    let moved = 0;
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const file = path.join(folder.uri.fsPath, CONFIG_REL);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const raws = parseConfigText(text);
      const toStore = [];
      raws.forEach((raw, i) => {
        const variants = [undefined, ...Object.keys(raw.profiles || {})];
        for (const p of variants) {
          try {
            const c = resolveConfig(raw, folder.uri.fsPath, p, i);
            if (c.password !== undefined) toStore.push([c.secretKey, c.password]);
          } catch { /* skip */ }
        }
      });
      if (!toStore.length) continue;
      for (const [k, v] of toStore) await this.context.secrets.store(`cs.pw:${k}`, v);
      const doc = vscode.workspace.textDocuments.find(d => fileKey(d.uri.fsPath) === fileKey(file));
      if (doc && doc.isDirty) await doc.save();
      fs.writeFileSync(file, stripPasswords(fs.readFileSync(file, 'utf8')), 'utf8');
      moved += toStore.length;
    }
    this.loadConfigs();
    vscode.window.showInformationMessage(moved
      ? `Claude Studio: moved ${moved} password(s) into secure storage and removed them from sftp.json.`
      : 'Claude Studio: no plain-text passwords found in sftp.json.');
  }

  async forgetPassword() {
    const vscode = vs();
    if (!this.configs.length) return;
    const pick = await vscode.window.showQuickPick(this.configs.map(c => ({ label: this.label(c), description: c.secretKey, c })), { placeHolder: 'Forget the saved password for…' });
    if (!pick) return;
    await this.context.secrets.delete(`cs.pw:${pick.c.secretKey}`);
    await this.context.secrets.delete(`cs.pw:${pick.c.secretKey}#passphrase`);
    this.sessionPasswords.delete(pick.c.secretKey);
    this.forgetConnection(pick.c);
    vscode.window.showInformationMessage(`Claude Studio: password for ${pick.label} forgotten.`);
  }

  async forgetHostKey() {
    const vscode = vs();
    const known = this.context.globalState.get('cs.knownHosts', {});
    const ids = Object.keys(known);
    if (!ids.length) { vscode.window.showInformationMessage('Claude Studio: no saved server keys.'); return; }
    const pick = await vscode.window.showQuickPick(ids.map(id => ({ label: id, description: known[id] })), { placeHolder: 'Forget the saved key for…' });
    if (!pick) return;
    delete known[pick.label];
    await this.context.globalState.update('cs.knownHosts', known);
    vscode.window.showInformationMessage(`Claude Studio: key for ${pick.label} forgotten. You'll be asked to trust it on the next connection.`);
  }

  clearHistory() {
    this.history = [];
    this._onDidChange.fire();
    this.updateStatus();
  }
}

function reasonLabel(r) {
  return { claude: 'Claude edit', save: 'Saved by you', manual: 'Manual upload', task: 'Claude task', revert: 'Reverted file' }[r] || r || '';
}

/** Error text without anything that could contain credentials. */
function cleanError(e) {
  const msg = String((e && e.message) || e || 'Unknown error');
  return msg.replace(/password[=:]\S+/gi, 'password=***').slice(0, 300);
}

module.exports = { Uploader, cleanError };
