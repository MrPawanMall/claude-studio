'use strict';
// Remembers what every file looked like before Claude changed it, groups the
// changes into "tasks" (bursts of edits separated by a quiet period), and
// powers diff, undo, revert-task and manual checkpoints.

const { vs, cfg, fileKey, diffLines } = require('../util');

const MAX_TASKS = 30;

class ChangeTracker {
  constructor() {
    const vscode = vs();
    /** last known content of files on disk */
    this.snapshots = new Map();
    /** finished + current tasks, newest first */
    this.tasks = [];
    this.current = null;
    this.taskSeq = 0;
    /** manual checkpoints */
    this.checkpoints = [];
    this.cpSeq = 0;
    /** writes made by Claude Studio itself (undo / revert), ignored by the watcher */
    this.selfWrites = new Map();
    this.quietTimer = undefined;

    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    this._onTaskFinished = new vscode.EventEmitter();
    this.onTaskFinished = this._onTaskFinished.event;
    this._onFileChanged = new vscode.EventEmitter();
    this.onFileChanged = this._onFileChanged.event;
  }

  snapshot(uri, text) {
    this.snapshots.set(fileKey(uri.fsPath), text);
  }

  getSnapshot(uri) {
    return this.snapshots.get(fileKey(uri.fsPath));
  }

  forget(uri) {
    this.snapshots.delete(fileKey(uri.fsPath));
  }

  markSelfWrite(uri, text) {
    this.selfWrites.set(fileKey(uri.fsPath), { text, until: Date.now() + 5000 });
  }

  isSelfWrite(uri, text) {
    const k = fileKey(uri.fsPath);
    const w = this.selfWrites.get(k);
    if (!w) return false;
    if (Date.now() > w.until) { this.selfWrites.delete(k); return false; }
    if (text === undefined || w.text === text) { this.selfWrites.delete(k); return true; }
    return false;
  }

  /**
   * Records a change Claude made.
   * @param {import('vscode').Uri} uri
   * @param {string|null} before  content before (null = file is new / unknown)
   * @param {string} after
   * @param {boolean} isNew
   */
  record(uri, before, after, isNew) {
    const k = fileKey(uri.fsPath);
    this.snapshots.set(k, after);

    if (!this.current) {
      this.current = { id: ++this.taskSeq, start: Date.now(), end: Date.now(), files: new Map(), finished: false };
      this.tasks.unshift(this.current);
      if (this.tasks.length > MAX_TASKS) this.tasks.length = MAX_TASKS;
    }
    const task = this.current;
    task.end = Date.now();

    const d = before === null ? { lines: [], added: after.split(/\r?\n/).length, removed: 0 } : diffLines(before, after);
    const existing = task.files.get(k);
    const entry = existing || { uri, original: before, isNew: isNew && before === null };
    entry.lastBefore = before;
    entry.after = after;
    entry.time = Date.now();
    entry.lines = d.lines;
    entry.reviewed = false;
    // totals are relative to the state before the task started
    const total = entry.original === null
      ? { added: after.split(/\r?\n/).length, removed: 0 }
      : diffLines(entry.original, after);
    entry.added = total.added;
    entry.removed = total.removed;
    task.files.set(k, entry);

    // remember originals for every open manual checkpoint
    for (const cp of this.checkpoints) {
      if (!cp.originals.has(k)) cp.originals.set(k, { uri, content: before });
    }

    this._onFileChanged.fire({ uri, before, after, isNew: entry.isNew, lines: d.lines, task });
    this._onDidChange.fire();

    clearTimeout(this.quietTimer);
    const quiet = Math.max(2000, cfg('notifications').get('finishedAfterSeconds', 8) * 1000);
    this.quietTimer = setTimeout(() => this.finishCurrent(), quiet);
    return entry;
  }

  finishCurrent() {
    const task = this.current;
    if (!task) return;
    task.finished = true;
    this.current = null;
    this._onDidChange.fire();
    this._onTaskFinished.fire(task);
  }

  /** latest entry for a file across tasks */
  latestEntry(uri) {
    const k = fileKey(uri.fsPath);
    for (const t of this.tasks) {
      const e = t.files.get(k);
      if (e) return { task: t, entry: e };
    }
    return null;
  }

  pendingReview(uri) {
    const found = this.latestEntry(uri);
    if (!found || found.entry.reviewed) return [];
    return found.entry.lines || [];
  }

  markReviewed(uri) {
    const found = this.latestEntry(uri);
    if (found && !found.entry.reviewed) {
      found.entry.reviewed = true;
      this._onDidChange.fire();
      return true;
    }
    return false;
  }

  markAllReviewed() {
    for (const t of this.tasks) for (const e of t.files.values()) e.reviewed = true;
    this._onDidChange.fire();
  }

  createCheckpoint(label) {
    const cp = { id: ++this.cpSeq, label: label || `Checkpoint ${this.cpSeq}`, time: Date.now(), originals: new Map() };
    this.checkpoints.unshift(cp);
    if (this.checkpoints.length > 10) this.checkpoints.length = 10;
    this._onDidChange.fire();
    return cp;
  }

  removeCheckpoint(cp) {
    this.checkpoints = this.checkpoints.filter(c => c !== cp);
    this._onDidChange.fire();
  }

  /**
   * Original contents to restore for a task: [{uri, content|null}]
   * content null means the file was created by Claude and should be removed.
   */
  restorePlanForTask(task) {
    return [...task.files.values()].map(e => ({ uri: e.uri, content: e.original }));
  }

  restorePlanForCheckpoint(cp) {
    return [...cp.originals.values()];
  }

  removeTask(task) {
    this.tasks = this.tasks.filter(t => t !== task);
    if (this.current === task) this.current = null;
    this._onDidChange.fire();
  }

  clearHistory() {
    this.tasks = this.current ? [this.current] : [];
    this._onDidChange.fire();
  }

  dispose() {
    clearTimeout(this.quietTimer);
    this._onDidChange.dispose();
    this._onTaskFinished.dispose();
    this._onFileChanged.dispose();
  }
}

module.exports = { ChangeTracker };
