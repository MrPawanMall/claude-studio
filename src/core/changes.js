'use strict';
// Changes panel + review actions: diff, undo one file, revert a whole task,
// manual checkpoints, and the copyable task summary.

const path = require('path');
const { vs, cfg, NS, fileKey, clock, timeAgo } = require('../util');

const BEFORE_SCHEME = 'claude-studio-before';

class ChangesView {
  /**
   * @param {import('./tracker').ChangeTracker} tracker
   */
  constructor(context, tracker, hooks = {}) {
    const vscode = vs();
    this.tracker = tracker;
    this.hooks = hooks; // { uploadFiles(uris), log(msg) }
    this.beforeDocs = new Map();
    this.beforeSeq = 0;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;

    const provider = {
      provideTextDocumentContent: uri => {
        const id = new URLSearchParams(uri.query).get('id');
        return this.beforeDocs.get(id) ?? '';
      },
    };
    context.subscriptions.push(
      this._onDidChange,
      vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, provider),
      tracker.onDidChange(() => this._onDidChange.fire()),
    );
  }

  refresh() { this._onDidChange.fire(); }

  // ---------- tree ----------
  getChildren(node) {
    if (!node) {
      const roots = [];
      if (this.tracker.checkpoints.length) roots.push({ kind: 'checkpoints' });
      for (const t of this.tracker.tasks) roots.push({ kind: 'task', task: t });
      return roots;
    }
    if (node.kind === 'checkpoints') return this.tracker.checkpoints.map(cp => ({ kind: 'checkpoint', cp }));
    if (node.kind === 'task') {
      return [...node.task.files.values()]
        .sort((a, b) => b.time - a.time)
        .map(entry => ({ kind: 'file', entry, task: node.task }));
    }
    return [];
  }

  getTreeItem(node) {
    const vscode = vs();
    const S = vscode.TreeItemCollapsibleState;
    if (node.kind === 'checkpoints') {
      const t = new vscode.TreeItem('Checkpoints', S.Collapsed);
      t.iconPath = new vscode.ThemeIcon('history');
      t.contextValue = 'checkpoints';
      return t;
    }
    if (node.kind === 'checkpoint') {
      const { cp } = node;
      const t = new vscode.TreeItem(cp.label, S.None);
      t.description = `${cp.originals.size} file(s) changed since · ${timeAgo(cp.time)}`;
      t.iconPath = new vscode.ThemeIcon('bookmark');
      t.contextValue = 'checkpoint';
      t.tooltip = `Created ${new Date(cp.time).toLocaleString()}. Right-click to revert everything Claude changed since then.`;
      return t;
    }
    if (node.kind === 'task') {
      const { task } = node;
      const files = task.files.size;
      const label = task.finished ? `Task ${task.id} · ${clock(task.start)}` : `Task ${task.id} · in progress`;
      const t = new vscode.TreeItem(label, task === this.tracker.tasks[0] ? S.Expanded : S.Collapsed);
      const add = [...task.files.values()].reduce((s, e) => s + e.added, 0);
      const rem = [...task.files.values()].reduce((s, e) => s + e.removed, 0);
      t.description = `${files} file${files === 1 ? '' : 's'} · +${add} −${rem}`;
      t.iconPath = new vscode.ThemeIcon(task.finished ? 'checklist' : 'loading~spin');
      t.contextValue = 'task';
      t.id = `task-${task.id}`;
      return t;
    }
    const { entry } = node;
    const rel = vscode.workspace.asRelativePath(entry.uri);
    const t = new vscode.TreeItem(path.basename(entry.uri.fsPath), S.None);
    t.resourceUri = entry.uri;
    t.description = `${entry.isNew ? 'new · ' : ''}+${entry.added} −${entry.removed}${entry.reviewed ? ' · ✓' : ''}  ${path.dirname(rel) === '.' ? '' : path.dirname(rel)}`;
    t.tooltip = `${rel}\n${entry.isNew ? 'Created' : 'Changed'} by Claude ${timeAgo(entry.time)}\n+${entry.added} added, −${entry.removed} removed${entry.reviewed ? '\nReviewed' : ''}`;
    t.contextValue = entry.isNew ? 'changeFileNew' : 'changeFile';
    const clickDiff = cfg('changes').get('clickOpensDiff', true) && !entry.isNew;
    t.command = clickDiff
      ? { command: `${NS}.changes.diff`, title: 'Show diff', arguments: [node] }
      : { command: 'vscode.open', title: 'Open', arguments: [entry.uri] };
    return t;
  }

  // ---------- helpers ----------
  resolveFile(arg) {
    const vscode = vs();
    if (arg && arg.kind === 'file') return arg.entry.uri;
    if (arg instanceof vscode.Uri) return arg;
    const ed = vscode.window.activeTextEditor;
    return ed ? ed.document.uri : undefined;
  }

  beforeUri(uri, content) {
    const vscode = vs();
    const id = String(++this.beforeSeq);
    this.beforeDocs.set(id, content ?? '');
    if (this.beforeDocs.size > 50) this.beforeDocs.delete(this.beforeDocs.keys().next().value);
    return vscode.Uri.from({ scheme: BEFORE_SCHEME, path: uri.path, query: `id=${id}` });
  }

  // ---------- commands ----------
  async diff(arg, sinceTaskStart = false) {
    const vscode = vs();
    const uri = this.resolveFile(arg);
    if (!uri) return;
    const found = this.tracker.latestEntry(uri);
    if (!found) { vscode.window.showInformationMessage('Claude hasn\'t changed this file in this session.'); return; }
    const { entry } = found;
    const before = sinceTaskStart || (arg && arg.kind === 'file') ? entry.original : entry.lastBefore;
    const left = this.beforeUri(uri, before);
    await vscode.commands.executeCommand('vscode.diff', left, uri,
      `${path.basename(uri.fsPath)} (before Claude) ↔ now`, { preview: true, preserveFocus: false });
    if (this.tracker.markReviewed(uri)) this.refresh();
  }

  async undoFile(arg) {
    const vscode = vs();
    const uri = this.resolveFile(arg);
    if (!uri) return;
    const found = this.tracker.latestEntry(uri);
    if (!found) { vscode.window.showInformationMessage('Claude hasn\'t changed this file in this session.'); return; }
    const { entry, task } = found;
    const name = path.basename(uri.fsPath);
    const message = entry.original === null
      ? `Undo Claude's changes to ${name}? Claude created this file, so it will be moved to the trash.`
      : `Undo Claude's changes to ${name}? It goes back to how it was before task ${task.id}.`;
    const ok = await vscode.window.showWarningMessage(message, { modal: true }, 'Undo');
    if (ok !== 'Undo') return;
    await this.restore([{ uri, content: entry.original }]);
    task.files.delete(fileKey(uri.fsPath));
    if (!task.files.size) this.tracker.removeTask(task);
    this.refresh();
  }

  async revertTask(node) {
    const vscode = vs();
    const task = node && node.task ? node.task : this.tracker.tasks[0];
    if (!task) { vscode.window.showInformationMessage('There is no Claude task to revert.'); return; }
    const plan = this.tracker.restorePlanForTask(task);
    const created = plan.filter(p => p.content === null).length;
    const ok = await vscode.window.showWarningMessage(
      `Revert task ${task.id}? ${plan.length} file(s) go back to how they were before Claude started.` +
      (created ? ` ${created} new file(s) Claude created will be moved to the trash.` : ''),
      { modal: true }, 'Revert');
    if (ok !== 'Revert') return;
    await this.restore(plan);
    this.tracker.removeTask(task);
  }

  async createCheckpoint() {
    const vscode = vs();
    const label = await vscode.window.showInputBox({
      prompt: 'Name this checkpoint (you can revert everything Claude changes after this point)',
      value: `Before ${clock(Date.now())}`,
    });
    if (label === undefined) return;
    this.tracker.createCheckpoint(label);
    vscode.window.setStatusBarMessage(`Claude Studio: checkpoint "${label}" created`, 3000);
  }

  async revertCheckpoint(node) {
    const vscode = vs();
    const cp = node && node.cp ? node.cp : this.tracker.checkpoints[0];
    if (!cp) { vscode.window.showInformationMessage('No checkpoint yet. Create one before giving Claude a task.'); return; }
    const plan = this.tracker.restorePlanForCheckpoint(cp);
    if (!plan.length) { vscode.window.showInformationMessage(`Claude hasn't changed anything since "${cp.label}".`); return; }
    const ok = await vscode.window.showWarningMessage(
      `Revert everything Claude changed since "${cp.label}"? ${plan.length} file(s) will be restored.`,
      { modal: true }, 'Revert');
    if (ok !== 'Revert') return;
    await this.restore(plan);
    cp.originals.clear();
    this.tracker.removeCheckpoint(cp);
  }

  async restore(plan) {
    const vscode = vs();
    const restored = [];
    const skipped = [];
    for (const { uri, content } of plan) {
      const open = vscode.workspace.textDocuments.find(d => fileKey(d.uri.fsPath) === fileKey(uri.fsPath));
      if (open && open.isDirty) { skipped.push(uri); continue; }
      try {
        if (content === null) {
          this.tracker.markSelfWrite(uri);
          await vscode.workspace.fs.delete(uri, { useTrash: true });
          this.tracker.forget(uri);
        } else {
          this.tracker.markSelfWrite(uri, content);
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
          this.tracker.snapshot(uri, content);
          restored.push(uri);
        }
      } catch (e) {
        this.hooks.log && this.hooks.log(`Restore failed for ${uri.fsPath}: ${e.message}`);
        skipped.push(uri);
      }
    }
    if (skipped.length) {
      vscode.window.showWarningMessage(`Claude Studio: ${skipped.length} file(s) were not restored because they have unsaved changes or couldn't be written: ` +
        skipped.map(u => path.basename(u.fsPath)).join(', '));
    }
    if (restored.length && this.hooks.uploadFiles && cfg('upload').get('uploadAfterRevert', true)) {
      this.hooks.uploadFiles(restored, 'revert');
    }
    vscode.window.setStatusBarMessage(`Claude Studio: restored ${restored.length} file(s)`, 4000);
  }

  summary(task) {
    const vscode = vs();
    const files = [...task.files.values()];
    const add = files.reduce((s, e) => s + e.added, 0);
    const rem = files.reduce((s, e) => s + e.removed, 0);
    const lines = [
      `Claude task ${task.id} (${clock(task.start)}–${clock(task.end)}): ${files.length} file(s) changed, +${add} −${rem}`,
      '',
      ...files.map(e => `- ${vscode.workspace.asRelativePath(e.uri)}${e.isNew ? ' (new)' : ''} (+${e.added} −${e.removed})`),
    ];
    return lines.join('\n');
  }

  async copySummary(node) {
    const vscode = vs();
    const task = node && node.task ? node.task : this.tracker.tasks[0];
    if (!task) { vscode.window.showInformationMessage('No Claude task yet.'); return; }
    await vscode.env.clipboard.writeText(this.summary(task));
    vscode.window.setStatusBarMessage('Claude Studio: task summary copied', 3000);
  }

  async markReviewed(arg) {
    const vscode = vs();
    if (arg && arg.kind === 'task') {
      for (const e of arg.task.files.values()) e.reviewed = true;
      this.tracker._onDidChange.fire();
      return;
    }
    const uri = this.resolveFile(arg);
    if (uri && this.tracker.markReviewed(uri)) return;
    vscode.window.setStatusBarMessage('Claude Studio: nothing to review in this file', 2500);
  }

  taskFiles(node) {
    const task = node && node.task ? node.task : this.tracker.tasks[0];
    if (!task) return [];
    return [...task.files.values()].map(e => e.uri);
  }
}

module.exports = { ChangesView, BEFORE_SCHEME };
