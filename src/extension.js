'use strict';
// Claude Studio by PM
// Author: Pawan Mall · https://www.pawanmall.in · https://www.webdevservices.in
// pawan.webmaster@gmail.com · https://github.com/MrPawanMall/claude-studio

const vscode = require('vscode');
const path = require('path');
const { NS, cfg } = require('./util');
const { ChangeTracker } = require('./core/tracker');
const { Watcher } = require('./core/watcher');
const { ChangesView } = require('./core/changes');
const { Quality } = require('./core/quality');
const { LiveReload } = require('./core/liveReload');
const { NotificationCenter } = require('./notify/center');
const sound = require('./notify/sound');
const { Uploader } = require('./upload/uploader');
const { Usage } = require('./usage/usage');
const { SkillsManager } = require('./skills/manager');
const about = require('./about/about');

let output;

function log(msg) {
  if (output) output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function activate(context) {
  output = vscode.window.createOutputChannel('Claude Studio');
  context.subscriptions.push(output);
  sound.init(context.extensionPath);

  // ---------- services ----------
  const notifications = new NotificationCenter(context);
  const notify = n => notifications.notify(n);
  const tracker = new ChangeTracker();
  const quality = new Quality(context, log);
  const watcher = new Watcher(context, tracker);
  watcher.log = log;
  const liveReload = new LiveReload(context, log);
  const uploader = new Uploader(context, { tracker, quality, notify, log });
  const changes = new ChangesView(context, tracker, { uploadFiles: (u, r) => uploader.uploadFiles(u, r), log });
  const usage = new Usage(context, { notify, log });
  const skills = new SkillsManager(context, { notify, log });
  context.subscriptions.push(tracker, notifications);

  // ---------- views ----------
  const changesTree = vscode.window.createTreeView(`${NS}.changes`, { treeDataProvider: changes, showCollapseAll: true });
  const uploadsTree = vscode.window.createTreeView(`${NS}.uploads`, { treeDataProvider: uploader });
  const usageTree = vscode.window.createTreeView(`${NS}.usage`, { treeDataProvider: usage });
  const skillsTree = vscode.window.createTreeView(`${NS}.skills`, { treeDataProvider: skills, showCollapseAll: true });
  const notifTree = vscode.window.createTreeView(`${NS}.notifications`, { treeDataProvider: notifications });
  notifications.attachView(notifTree);
  context.subscriptions.push(changesTree, uploadsTree, usageTree, skillsTree, notifTree);

  const updateContext = () => {
    vscode.commands.executeCommand('setContext', `${NS}.hasUploadConfig`, uploader.configs.length > 0);
    vscode.commands.executeCommand('setContext', `${NS}.hasChanges`, tracker.tasks.length > 0);
    const reviewCount = tracker.tasks.reduce((n, t) => n + [...t.files.values()].filter(e => !e.reviewed).length, 0);
    changesTree.badge = reviewCount ? { value: reviewCount, tooltip: `${reviewCount} file(s) to review` } : undefined;
    // lets the editor title / context menu show "Show What Claude Changed" only for changed files
    const paths = new Set();
    for (const t of tracker.tasks) for (const e of t.files.values()) { paths.add(e.uri.fsPath); paths.add(e.uri.path); }
    vscode.commands.executeCommand('setContext', `${NS}.changedFiles`, [...paths]);
  };
  context.subscriptions.push(tracker.onDidChange(updateContext), uploader.onDidChangeTreeData(updateContext));
  updateContext();

  // ---------- pipeline: what happens when Claude changes a file ----------
  context.subscriptions.push(tracker.onFileChanged(async ({ uri }) => {
    liveReload.fileChanged(uri);
    if (cfg('php').get('lintAfterClaudeEdit', true) && Quality.isPhp(uri)) {
      const res = await quality.lintPhp(uri);
      if (!res.ok) {
        notify({
          event: 'lintError',
          title: `PHP syntax error in ${path.basename(uri.fsPath)}`,
          message: `line ${res.line}: ${res.message}`,
          actions: [{ title: 'Show error', run: async () => {
            const ed = await vscode.window.showTextDocument(uri);
            const r = new vscode.Range(res.line - 1, 0, res.line - 1, 0);
            ed.selection = new vscode.Selection(r.start, r.start);
            ed.revealRange(r, vscode.TextEditorRevealType.InCenter);
          } }],
        });
      }
    }
    if (cfg('autoOpen').get('formatAfterEdit', false)) await quality.format(uri, tracker);
    uploader.onClaudeChange(uri);
  }));

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
    if (doc.uri.scheme === 'file') liveReload.fileChanged(doc.uri);
  }));

  context.subscriptions.push(tracker.onTaskFinished(task => {
    uploader.onTaskFinished(task);
    if (!cfg('notifications').get('taskFinished', true)) return;
    const files = [...task.files.values()];
    if (!files.length) return;
    const add = files.reduce((s, e) => s + e.added, 0);
    const rem = files.reduce((s, e) => s + e.removed, 0);
    const names = files.slice(0, 3).map(e => path.basename(e.uri.fsPath)).join(', ') + (files.length > 3 ? ` +${files.length - 3} more` : '');
    const actions = [
      { title: 'Review', run: () => vscode.commands.executeCommand(`${NS}.changes.focus`) },
    ];
    const mode = cfg('upload').get('claudeEdits', 'auto');
    if (uploader.configs.length && mode === 'ask' && uploader.hasConfigFor(files.map(e => e.uri))) {
      actions.push({ title: 'Upload', run: () => uploader.uploadFiles(files.map(e => e.uri), 'task') });
    }
    actions.push({ title: 'Undo task', run: () => changes.revertTask({ task }) });
    actions.push({ title: 'Copy summary', run: () => changes.copySummary({ task }) });
    notify({
      event: 'taskFinished',
      title: `Claude changed ${files.length} file${files.length === 1 ? '' : 's'}`,
      message: `${names} (+${add} −${rem})`,
      actions,
    });
  }));

  // ---------- commands ----------
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${NS}.${id}`, fn));

  // auto-open
  reg('autoOpen.toggle', async () => {
    const on = !cfg('autoOpen').get('enabled', true);
    await cfg('autoOpen').update('enabled', on, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`Claude Studio: auto-open ${on ? 'on' : 'off'}`, 2500);
  });
  reg('autoOpen.toggleProject', async () => {
    const current = cfg('autoOpen').inspect('enabled');
    const on = !(current.workspaceValue ?? cfg('autoOpen').get('enabled', true));
    await cfg('autoOpen').update('enabled', on, vscode.ConfigurationTarget.Workspace);
    vscode.window.setStatusBarMessage(`Claude Studio: auto-open ${on ? 'on' : 'off'} for this project`, 2500);
  });
  reg('autoOpen.pause', async minutes => {
    let m = Number(minutes);
    if (!m) {
      const pick = await vscode.window.showQuickPick(['10', '30', '60'].map(x => ({ label: `${x} minutes`, m: Number(x) })), { placeHolder: 'Pause auto-open for…' });
      if (!pick) return;
      m = pick.m;
    }
    watcher.pause(m);
  });
  reg('autoOpen.resume', () => watcher.pause(0));
  reg('autoOpen.closeOpenedTabs', async () => {
    const n = await watcher.closeOurTabs();
    vscode.window.setStatusBarMessage(`Claude Studio: closed ${n} tab(s)`, 2500);
  });
  reg('autoOpen.menu', async () => {
    const enabled = cfg('autoOpen').get('enabled', true);
    const items = [
      { label: enabled ? '$(eye-closed) Turn auto-open off' : '$(eye) Turn auto-open on', run: 'autoOpen.toggle' },
      watcher.paused ? { label: '$(debug-continue) Resume auto-open', run: 'autoOpen.resume' }
        : { label: '$(debug-pause) Pause for 10 / 30 / 60 minutes…', run: 'autoOpen.pause' },
      { label: '$(close-all) Close tabs Claude Studio opened', run: 'autoOpen.closeOpenedTabs' },
      { label: '$(bookmark) Create checkpoint', run: 'changes.checkpoint' },
      { label: '$(discard) Undo last Claude task', run: 'changes.revertTask' },
      { label: '$(bell) Notifications: Do Not Disturb on/off', run: 'notifications.toggleDnd' },
      { label: '$(unmute) Change notification sounds…', run: 'notifications.chooseSound' },
      { label: '$(dashboard) Usage dashboard', run: 'usage.dashboard' },
      { label: '$(sparkle) Browse skills…', run: 'skills.browse' },
      { label: '$(gear) Settings', run: 'openSettings' },
      { label: '$(info) About Claude Studio by PM', run: 'about' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Claude Studio by PM' });
    if (pick) vscode.commands.executeCommand(`${NS}.${pick.run}`);
  });
  reg('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`));
  reg('showLog', () => output.show(true));

  // changes
  reg('changes.diff', arg => changes.diff(arg));
  reg('changes.diffTask', arg => changes.diff(arg, true));
  reg('changes.undo', arg => changes.undoFile(arg));
  reg('changes.revertTask', arg => changes.revertTask(arg));
  reg('changes.checkpoint', () => changes.createCheckpoint());
  reg('changes.revertCheckpoint', arg => changes.revertCheckpoint(arg));
  reg('changes.deleteCheckpoint', arg => arg && arg.cp && tracker.removeCheckpoint(arg.cp));
  reg('changes.copySummary', arg => changes.copySummary(arg));
  reg('changes.markReviewed', arg => changes.markReviewed(arg));
  reg('changes.markAllReviewed', () => tracker.markAllReviewed());
  reg('changes.clear', () => tracker.clearHistory());
  reg('changes.uploadTask', arg => uploader.uploadFiles(changes.taskFiles(arg), 'task'));
  reg('changes.openFile', arg => arg && arg.entry && vscode.window.showTextDocument(arg.entry.uri));

  // upload
  reg('upload.file', (arg, all) => uploader.uploadCommand(arg, all));
  reg('upload.download', arg => uploader.downloadCommand(arg));
  reg('upload.compare', arg => uploader.compareCommand(arg));
  reg('upload.switchProfile', arg => uploader.switchProfile(arg));
  reg('upload.createConfig', () => uploader.createConfig());
  reg('upload.openConfig', () => uploader.openConfig());
  reg('upload.movePasswords', () => uploader.movePasswords());
  reg('upload.forgetPassword', () => uploader.forgetPassword());
  reg('upload.forgetHostKey', () => uploader.forgetHostKey());
  reg('upload.retry', arg => uploader.retry(arg));
  reg('upload.retryFailed', () => uploader.retryFailed());
  reg('upload.clear', () => uploader.clearHistory());
  reg('upload.focus', () => vscode.commands.executeCommand(`${NS}.uploads.focus`));

  // usage
  reg('usage.dashboard', () => usage.openDashboard(context.extensionUri));
  reg('usage.refresh', () => usage.update(true));
  reg('usage.enablePlanLimits', () => usage.enablePlanLimits());

  // skills
  reg('skills.browse', arg => skills.browse(arg));
  reg('skills.addSource', () => skills.addSource());
  reg('skills.removeSource', arg => skills.removeSource(arg));
  reg('skills.create', () => skills.create());
  reg('skills.toggle', arg => skills.toggle(arg));
  reg('skills.remove', arg => skills.remove(arg));
  reg('skills.reveal', arg => skills.reveal(arg));
  reg('skills.checkUpdates', () => skills.checkUpdates());
  reg('skills.setGithubToken', () => skills.setGithubToken());
  reg('skills.installZip', () => skills.installFromZipFile());
  reg('skills.refresh', () => { skills.cache.clear(); skills.refresh(); });

  // notifications & sound
  reg('notifications.runAction', item => notifications.runAction(item));
  reg('notifications.clear', () => notifications.clear());
  reg('notifications.markAllRead', () => notifications.markAllRead());
  reg('notifications.chooseSound', () => notifications.chooseSound());
  reg('notifications.testSound', () => notifications.testSound());
  reg('notifications.resetSounds', () => notifications.resetSounds());
  reg('notifications.toggleDnd', () => notifications.toggleDnd());

  // live reload, about
  reg('liveReload.copySnippet', () => liveReload.copySnippet());
  reg('about', () => about.open(context));

  // ---------- first run ----------
  const version = context.extension.packageJSON.version;
  if (context.globalState.get('cs.welcomedVersion') !== version) {
    context.globalState.update('cs.welcomedVersion', version);
    vscode.window.showInformationMessage(
      `Claude Studio by PM ${version} is ready. Files Claude edits now open automatically.`, 'Open panel', 'About'
    ).then(p => {
      if (p === 'Open panel') vscode.commands.executeCommand(`${NS}.changes.focus`);
      if (p === 'About') about.open(context);
    });
  }

  log(`Claude Studio by PM ${version} started.`);
}

function deactivate() {
  sound.stop();
}

module.exports = { activate, deactivate };
