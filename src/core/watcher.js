'use strict';
// Detects files that change on disk without being saved from the editor
// (i.e. written by the Claude agent), records them, opens them, scrolls to the
// first change and marks the changed lines.

const path = require('path');
const { vs, cfg, NS, fileKey, matchesAny } = require('../util');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const USER_SAVE_GRACE_MS = 1500;

class Watcher {
  /**
   * @param {import('./tracker').ChangeTracker} tracker
   */
  constructor(context, tracker) {
    const vscode = vs();
    this.context = context;
    this.tracker = tracker;
    this.userSaves = new Map();
    this.pending = new Map();
    this.flushTimer = undefined;
    this.pausedUntil = 0;
    this.pauseTimer = undefined;
    /** files we opened, oldest first (for the tab limit) */
    this.openedByUs = [];

    this.flashType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.markerType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.statusItem = vscode.window.createStatusBarItem(`${NS}.autoOpen`, vscode.StatusBarAlignment.Right, 101);
    this.statusItem.name = 'Claude Studio: Auto Open';
    this.statusItem.command = `${NS}.autoOpen.menu`;
    this.updateStatus();
    this.statusItem.show();

    vscode.workspace.textDocuments.forEach(d => this.snapshotDoc(d));

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    context.subscriptions.push(
      this.flashType, this.markerType, this.statusItem, watcher,
      watcher.onDidChange(uri => this.queue(uri, false)),
      watcher.onDidCreate(uri => this.queue(uri, true)),
      watcher.onDidDelete(uri => this.tracker.forget(uri)),
      vscode.workspace.onDidOpenTextDocument(d => this.snapshotDoc(d)),
      vscode.workspace.onWillSaveTextDocument(e => this.userSaves.set(fileKey(e.document.uri.fsPath), Date.now())),
      vscode.workspace.onDidSaveTextDocument(d => {
        this.userSaves.set(fileKey(d.uri.fsPath), Date.now());
        this.snapshotDoc(d);
      }),
      vscode.workspace.onDidChangeTextDocument(e => {
        // typing in a file means the user is looking at it: clear its review markers
        if (e.document.isDirty && e.contentChanges.length && this.tracker.markReviewed(e.document.uri)) this.refreshMarkers();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshMarkers()),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(NS)) this.updateStatus(); }),
      tracker.onDidChange(() => this.refreshMarkers()),
      { dispose: () => { clearTimeout(this.flushTimer); clearTimeout(this.pauseTimer); } },
    );
  }

  // ---------- state ----------
  get enabled() {
    return cfg('autoOpen').get('enabled', true);
  }

  get paused() {
    return Date.now() < this.pausedUntil;
  }

  pause(minutes) {
    clearTimeout(this.pauseTimer);
    this.pausedUntil = minutes ? Date.now() + minutes * 60000 : 0;
    if (minutes) this.pauseTimer = setTimeout(() => this.updateStatus(), minutes * 60000 + 500);
    this.updateStatus();
  }

  updateStatus() {
    const vscode = vs();
    const s = this.statusItem;
    if (!this.enabled) {
      s.text = '$(eye-closed) Claude Studio';
      s.tooltip = 'Auto-open is off. Click for options.';
    } else if (this.paused) {
      const mins = Math.ceil((this.pausedUntil - Date.now()) / 60000);
      s.text = `$(debug-pause) Claude Studio ${mins}m`;
      s.tooltip = `Auto-open paused for ${mins} more minute(s). Click for options.`;
    } else {
      s.text = '$(eye) Claude Studio';
      s.tooltip = new vscode.MarkdownString('**Claude Studio by PM**\n\nFiles edited by Claude open automatically.\n\nClick for options.');
    }
  }

  snapshotDoc(doc) {
    if (doc.uri.scheme === 'file' && !doc.isDirty) {
      const text = doc.getText();
      if (text.length <= MAX_FILE_BYTES) this.tracker.snapshot(doc.uri, text);
    }
  }

  isExcluded(uri) {
    const vscode = vs();
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const rel = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
    return matchesAny(cfg('autoOpen').get('exclude', []), rel, uri.fsPath);
  }

  // ---------- watcher pipeline ----------
  queue(uri, isNew) {
    if (uri.scheme !== 'file' || this.isExcluded(uri)) return;
    const k = fileKey(uri.fsPath);
    const saved = this.userSaves.get(k);
    if (saved && Date.now() - saved < USER_SAVE_GRACE_MS) return; // the user saved it, not Claude

    const prev = this.pending.get(k);
    this.pending.set(k, { uri, isNew: isNew || (prev && prev.isNew) });
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), cfg('autoOpen').get('debounceMs', 300));
  }

  async readText(uri) {
    const vscode = vs();
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory || stat.size > MAX_FILE_BYTES) return null;
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.subarray(0, 8000).includes(0)) return null; // binary
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return null;
    }
  }

  async flush() {
    const batch = [...this.pending.values()];
    this.pending.clear();

    const items = [];
    for (const item of batch) {
      const text = await this.readText(item.uri);
      if (text === null) continue;
      if (this.tracker.isSelfWrite(item.uri, text)) { this.tracker.snapshot(item.uri, text); continue; }
      const before = this.tracker.getSnapshot(item.uri);
      if (before === text) continue;
      items.push({ ...item, text, before: before === undefined ? null : before });
    }
    if (!items.length) return;

    const max = cfg('autoOpen').get('maxFilesPerBurst', 5);
    if (items.length > max) {
      items.forEach(it => this.tracker.snapshot(it.uri, it.text));
      this.log && this.log(`Skipped a burst of ${items.length} changed files (more than ${max}): probably git, composer, npm or a build.`);
      return;
    }

    for (const it of items) {
      const entry = this.tracker.record(it.uri, it.before, it.text, it.isNew);
      if (this.enabled && !this.paused && (!entry.isNew || cfg('autoOpen').get('openNewFiles', true))) {
        try { await this.open(it.uri, it.text, it.before !== null); }
        catch (err) { this.log && this.log(`Could not open ${it.uri.fsPath}: ${err.message}`); }
      }
    }
  }

  // ---------- opening ----------
  targetColumn(uri) {
    const vscode = vs();
    const visible = vscode.window.visibleTextEditors.find(e => fileKey(e.document.uri.fsPath) === fileKey(uri.fsPath));
    if (visible && visible.viewColumn) return visible.viewColumn;
    const groups = vscode.window.tabGroups.all;
    const textGroup = groups.find(g => g.activeTab && g.activeTab.input instanceof vscode.TabInputText);
    if (textGroup) return textGroup.viewColumn;
    const nonWebview = groups.find(g => !(g.activeTab && g.activeTab.input instanceof vscode.TabInputWebview));
    if (nonWebview) return nonWebview.viewColumn;
    return vscode.ViewColumn.Beside; // only the Claude panel is open: don't cover it
  }

  async open(uri, newText, highlight) {
    const vscode = vs();
    const c = cfg('autoOpen');
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: this.targetColumn(uri),
      preserveFocus: c.get('preserveFocus', true),
      preview: c.get('preview', false),
    });

    if (doc.getText() !== newText && !doc.isDirty) {
      await new Promise(resolve => {
        const sub = vscode.workspace.onDidChangeTextDocument(e => {
          if (e.document === doc && doc.getText() === newText) { sub.dispose(); resolve(); }
        });
        setTimeout(() => { sub.dispose(); resolve(); }, 1000);
      });
    }

    this.rememberOpened(uri);
    await this.enforceTabLimit();

    if (!highlight || doc.isDirty) return;
    const lines = this.tracker.pendingReview(uri).filter(l => l < doc.lineCount);
    if (!lines.length) return;
    const ranges = lines.map(l => new vscode.Range(l, 0, l, 0));
    if (c.get('highlightChanges', true)) {
      editor.setDecorations(this.flashType, ranges);
      setTimeout(() => { try { editor.setDecorations(this.flashType, []); } catch { /* closed */ } }, c.get('highlightDurationMs', 4000));
    }
    if (c.get('scrollToChange', true)) editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.refreshMarkers();
  }

  refreshMarkers() {
    const vscode = vs();
    const keep = cfg('autoOpen').get('keepMarkersUntilReviewed', true);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== 'file') continue;
      const lines = keep ? this.tracker.pendingReview(editor.document.uri) : [];
      editor.setDecorations(this.markerType, lines.filter(l => l < editor.document.lineCount).map(l => new vscode.Range(l, 0, l, 0)));
    }
  }

  // ---------- tabs ----------
  rememberOpened(uri) {
    const k = fileKey(uri.fsPath);
    this.openedByUs = this.openedByUs.filter(u => fileKey(u.fsPath) !== k);
    this.openedByUs.push(uri);
  }

  ourTabs() {
    const vscode = vs();
    const keys = new Set(this.openedByUs.map(u => fileKey(u.fsPath)));
    const tabs = [];
    for (const g of vscode.window.tabGroups.all) {
      for (const t of g.tabs) {
        if (t.input instanceof vscode.TabInputText && keys.has(fileKey(t.input.uri.fsPath))) tabs.push(t);
      }
    }
    return tabs;
  }

  async enforceTabLimit() {
    const vscode = vs();
    const max = cfg('autoOpen').get('maxOpenTabs', 0);
    if (!max) return;
    const tabs = this.ourTabs();
    if (tabs.length <= max) return;
    const order = this.openedByUs.map(u => fileKey(u.fsPath));
    const closable = tabs
      .filter(t => !t.isDirty && !t.isPinned && !t.isActive)
      .sort((a, b) => order.indexOf(fileKey(a.input.uri.fsPath)) - order.indexOf(fileKey(b.input.uri.fsPath)));
    const toClose = closable.slice(0, tabs.length - max);
    if (toClose.length) await vscode.window.tabGroups.close(toClose, true);
  }

  async closeOurTabs() {
    const vscode = vs();
    const tabs = this.ourTabs().filter(t => !t.isDirty);
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    this.openedByUs = [];
    return tabs.length;
  }
}

module.exports = { Watcher };
