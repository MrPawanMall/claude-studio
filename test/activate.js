'use strict';
// Smoke test: runs activate() against a permissive fake editor API and checks
// that every contributed command is registered and every view is created.
const Module = require('module');
const path = require('path');
const assert = require('assert');
const base = require('./vscode-stub');

const registered = new Map();
const views = new Set();
const any = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : any()),
  apply: () => any(),
  construct: () => any(),
});
const disposable = { dispose() {} };
const event = () => disposable;

const vscode = new Proxy({
  ...base,
  commands: {
    registerCommand: (id, fn) => { registered.set(id, fn); return disposable; },
    executeCommand: async () => undefined,
  },
  window: {
    ...base.window,
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createTreeView: (id, opts) => { views.add(id); assert.ok(opts.treeDataProvider.getChildren); return { onDidChangeVisibility: event, dispose() {}, visible: false }; },
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createTextEditorDecorationType: () => disposable,
    onDidChangeVisibleTextEditors: event,
    onDidChangeActiveTextEditor: event,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    setStatusBarMessage: () => disposable,
  },
  workspace: {
    ...base.workspace,
    createFileSystemWatcher: () => ({ onDidChange: event, onDidCreate: event, onDidDelete: event, dispose() {} }),
    onDidOpenTextDocument: event, onWillSaveTextDocument: event, onDidSaveTextDocument: event,
    onDidChangeTextDocument: event, onDidCloseTextDocument: event, onDidChangeWorkspaceFolders: event,
    onDidGrantWorkspaceTrust: event, onDidChangeConfiguration: event,
    registerTextDocumentContentProvider: () => disposable,
  },
  languages: { createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }) },
  RelativePattern: class {},
}, { get: (t, k) => (k in t ? t[k] : any()) });

const orig = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscode : orig(req, ...rest));

const pkg = require('../package.json');
const memento = () => { const m = {}; return { get: (k, d) => (k in m ? m[k] : d), update: async (k, v) => { m[k] = v; } }; };
const context = {
  subscriptions: [],
  extensionPath: path.join(__dirname, '..'),
  extensionUri: base.Uri.file(path.join(__dirname, '..')),
  globalState: memento(),
  workspaceState: memento(),
  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
  extension: { id: 'pawanmall.claude-studio-by-pm', packageJSON: pkg },
};

require(process.argv[2] === 'dist' ? '../dist/extension' : '../src/extension').activate(context);

const declared = pkg.contributes.commands.map(c => c.command);
const missing = declared.filter(c => !registered.has(c));
assert.deepStrictEqual(missing, [], 'commands declared but not registered: ' + missing.join(', '));
const viewIds = pkg.contributes.views.claudeStudio.map(v => v.id);
assert.deepStrictEqual(viewIds.filter(v => !views.has(v)), [], 'views not created');
for (const m of Object.values(pkg.contributes.menus).flat()) {
  assert.ok(declared.includes(m.command), `menu uses undeclared command ${m.command}`);
}
console.log(`activate() OK — ${registered.size} commands registered, ${views.size} views, ${context.subscriptions.length} disposables`);
setTimeout(() => process.exit(0), 2500);
