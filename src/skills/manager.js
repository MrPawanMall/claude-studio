'use strict';
// Skills manager: see installed Claude skills (personal + project), browse and
// install skills from several sources, preview before installing, create,
// disable/enable, delete, and check for updates.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { vs, cfg, NS, slug, safeRelative, escapeHtml, fileKey } = require('../util');
const { listSource, parseFrontmatter, parseGithub, isRisky, LIMITS } = require('./sources');
const { page, handleMessages, webviewOptions } = require('../ui/webview');

const META = '.skill-source.json';
const DEFAULT_SOURCES = [{ name: 'Anthropic official skills', type: 'github', repo: 'anthropics/skills', path: 'skills' }];

class SkillsManager {
  constructor(context, { notify, log }) {
    const vscode = vs();
    this.context = context;
    this.notify = notify;
    this.log = log;
    this.cache = new Map();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;

    const personal = vscode.Uri.file(this.personalDir());
    const w1 = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(personal, '**/SKILL.md'));
    const w2 = vscode.workspace.createFileSystemWatcher('**/.claude/skills/**/SKILL.md');
    const refresh = () => this.refresh();
    context.subscriptions.push(this._onDidChange, w1, w2,
      w1.onDidCreate(refresh), w1.onDidDelete(refresh), w1.onDidChange(refresh),
      w2.onDidCreate(refresh), w2.onDidDelete(refresh), w2.onDidChange(refresh),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(`${NS}.skills`)) refresh(); }));
  }

  refresh() { this._onDidChange.fire(); }

  // ---------- locations ----------
  personalDir() { return path.join(os.homedir(), '.claude', 'skills'); }
  personalDisabledDir() { return path.join(os.homedir(), '.claude', 'skills-disabled'); }
  projectRoot() {
    const vscode = vs();
    const f = vscode.workspace.workspaceFolders;
    return f && f.length ? f[0].uri.fsPath : null;
  }
  projectDir() { const r = this.projectRoot(); return r ? path.join(r, '.claude', 'skills') : null; }
  projectDisabledDir() { const r = this.projectRoot(); return r ? path.join(r, '.claude', 'skills-disabled') : null; }

  sources() {
    const s = cfg('skills').get('sources');
    return Array.isArray(s) && s.length ? s : DEFAULT_SOURCES;
  }

  scan(dir, scope, disabled = false) {
    if (!dir) return [];
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.isDirectory()) continue;
      const folder = path.join(dir, n.name);
      const md = path.join(folder, 'SKILL.md');
      let text;
      try { text = fs.readFileSync(md, 'utf8'); } catch { continue; }
      const fm = parseFrontmatter(text);
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(folder, META), 'utf8')); } catch { /* not installed by us */ }
      out.push({ kind: 'skill', scope, disabled, folder, md, name: fm.name || n.name, description: fm.description || '', meta });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------- tree ----------
  getChildren(node) {
    if (!node) {
      const roots = [
        { kind: 'group', id: 'personal', label: 'Personal skills', hint: 'all projects', items: this.scan(this.personalDir(), 'personal') },
      ];
      if (this.projectDir()) roots.push({ kind: 'group', id: 'project', label: 'Project skills', hint: 'this project', items: this.scan(this.projectDir(), 'project') });
      const disabled = [...this.scan(this.personalDisabledDir(), 'personal', true), ...this.scan(this.projectDisabledDir(), 'project', true)];
      if (disabled.length) roots.push({ kind: 'group', id: 'disabled', label: 'Disabled', items: disabled });
      roots.push({ kind: 'sources' });
      return roots;
    }
    if (node.kind === 'group') return node.items;
    if (node.kind === 'sources') {
      return [...this.sources().map((source, index) => ({ kind: 'source', source, index })), { kind: 'addSource' }];
    }
    return [];
  }

  getTreeItem(node) {
    const vscode = vs();
    const S = vscode.TreeItemCollapsibleState;
    if (node.kind === 'group') {
      const t = new vscode.TreeItem(node.label, node.id === 'disabled' ? S.Collapsed : S.Expanded);
      t.description = `${node.items.length}${node.hint ? ' · ' + node.hint : ''}`;
      t.iconPath = new vscode.ThemeIcon(node.id === 'personal' ? 'account' : node.id === 'project' ? 'folder' : 'circle-slash');
      t.contextValue = `skillGroup-${node.id}`;
      return t;
    }
    if (node.kind === 'sources') {
      const t = new vscode.TreeItem('Browse sources', S.Expanded);
      t.iconPath = new vscode.ThemeIcon('cloud-download');
      t.contextValue = 'skillSources';
      return t;
    }
    if (node.kind === 'addSource') {
      const t = new vscode.TreeItem('Add a source…');
      t.iconPath = new vscode.ThemeIcon('add');
      t.command = { command: `${NS}.skills.addSource`, title: 'Add source' };
      return t;
    }
    if (node.kind === 'source') {
      const s = node.source;
      const t = new vscode.TreeItem(s.name || s.repo || s.url || s.folder);
      t.description = s.type === 'github' ? `GitHub · ${s.repo}${s.path ? '/' + s.path : ''}` : s.type === 'url' ? 'Link' : 'Folder';
      t.iconPath = new vscode.ThemeIcon(s.type === 'github' ? 'github' : s.type === 'url' ? 'link' : 'folder-library');
      t.contextValue = 'skillSource';
      t.tooltip = 'Click to browse and install skills from this source';
      t.command = { command: `${NS}.skills.browse`, title: 'Browse', arguments: [node] };
      return t;
    }
    // installed skill
    const t = new vscode.TreeItem(node.name);
    t.description = node.description.length > 70 ? node.description.slice(0, 70) + '…' : node.description;
    t.tooltip = new vscode.MarkdownString(`**${escapeMd(node.name)}**${node.disabled ? ' _(disabled)_' : ''}\n\n${escapeMd(node.description)}\n\n\`${escapeMd(node.folder)}\`` +
      (node.meta ? `\n\nInstalled from ${escapeMd(node.meta.label || '')}` : ''));
    t.iconPath = new vscode.ThemeIcon(node.disabled ? 'circle-slash' : 'sparkle');
    t.contextValue = node.disabled ? 'skillDisabled' : (node.meta ? 'skillTracked' : 'skill');
    t.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(node.md)] };
    t.resourceUri = vscode.Uri.file(node.folder);
    return t;
  }

  // ---------- browse & install ----------
  async githubToken() {
    return this.context.secrets.get('cs.githubToken');
  }

  async browse(node) {
    const vscode = vs();
    let source = node && node.source;
    if (!source) {
      const pick = await vscode.window.showQuickPick(
        [...this.sources().map(s => ({ label: s.name || s.repo || s.url || s.folder, description: s.type, s })),
          { label: '$(add) Add a source…', add: true }],
        { placeHolder: 'Browse skills from…' });
      if (!pick) return;
      if (pick.add) return this.addSource();
      source = pick.s;
    }
    const key = JSON.stringify(source);
    let skills = this.cache.get(key);
    if (!skills) {
      try {
        skills = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Loading skills from ${source.name || source.repo || source.url}…`, cancellable: false },
          async progress => listSource(source, await this.githubToken(), (n, total) => progress.report({ message: `${n}/${total}` })));
      } catch (e) {
        vscode.window.showErrorMessage(`Claude Studio: couldn't load skills — ${e.message}`);
        return;
      }
      this.cache.set(key, skills);
    }
    if (!skills.length) { vscode.window.showInformationMessage('No skills (SKILL.md files) found in this source.'); return; }

    const installed = new Set([...this.scan(this.personalDir(), 'personal'), ...this.scan(this.projectDir(), 'project')].map(s => s.name.toLowerCase()));
    const pick = await vscode.window.showQuickPick(skills.map(s => ({
      label: `${installed.has(s.name.toLowerCase()) ? '$(check) ' : ''}${s.name}`,
      description: s.dir,
      detail: s.description,
      skill: s,
    })), { placeHolder: `${skills.length} skills — pick one to preview`, matchOnDescription: true, matchOnDetail: true });
    if (!pick) return;
    return this.preview(pick.skill);
  }

  async preview(skill) {
    const vscode = vs();
    let skillMd = '';
    try { skillMd = (await skill.readFile('SKILL.md')).toString('utf8'); } catch (e) { skillMd = `(couldn't load SKILL.md: ${e.message})`; }
    const risky = skill.files.filter(f => isRisky(f.rel));
    const totalSize = skill.files.reduce((s, f) => s + (f.size || 0), 0);
    const srcLabel = sourceLabel(skill.source);

    const panel = vscode.window.createWebviewPanel('claudeStudio.skillPreview', `Skill: ${skill.name}`, vscode.ViewColumn.Active, webviewOptions(this.context.extensionUri));
    const fileRows = skill.files.slice(0, 200).map(f =>
      `<tr><td>${isRisky(f.rel) ? '<span class="warn">⚠</span> ' : ''}${escapeHtml(f.rel)}</td><td class="num">${(f.size / 1024).toFixed(1)} KB</td></tr>`).join('');
    const body = `
<h1>${escapeHtml(skill.name)}</h1>
<p class="muted">From ${escapeHtml(srcLabel)}${skill.dir ? ' · ' + escapeHtml(skill.dir) : ''}</p>
<p>${escapeHtml(skill.description)}</p>
<div class="card note">
  <strong>Before you install:</strong> a skill gives Claude instructions, and it can include scripts that Claude may run on your computer.
  Only install skills from sources you trust, and read the SKILL.md below.
  ${risky.length ? `<p class="warn"><strong>${risky.length} script/program file(s)</strong> in this skill are marked with ⚠.</p>` : '<p class="ok">No scripts or programs in this skill.</p>'}
</div>
<div class="actions">
  <a class="btn" data-cmd="install" data-arg="personal">Install for all my projects</a>
  ${this.projectDir() ? '<a class="btn secondary" data-cmd="install" data-arg="project">Install for this project only</a>' : ''}
  <a class="btn secondary" data-cmd="close">Cancel</a>
</div>
<h2>Files (${skill.files.length}, ${(totalSize / 1024).toFixed(0)} KB)</h2>
<table>${fileRows}</table>
<h2>SKILL.md</h2>
<pre>${escapeHtml(skillMd)}</pre>`;
    const css = '.note{margin:14px 0}.actions{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0 22px}h2{margin-top:22px}';
    panel.webview.html = page(panel.webview, { title: `Skill: ${skill.name}`, body, css });
    const sub = handleMessages(panel.webview, {
      install: async scope => {
        if (scope !== 'personal' && scope !== 'project') return;
        const ok = await this.install(skill, scope);
        if (ok) panel.dispose();
      },
      close: () => panel.dispose(),
    });
    panel.onDidDispose(() => sub.dispose());
  }

  async install(skill, scope) {
    const vscode = vs();
    const base = scope === 'project' ? this.projectDir() : this.personalDir();
    if (!base) return false;
    if (scope === 'project' && !vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace before installing project skills.');
      return false;
    }
    if (skill.files.length > LIMITS.maxFiles) { vscode.window.showErrorMessage(`This skill has too many files (${skill.files.length}).`); return false; }
    const total = skill.files.reduce((s, f) => s + (f.size || 0), 0);
    if (total > LIMITS.maxTotalBytes) { vscode.window.showErrorMessage('This skill is too large to install (over 30 MB).'); return false; }

    const folderName = slug(skill.name) || 'skill';
    const target = path.join(base, folderName);
    if (fs.existsSync(target)) {
      const ok = await vscode.window.showWarningMessage(`A skill named "${folderName}" is already installed. Replace it?`, { modal: true }, 'Replace');
      if (ok !== 'Replace') return false;
      await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
    }

    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${skill.name}…` }, async progress => {
        let i = 0;
        for (const f of skill.files) {
          const rel = safeRelative(f.rel);
          if (!rel || rel === META) continue;
          const dest = path.join(target, ...rel.split('/'));
          if (!dest.startsWith(target + path.sep)) continue; // path-escape guard
          const data = await skill.readFile(f.rel);
          if (data.length > LIMITS.maxFileBytes) throw new Error(`${f.rel} is too large`);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, data);
          progress.report({ message: `${++i}/${skill.files.length}`, increment: 100 / skill.files.length });
        }
        if (!fs.existsSync(path.join(target, 'SKILL.md'))) throw new Error('SKILL.md missing after download');
        fs.writeFileSync(path.join(target, META), JSON.stringify({
          label: sourceLabel(skill.source), source: stripSource(skill.source), dir: skill.dir, version: skill.version || null,
          installedAt: new Date().toISOString(),
        }, null, 2));
      });
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Studio: installing ${skill.name} failed — ${e.message}`);
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
      return false;
    }
    this.refresh();
    this.notify({
      event: 'skillInstalled',
      title: `Skill "${skill.name}" installed`,
      message: scope === 'project' ? 'for this project' : 'for all projects',
      actions: [{ title: 'Open SKILL.md', run: () => vscode.window.showTextDocument(vscode.Uri.file(path.join(target, 'SKILL.md'))) }],
    });
    return true;
  }

  // ---------- sources ----------
  async addSource() {
    const vscode = vs();
    const type = await vscode.window.showQuickPick([
      { label: '$(github) GitHub repository', description: 'owner/repo or a github.com link', type: 'github' },
      { label: '$(link) Link to a .zip or SKILL.md', description: 'https:// only', type: 'url' },
      { label: '$(folder-library) Folder on this computer', type: 'folder' },
    ], { placeHolder: 'Where should Claude Studio look for skills?' });
    if (!type) return;
    let source;
    if (type.type === 'github') {
      const input = await vscode.window.showInputBox({ prompt: 'GitHub repository', placeHolder: 'owner/repo  or  https://github.com/owner/repo/tree/main/skills' });
      if (!input) return;
      const gh = parseGithub(input);
      if (!gh) { vscode.window.showErrorMessage('That doesn\'t look like a GitHub repository.'); return; }
      source = { name: gh.repo, type: 'github', ...gh };
    } else if (type.type === 'url') {
      const url = await vscode.window.showInputBox({ prompt: 'Link to a .zip file or a SKILL.md', placeHolder: 'https://…', validateInput: v => (/^https:\/\//.test(v) ? undefined : 'Must start with https://') });
      if (!url) return;
      source = { name: new URL(url).hostname + new URL(url).pathname.split('/').slice(-1)[0].replace(/^/, ' · '), type: 'url', url };
    } else {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this folder' });
      if (!picked || !picked[0]) return;
      source = { name: path.basename(picked[0].fsPath), type: 'folder', folder: picked[0].fsPath };
    }
    const name = await vscode.window.showInputBox({ prompt: 'Name for this source', value: source.name });
    if (name === undefined) return;
    source.name = name || source.name;
    const list = [...this.sources(), source];
    await cfg('skills').update('sources', list, vscode.ConfigurationTarget.Global);
    this.refresh();
    return this.browse({ source });
  }

  async removeSource(node) {
    const vscode = vs();
    if (!node || node.kind !== 'source') return;
    const ok = await vscode.window.showWarningMessage(`Remove the source "${node.source.name}"? Installed skills stay installed.`, { modal: true }, 'Remove');
    if (ok !== 'Remove') return;
    const list = this.sources().filter((_, i) => i !== node.index);
    await cfg('skills').update('sources', list.length ? list : undefined, vscode.ConfigurationTarget.Global);
    this.cache.clear();
    this.refresh();
  }

  async installFromZipFile() {
    const vscode = vs();
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Skill archive': ['zip', 'skill'] }, openLabel: 'Open skill' });
    if (!picked || !picked[0]) return;
    const buf = fs.readFileSync(picked[0].fsPath);
    if (buf.length > LIMITS.maxTotalBytes) { vscode.window.showErrorMessage('Archive is too large.'); return; }
    let skills;
    try { skills = require('./sources').listZipBuffer(buf, { type: 'zipfile', name: path.basename(picked[0].fsPath) }); }
    catch (e) { vscode.window.showErrorMessage(`Couldn't read the archive: ${e.message}`); return; }
    if (!skills.length) { vscode.window.showInformationMessage('No SKILL.md found in that archive.'); return; }
    const pick = skills.length === 1 ? { skill: skills[0] } : await vscode.window.showQuickPick(skills.map(s => ({ label: s.name, detail: s.description, skill: s })));
    if (pick) return this.preview(pick.skill);
  }

  async setGithubToken() {
    const vscode = vs();
    const token = await vscode.window.showInputBox({
      prompt: 'GitHub token (optional). Raises the GitHub rate limit and allows private skill repositories. A fine-grained token with read-only "Contents" access is enough. Leave empty to remove.',
      password: true, ignoreFocusOut: true,
    });
    if (token === undefined) return;
    if (token) await this.context.secrets.store('cs.githubToken', token.trim());
    else await this.context.secrets.delete('cs.githubToken');
    this.cache.clear();
    vscode.window.showInformationMessage(token ? 'GitHub token saved in secure storage.' : 'GitHub token removed.');
  }

  // ---------- installed skill actions ----------
  async create() {
    const vscode = vs();
    const name = await vscode.window.showInputBox({
      prompt: 'Skill name (lowercase letters, numbers and dashes)', placeHolder: 'my-codeigniter-helper',
      validateInput: v => (/^[a-z0-9][a-z0-9-]{1,62}$/.test(v) ? undefined : 'Use 2–63 lowercase letters, numbers or dashes'),
    });
    if (!name) return;
    const description = await vscode.window.showInputBox({ prompt: 'When should Claude use this skill? (one sentence)', placeHolder: 'Use when working on CodeIgniter controllers and models…' });
    if (description === undefined) return;
    const scopePick = this.projectDir()
      ? await vscode.window.showQuickPick([{ label: 'All my projects', value: 'personal' }, { label: 'This project only', value: 'project' }], { placeHolder: 'Where should it live?' })
      : { value: 'personal' };
    if (!scopePick) return;
    const base = scopePick.value === 'project' ? this.projectDir() : this.personalDir();
    const dir = path.join(base, name);
    if (fs.existsSync(dir)) { vscode.window.showErrorMessage(`A skill called "${name}" already exists.`); return; }
    fs.mkdirSync(dir, { recursive: true });
    const md = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n\n# ${name}\n\n## When to use\n\n- \n\n## Instructions\n\n1. \n\n## Examples\n\n`;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
    this.refresh();
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, 'SKILL.md')));
  }

  async toggle(node) {
    const vscode = vs();
    if (!node || node.kind !== 'skill') return;
    const enable = node.disabled;
    const targetBase = node.scope === 'project'
      ? (enable ? this.projectDir() : this.projectDisabledDir())
      : (enable ? this.personalDir() : this.personalDisabledDir());
    const target = path.join(targetBase, path.basename(node.folder));
    if (fs.existsSync(target)) { vscode.window.showErrorMessage(`There is already a skill folder at ${target}.`); return; }
    fs.mkdirSync(targetBase, { recursive: true });
    fs.renameSync(node.folder, target);
    this.refresh();
    vscode.window.setStatusBarMessage(`Claude Studio: skill "${node.name}" ${enable ? 'enabled' : 'disabled'}`, 3000);
  }

  async remove(node) {
    const vscode = vs();
    if (!node || node.kind !== 'skill') return;
    const ok = await vscode.window.showWarningMessage(`Delete the skill "${node.name}"? It will be moved to the trash.`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    await vscode.workspace.fs.delete(vscode.Uri.file(node.folder), { recursive: true, useTrash: true });
    this.refresh();
  }

  reveal(node) {
    const vscode = vs();
    if (node && node.folder) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.md));
  }

  async checkUpdates() {
    const vscode = vs();
    const tracked = [...this.scan(this.personalDir(), 'personal'), ...this.scan(this.projectDir(), 'project')]
      .filter(s => s.meta && s.meta.source && s.meta.source.type === 'github' && s.meta.version);
    if (!tracked.length) { vscode.window.showInformationMessage('No skills installed from GitHub to check.'); return; }
    const updates = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking skills for updates…' }, async () => {
      const bySource = new Map();
      for (const s of tracked) {
        const k = JSON.stringify(s.meta.source);
        if (!bySource.has(k)) bySource.set(k, []);
        bySource.get(k).push(s);
      }
      for (const [k, list] of bySource) {
        try {
          const remote = await listSource(JSON.parse(k), await this.githubToken());
          for (const s of list) {
            const r = remote.find(x => x.dir === s.meta.dir);
            if (r && r.version && r.version !== s.meta.version) updates.push({ installed: s, remote: r });
          }
        } catch (e) { this.log(`Update check failed for ${k}: ${e.message}`); }
      }
    });
    if (!updates.length) { vscode.window.showInformationMessage('All your GitHub skills are up to date.'); return; }
    const pick = await vscode.window.showQuickPick(updates.map(u => ({ label: u.installed.name, description: u.installed.scope, picked: true, u })),
      { canPickMany: true, placeHolder: `${updates.length} update(s) available — choose which to preview and install` });
    for (const p of pick || []) await this.preview(p.u.remote);
  }
}

function sourceLabel(s) {
  if (!s) return '';
  if (s.type === 'github') return `GitHub ${s.repo}`;
  if (s.type === 'url') return s.url;
  if (s.type === 'folder') return s.folder;
  return s.name || s.type;
}

function stripSource(s) {
  const { name, type, repo, branch, path: p, url, folder } = s || {};
  return { name, type, repo, branch, path: p, url, folder };
}

function escapeMd(s) {
  return String(s || '').replace(/[\\`*_{}[\]()#+!|<>]/g, '\\$&');
}

module.exports = { SkillsManager, DEFAULT_SOURCES, fileKey };
