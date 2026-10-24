'use strict';
// Claude Studio's own notification system: toasts with action buttons,
// a history panel with an unread badge, Do Not Disturb, and per-event sounds.

const path = require('path');
const { vs, cfg, NS, timeAgo, clock } = require('../util');
const sound = require('./sound');

const EVENTS = {
  taskFinished:   { label: 'Claude finished a task',   level: 'success', defaultSound: 'chime' },
  uploadSuccess:  { label: 'Upload finished',           level: 'success', defaultSound: 'none' },
  uploadFailed:   { label: 'Upload failed',             level: 'error',   defaultSound: 'error' },
  lintError:      { label: 'PHP syntax error found',    level: 'error',   defaultSound: 'error' },
  budgetAlert:    { label: 'Budget alert',              level: 'warning', defaultSound: 'alert' },
  rateLimitAlert: { label: 'Usage limit alert',         level: 'warning', defaultSound: 'alert' },
  skillInstalled: { label: 'Skill installed',           level: 'success', defaultSound: 'pop' },
  general:        { label: 'General',                   level: 'info',    defaultSound: 'none' },
};

const LEVEL_ICON = { info: 'info', success: 'pass', warning: 'warning', error: 'error' };
const LEVEL_COLOR = {
  info: 'notificationsInfoIcon.foreground',
  success: 'testing.iconPassed',
  warning: 'notificationsWarningIcon.foreground',
  error: 'notificationsErrorIcon.foreground',
};
const MAX_HISTORY = 100;

class NotificationCenter {
  constructor(context) {
    this.context = context;
    this.items = (context.workspaceState.get('cs.notifications') || []).map(i => ({ ...i, actions: [] }));
    this.seq = this.items.reduce((m, i) => Math.max(m, i.id), 0);
    this._onDidChange = new (vs().EventEmitter)();
    this.onDidChangeTreeData = this._onDidChange.event;
    this.view = null;
  }

  attachView(view) {
    this.view = view;
    this.updateBadge();
    view.onDidChangeVisibility(() => { if (view.visible) this.markAllRead(); });
  }

  /**
   * @param {object} n
   * @param {keyof EVENTS} n.event
   * @param {string} n.title
   * @param {string} [n.message]
   * @param {'info'|'success'|'warning'|'error'} [n.level]
   * @param {{title:string, run:Function}[]} [n.actions]
   * @param {boolean} [n.silent]  no toast
   */
  async notify(n) {
    const vscode = vs();
    const ev = EVENTS[n.event] || EVENTS.general;
    const level = n.level || ev.level;
    const item = {
      id: ++this.seq, time: Date.now(), event: n.event || 'general', level,
      title: n.title, message: n.message || '', read: false, actions: n.actions || [],
    };
    this.items.unshift(item);
    if (this.items.length > MAX_HISTORY) this.items.length = MAX_HISTORY;
    this.persist();
    this._onDidChange.fire();
    this.updateBadge();

    const dnd = cfg('notifications').get('doNotDisturb', false);
    if (!dnd) this.playFor(item.event);
    if (dnd || n.silent || !this.shouldToast(level)) return undefined;

    const text = item.message ? `${item.title} — ${item.message}` : item.title;
    const titles = item.actions.map(a => a.title);
    const show = level === 'error' ? vscode.window.showErrorMessage
      : level === 'warning' ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;
    const picked = await show(`Claude Studio: ${text}`, ...titles);
    const action = item.actions.find(a => a.title === picked);
    if (action) { item.read = true; this.updateBadge(); return action.run(); }
    return undefined;
  }

  shouldToast(level) {
    const mode = cfg('notifications').get('toasts', 'all');
    if (mode === 'none') return false;
    if (mode === 'errors') return level === 'error';
    if (mode === 'important') return level === 'error' || level === 'warning' || level === 'success';
    return true;
  }

  soundFor(event) {
    const ev = EVENTS[event] || EVENTS.general;
    const configured = cfg('sound').get(event);
    return configured === undefined || configured === '' ? ev.defaultSound : configured;
  }

  playFor(event) {
    const s = cfg('sound');
    if (!s.get('enabled', true)) return;
    sound.play(this.soundFor(event), s.get('volume', 70));
  }

  persist() {
    const plain = this.items.map(({ actions, ...rest }) => rest);
    this.context.workspaceState.update('cs.notifications', plain);
  }

  updateBadge() {
    if (!this.view) return;
    const unread = this.items.filter(i => !i.read).length;
    this.view.badge = unread ? { value: unread, tooltip: `${unread} unread notification${unread > 1 ? 's' : ''}` } : undefined;
  }

  markAllRead() {
    this.items.forEach(i => { i.read = true; });
    this.persist();
    this.updateBadge();
    this._onDidChange.fire();
  }

  clear() {
    this.items = [];
    this.persist();
    this.updateBadge();
    this._onDidChange.fire();
  }

  // ---- TreeDataProvider ----
  getChildren() {
    return this.items;
  }

  getTreeItem(item) {
    const vscode = vs();
    const t = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    t.description = `${item.message ? item.message + ' · ' : ''}${timeAgo(item.time)}`;
    t.tooltip = new vscode.MarkdownString(`**${item.title}**\n\n${item.message || ''}\n\n_${new Date(item.time).toLocaleString()}_`);
    t.iconPath = new vscode.ThemeIcon(LEVEL_ICON[item.level] || 'info', new vscode.ThemeColor(LEVEL_COLOR[item.level] || LEVEL_COLOR.info));
    t.contextValue = 'notification';
    if (item.actions && item.actions.length) {
      t.command = { command: `${NS}.notifications.runAction`, title: 'Open', arguments: [item] };
    }
    return t;
  }

  async runAction(item) {
    const vscode = vs();
    if (!item || !item.actions || !item.actions.length) return;
    if (item.actions.length === 1) return item.actions[0].run();
    const pick = await vscode.window.showQuickPick(item.actions.map(a => a.title), { placeHolder: item.title });
    const a = item.actions.find(x => x.title === pick);
    return a && a.run();
  }

  // ---- sound settings UI ----
  async chooseSound() {
    const vscode = vs();
    const evPick = await vscode.window.showQuickPick(
      Object.entries(EVENTS).map(([key, ev]) => ({ label: ev.label, description: describeSound(this.soundFor(key)), key })),
      { placeHolder: 'Choose the event whose sound you want to change' }
    );
    if (!evPick) return;

    const options = [
      ...sound.BUILTIN.map(b => ({ label: `$(unmute) ${b}`, value: b, description: b === EVENTS[evPick.key].defaultSound ? 'default' : '' })),
      { label: '$(folder-opened) Custom sound file…', value: '__custom' },
      { label: '$(mute) No sound', value: 'none' },
      { label: '$(discard) Reset to default', value: '' },
    ];
    const qp = vscode.window.createQuickPick();
    qp.items = options;
    qp.placeholder = `Sound for "${evPick.label}" (moving through the list plays a preview)`;
    qp.onDidChangeActive(a => { if (a[0] && sound.BUILTIN.includes(a[0].value)) sound.play(a[0].value, cfg('sound').get('volume', 70)); });
    const chosen = await new Promise(resolve => {
      qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.hide(); });
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    qp.dispose();
    if (!chosen) return;

    let value = chosen.value;
    if (value === '__custom') {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false, openLabel: 'Use this sound',
        filters: { 'Audio': [...sound.ALLOWED_EXT].map(e => e.slice(1)) },
      });
      if (!files || !files[0]) return;
      value = files[0].fsPath;
      if (!sound.resolve(value)) {
        vscode.window.showErrorMessage('That file can\'t be used. Pick a WAV, MP3, OGG, M4A, AAC, WMA, AIFF or FLAC file under 20 MB.');
        return;
      }
    }
    await cfg('sound').update(evPick.key, value || undefined, vscode.ConfigurationTarget.Global);
    if (value && value !== 'none') sound.play(value, cfg('sound').get('volume', 70));
    vscode.window.setStatusBarMessage(`Claude Studio: sound for "${evPick.label}" set to ${describeSound(value || EVENTS[evPick.key].defaultSound)}`, 4000);
  }

  async testSound() {
    const vscode = vs();
    const pick = await vscode.window.showQuickPick(
      Object.entries(EVENTS).map(([key, ev]) => ({ label: ev.label, description: describeSound(this.soundFor(key)), key })),
      { placeHolder: 'Play the sound for…' }
    );
    if (!pick) return;
    const ok = await sound.play(this.soundFor(pick.key), cfg('sound').get('volume', 70));
    if (!ok) vscode.window.showWarningMessage('No sound is set for this event, or the sound file can\'t be found.');
  }

  async resetSounds() {
    const vscode = vs();
    for (const key of Object.keys(EVENTS)) {
      await cfg('sound').update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    vscode.window.showInformationMessage('Claude Studio: all sounds reset to their defaults.');
  }

  async toggleDnd() {
    const vscode = vs();
    const on = !cfg('notifications').get('doNotDisturb', false);
    await cfg('notifications').update('doNotDisturb', on, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`Claude Studio: Do Not Disturb ${on ? 'on' : 'off'}`, 3000);
  }

  dispose() {
    this._onDidChange.dispose();
  }
}

function describeSound(v) {
  if (!v || v === 'none') return 'no sound';
  if (sound.BUILTIN.includes(v)) return v;
  return `custom: ${path.basename(v)}`;
}

module.exports = { NotificationCenter, EVENTS, clock };
