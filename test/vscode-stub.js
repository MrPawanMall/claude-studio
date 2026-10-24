'use strict';
// Minimal stand-in for the `vscode` module so logic can be tested with plain Node.

class EventEmitter {
  constructor() { this.listeners = []; this.event = fn => { this.listeners.push(fn); return { dispose: () => {} }; }; }
  fire(v) { this.listeners.forEach(l => l(v)); }
  dispose() { this.listeners = []; }
}
class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath.replace(/\\/g, '/'); this.scheme = 'file'; }
  static file(p) { return new Uri(p); }
  static joinPath(u, ...parts) { return new Uri(require('path').join(u.fsPath, ...parts)); }
  static parse(s) { return new Uri(s); }
  static from(o) { const u = new Uri(o.path); u.scheme = o.scheme; u.query = o.query; return u; }
  toString() { return 'file://' + this.path; }
}
const config = {};
const noop = () => ({ dispose() {} });
module.exports = {
  EventEmitter, Uri,
  ThemeColor: class { constructor(id) { this.id = id; } },
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  MarkdownString: class { constructor(v) { this.value = v; } },
  Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
  Diagnostic: class { constructor(r, m, s) { this.range = r; this.message = m; this.severity = s; } },
  DiagnosticSeverity: { Error: 0 },
  StatusBarAlignment: { Right: 2 },
  OverviewRulerLane: { Left: 1 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  FileType: { File: 1, Directory: 2 },
  workspace: {
    isTrusted: true,
    workspaceFolders: [],
    textDocuments: [],
    getConfiguration: section => ({
      get: (k, d) => (config[`${section}.${k}`] !== undefined ? config[`${section}.${k}`] : d),
      update: async (k, v) => { config[`${section}.${k}`] = v; },
      inspect: () => ({}),
    }),
    getWorkspaceFolder: () => undefined,
    asRelativePath: u => (u.fsPath || String(u)),
    onDidChangeConfiguration: noop,
  },
  window: { visibleTextEditors: [], tabGroups: { all: [] } },
  _config: config,
};
